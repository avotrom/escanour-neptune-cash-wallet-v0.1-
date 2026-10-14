// Service worker: wallet state, sync, and the send pipeline.
//
// Design rules
// - Networking and storage happen here in JS; all Neptune logic runs in the
//   light wasm module. Proving AND broadcasting run in the offscreen document:
//   Chrome stops an idle service worker after about 30 seconds, which is
//   shorter than building and uploading a large transaction.
// - Every piece of state lives in IndexedDB, so this worker can be stopped at
//   any time and resume on the next event or alarm (resumeSends).
// - Wallet data is kept per network (snapshots, history, sends, status), so
//   one seed can be used on Mainnet and Testnet side by side.
// - The wallet syncs only while unlocked: scanning needs the keys.

import initLight, * as light from './pkg/light/light_wasm.js';
import * as db from './lib/db.js';
import * as vault from './lib/vault.js';
import * as rpc from './lib/rpc.js';
import { guardedFetch, readJSON, torHosts, pacScript, isLocalHost } from './lib/network.js';
import * as settingsStore from './lib/settings.js';
import * as authenticator from './lib/authenticator.js';
import * as backup from './lib/backup.js';
import { portfolios, activityFeed, scanProgress, paymentTimeline, assistantAnswer, trustedMessage } from './lib/dashboard.js';
import { t, setLanguage } from './lib/i18n.js';

const SNAPSHOTS_KEPT = 30;
const MAX_BLOCKS_PER_RUN = 2000; // one chunk; the next follows right away (scheduleFollowUp)
const PREFETCH = 3; // most block batches downloaded in parallel during a scan
const SAVE_EVERY = 1000; // blocks between snapshot saves during a long scan
const SAVE_EVERY_MS = 15_000; // ...or this much time, so a restart loses little
// Chrome may stop an extension worker whose fetch waits about 30 s, so a
// block request gives up first and is retried smaller.
const BLOCKS_TIMEOUT_MS = 25_000;
const SLOW_MS = 12_000; // a response this slow means: ask for less at once
const MAX_FETCH_FAILURES = 8; // in a row, before the run stops with an error
const FRESH_BLOCK_WINDOW_MS = 60_000;
const MAX_BLOCK_WAIT_MS = 20 * 60_000;
const MAX_SEND_ATTEMPTS = 3;
const STALE_RESERVATION_BLOCKS = 30;
const BLOCK_TIME_MS = 588_000; // Neptune's target block interval
const STALLED_MS = 3 * 60_000; // a step with no progress for this long was interrupted

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- wasm ----

let wasmReady = null;
function wasm() {
  wasmReady ??= initLight({ module_or_path: chrome.runtime.getURL('pkg/light/light_wasm_bg.wasm') });
  return wasmReady;
}

let walletEpoch = 0;
let walletCache = null; // { id, wallet }

async function openWallet() {
  const epoch = walletEpoch;
  const key = await vault.sessionKey();
  if (!key) return null;
  const s = await settingsStore.load();
  const raw = await vault.exportRawKey(key);
  const id = `${s.network}|${Array.from(raw.slice(0, 8)).join(',')}`;
  if (walletCache?.id === id) return { key, wallet: walletCache.wallet, s };
  await wasm();
  const phrase = await vault.phrase(key);
  const stillUnlocked = await vault.sessionKey();
  if (epoch !== walletEpoch || !stillUnlocked) return null;
  walletCache = { id, wallet: new light.LightWallet(phrase, s.network) };
  return { key, wallet: walletCache.wallet, s };
}

function dropWallet() {
  walletEpoch += 1;
  walletCache = null;
  snapCache = null;
}

// ----------------------------------------------------- lifetime & locking --

// An extension service worker stays alive while it calls extension APIs.
// Long tasks (sync, building a transaction) ping one every 20 seconds.
let keepers = 0;
let keepTimer = null;
async function keepAlive(fn) {
  keepers += 1;
  keepTimer ??= setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  try {
    return await fn();
  } finally {
    keepers -= 1;
    if (keepers === 0) {
      clearInterval(keepTimer);
      keepTimer = null;
    }
  }
}

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// A user action that needs the lock: background work (sync, archive,
// watch-only catch-up, spend index) checks `wanted` between batches and
// steps aside, so a tap never waits for a long run.
let wanted = 0;
function exclusiveNow(fn) {
  wanted += 1;
  rpc.cancelBackground();
  let counted = true;
  const release = () => {
    if (counted) {
      counted = false;
      wanted -= 1;
    }
  };
  return exclusive(async () => {
    release();
    return fn();
  }).finally(release);
}
let pauseRequested = false;
const yieldNow = () => wanted > 0 || pauseRequested;

// Jobs the popup can cancel while they wait, and their progress.
const cancelledJobs = new Set();
function cancelled(jobId) {
  if (jobId && cancelledJobs.has(jobId)) {
    cancelledJobs.delete(jobId);
    throw new Error('CANCELLED');
  }
}
function jobProgress(jobId, patch) {
  if (jobId) chrome.runtime.sendMessage({ target: 'popup', type: 'job', jobId, ...patch }).catch(() => {});
}

// ------------------------------------------------------------ migration ----

// Versions before 0.3 stored one network's data without a network prefix.
let migrated = null;
function migrateStorage() {
  migrated ??= (async () => {
    const s = await settingsStore.load();
    await settingsStore.save({}); // rewrites old server fields into `servers`
    for (const k of await db.keys(db.STORES.snapshots)) {
      if (typeof k === 'number' || /^\d+$/.test(String(k))) {
        const box = await db.get(db.STORES.snapshots, k);
        await db.put(db.STORES.snapshots, snapKey(s.network, Number(k)), box);
        await db.del(db.STORES.snapshots, k);
      }
    }
    const oldActivity = await db.get(db.STORES.kv, 'activity');
    if (oldActivity) {
      await db.put(db.STORES.kv, `activity:${s.network}`, oldActivity);
      await db.del(db.STORES.kv, 'activity');
    }
    for (const id of await db.keys(db.STORES.sends)) {
      const rec = await db.get(db.STORES.sends, id);
      if (rec && !rec.network) {
        rec.network = s.network;
        await db.put(db.STORES.sends, id, rec);
      }
    }
  })().catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}

// --------------------------------------------------------------- status ----

async function currentNetwork() {
  return (await settingsStore.load()).network;
}

async function status(network) {
  const n = network || (await currentNetwork());
  const r = await chrome.storage.session.get(`status:${n}`);
  return r[`status:${n}`] || {};
}

let statusWrites = Promise.resolve();
function setStatus(patch, network) {
  const run=statusWrites.then(async()=>{
  const n = network || (await currentNetwork());
  const previous = await status(n);
  const next = { ...previous, ...patch };
  next.scan = scanProgress(previous, next);
  next.scanSample = next.scan.scanSample;
  await chrome.storage.session.set({ [`status:${n}`]: next });
  chrome.runtime.sendMessage({ target: 'popup', type: 'status', network: n, status: next }).catch(() => {});
  return next;

  });
  statusWrites=run.catch(()=>{});return run;
}

function notify(type, extra = {}) {
  chrome.runtime.sendMessage({ target: 'popup', type, ...extra }).catch(() => {});
}

// -------------------------------------------------------- notifications ----

const SCALE = 12n;
function toUnits(a) {
  const str = String(a ?? '0').trim();
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace(/^-/, '').split('.');
  const v = BigInt(i || '0') * 10n ** SCALE + BigInt((f + '0'.repeat(12)).slice(0, 12) || '0');
  return neg ? -v : v;
}
function fromUnits(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const f = (a % 10n ** SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 10n ** SCALE}${f ? `.${f}` : ''}`;
}
const amt = (a) => fromUnits(toUnits(a));
const plus = (a, b) => fromUnits(toUnits(a) + toUnits(b));

/** Show a Chrome notification when the user has them on. Text only: no address. */
async function pushNotice(kind, vars = {}) {
  try {
    const s = await settingsStore.load();
    if (s.notifications === false || !chrome.notifications) return;
    setLanguage(s.language);
    const net = s.network === 'main' ? '' : ` (${s.network === 'testnet' ? t('net.testnet') : t('net.mock')})`;
    const details = s.notificationDetails === true;
    await chrome.notifications.create(`esc-${kind}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${t(`nt.${kind}Title`, vars)}${net}`,
      message: details ? t(`nt.${kind}`, vars) : 'Wallet activity updated. Open Escanour to view the details.',
      priority: 1,
    });
  } catch {
    /* notifications are a convenience */
  }
}

chrome.notifications?.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  // The wallet's place is the side panel; a full tab if Chrome refuses.
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') });
  }
});

// ------------------------------------------------------------ snapshots ----

const snapKey = (network, height) => `${network}:${String(height).padStart(12, '0')}`;

async function snapHeights(network) {
  const prefix = `${network}:`;
  return (await db.keys(db.STORES.snapshots))
    .map(String)
    .filter((k) => k.startsWith(prefix))
    .map((k) => Number(k.slice(prefix.length)))
    .sort((a, b) => b - a);
}

// The newest decrypted state stays in memory while the wallet is unlocked, so
// opening the popup does not decrypt the whole wallet again for every number.
let snapCache = null; // { key, network, height, state }

async function latestSnapshot(key, network) {
  const n = network || (await currentNetwork());
  const heights = await snapHeights(n);
  if (!heights.length) return null;
  if (snapCache && snapCache.key === key && snapCache.network === n && snapCache.height === heights[0]) {
    return { height: snapCache.height, state: snapCache.state };
  }
  const box = await db.get(db.STORES.snapshots, snapKey(n, heights[0]));
  const state = await vault.decrypt(key, box);
  snapCache = { key, network: n, height: heights[0], state };
  return { height: heights[0], state };
}

async function saveSnapshot(key, height, state, network) {
  const n = network || (await currentNetwork());
  await db.put(db.STORES.snapshots, snapKey(n, height), await vault.encrypt(key, state));
  snapCache = { key, network: n, height, state };
  const heights = await snapHeights(n);
  await Promise.all(heights.slice(SNAPSHOTS_KEPT).map((h) => db.del(db.STORES.snapshots, snapKey(n, h))));
}

async function dropSnapshots(network) {
  snapCache = null;
  await db.delPrefix(db.STORES.snapshots, `${network}:`);
}

// ------------------------------------------------------------- history -----

async function readActivity(key, network) {
  const n = network || (await currentNetwork());
  const box = await db.get(db.STORES.kv, `activity:${n}`);
  return box ? JSON.parse(new TextDecoder().decode(await vault.decrypt(key, box))) : [];
}

async function writeActivity(key, list, network) {
  const n = network || (await currentNetwork());
  const data = new TextEncoder().encode(JSON.stringify(list.slice(0, 500)));
  await db.put(db.STORES.kv, `activity:${n}`, await vault.encrypt(key, data));
}

/**
 * Turn a sync batch into history:
 * - money received on a receiving address -> "received"
 * - change coming back to us -> hidden (it is part of our own send)
 * - our coin spent by our own transaction -> marks that "sent" entry confirmed
 * - our coin spent by a transaction we did not make here -> "spent elsewhere"
 * Entries have stable ids, so a rescan never adds duplicates.
 */
async function recordBlockEvents(key, events) {
  if (!events.length) return false;
  const list = await readActivity(key);
  const ids = new Set(list.map((e) => e.id));
  const fresh = [];
  for (const ev of events) {
    for (const u of ev.received) {
      if (u.is_change) continue;
      const id = `r:${ev.height}:${u.aocl_index}`;
      if (ids.has(id)) continue;
      ids.add(id);
      fresh.push({
        kind: 'received', amount: u.amount, height: ev.height, at: ev.timestamp_ms,
        addressKind: u.address_kind, status: 'confirmed', id,
      });
    }
    const seenTx = new Set();
    for (const u of ev.spent) {
      if (u.tx_id) {
        if (seenTx.has(u.tx_id)) continue;
        seenTx.add(u.tx_id);
        const sent = list.find((e) => e.kind === 'sent' && e.txId === u.tx_id);
        if (sent) Object.assign(sent, { status: 'confirmed', height: ev.height, confirmedAt: ev.timestamp_ms });
      } else {
        const id = `s:${ev.height}:${u.aocl_index}`;
        if (ids.has(id)) continue;
        ids.add(id);
        fresh.push({ kind: 'spent-elsewhere', amount: u.amount, height: ev.height, at: ev.timestamp_ms, status: 'confirmed', id });
      }
    }
  }
  fresh.reverse(); // newest first
  await writeActivity(key, [...fresh, ...list]);

  const recent = (e) => Date.now() - (e.at || 0) < 3 * 3600_000;
  const received = fresh.filter((e) => e.kind === 'received' && recent(e));
  if (received.length === 1) {
    const k = received[0].addressKind === 'ec-hybrid' ? t('kind.ecHybridShort') : t('kind.generationShort');
    pushNotice('received', { n: amt(received[0].amount), k });
  } else if (received.length > 1) {
    pushNotice('receivedMany', { c: received.length, n: amt(received.reduce((a, e) => plus(a, e.amount), '0')) });
  }
  for (const ev of events) {
    for (const u of ev.spent) {
      const sent = u.tx_id && list.find((e) => e.kind === 'sent' && e.txId === u.tx_id && e.confirmedAt === ev.timestamp_ms);
      if (sent && Date.now() - ev.timestamp_ms < 3 * 3600_000 && !sent.notified) {
        sent.notified = true;
        pushNotice('confirmed', { n: amt(plus(sent.amount, sent.fee || '0')), c: amt(sent.change || '0') });
      }
    }
  }
  return true;
}

/** Payments still pending long after broadcast: their coins were released. */
async function expireOldSends(key, height) {
  const list = await readActivity(key);
  let changed = false;
  for (const e of list) {
    if (e.kind === 'sent' && e.status === 'pending' && e.atHeight != null && height - e.atHeight >= STALE_RESERVATION_BLOCKS) {
      e.status = 'expired';
      changed = true;
    }
  }
  if (changed) await writeActivity(key, list);
  return changed;
}

// ----------------------------------------------------------------- sync ----

// The tip check runs every minute, so it is plain JSON: no wasm to load.
async function fetchHeight(server) {
  if (!server) throw new Error('NEED_SERVER');
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id(), method: 'chain_height', params: [] });
  const text = await rpc.post(server, body, { timeoutMs: 20_000 });
  const h = JSON.parse(text)?.result?.height;
  const n = typeof h === 'string' ? Number(h) : h;
  if (Number.isSafeInteger(n) && n >= 0) return n;
  await wasm(); // an encoding this code does not know: let the node's own types decide
  return light.parseHeight(text);
}

/**
 * First state: right after `height` (the tip for a new wallet). Height 0 is
 * the genesis block, rebuilt locally (servers never send it): a scan from
 * there also covers block 1 and finds premine allocations.
 */
async function initialState(wallet, server, height) {
  if (height <= 0) return wallet.genesisState();
  const body = await rpc.post(server, light.getBlocksRequest(rpc.id(), height, height));
  return wallet.stateFromBlock(body);
}

/** The block height at a date: estimate from the block time, then correct with real timestamps. */
async function heightAtDate(server, dateMs) {
  await wasm();
  const tip = await fetchHeight(server);
  let h = tip - Math.round((Date.now() - dateMs) / BLOCK_TIME_MS);
  for (let i = 0; i < 5; i++) {
    h = Math.min(tip, Math.max(1, h));
    const info = light.blockInfo(await rpc.post(server, light.getBlocksRequest(rpc.id(), h, h)));
    const diff = info.timestamp_ms - dateMs;
    if (Math.abs(diff) < 6 * 3600_000) break;
    h -= Math.round(diff / BLOCK_TIME_MS);
  }
  // Start a little earlier: a day of margin.
  return Math.max(1, Math.min(tip, h) - 150);
}

// --------------------------------------------------------------------- tor ---
// "Connect through Tor": the wallet's servers, the price service and the Tor
// check go through the Tor SOCKS port on this computer (Tor Browser: 9150,
// the tor service: 9050), via a proxy script that names only those hosts.
// The rest of the browser is untouched. It fails closed: the script offers no
// direct fallback, so if Tor is down requests fail instead of leaking the IP.

const TOR_CHECK_URL = 'https://check.torproject.org/api/ip';
const TOR_RECHECK_MS = 10 * 60_000;

async function torState() {
  const r = await chrome.storage.session.get('tor');
  return r.tor || { state: 'off' };
}

async function setTorState(next) {
  await chrome.storage.session.set({ tor: next });
  notify('tor', { tor: next });
  return next;
}

/** Set or clear the proxy to match the settings, then check Tor. */
async function applyTor({ check = true } = {}) {
  const s = await settingsStore.load();
  if (!chrome.proxy?.settings) {
    if (s.tor) return setTorState({ state: 'error', error: 'NO_PERMISSION', at: Date.now() });
    return setTorState({ state: 'off' });
  }
  if (!s.tor) {
    await chrome.proxy.settings.clear({ scope: 'regular' }).catch(() => {});
    return setTorState({ state: 'off' });
  }
  const port = Number(s.torPort) || 9150;
  const control = await chrome.proxy.settings.get({});
  if (control.levelOfControl === 'not_controllable') return setTorState({ state: 'error', error: 'POLICY', port, at: Date.now() });
  if (control.levelOfControl === 'controlled_by_other_extensions') return setTorState({ state: 'error', error: 'OTHER_PROXY', port, at: Date.now() });
  try {
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pacScript(torHosts(s), port), mandatory: true } },
    scope: 'regular',
  });
  } catch (e) {
    return setTorState({ state: 'error', error: 'PROXY_FAILED', detail: String(e.message || e), port, at: Date.now() });
  }
  const got = await chrome.proxy.settings.get({});
  if (got.levelOfControl !== 'controlled_by_this_extension') {
    return setTorState({ state: 'error', error: 'OTHER_PROXY', port, at: Date.now() });
  }
  return check ? checkTor() : torState();
}

/** Ask the Tor Project whether our requests arrive through Tor. */
async function checkTor() {
  const s = await settingsStore.load();
  if (!s.tor) return setTorState({ state: 'off' });
  const port = Number(s.torPort) || 9150;
  await setTorState({ state: 'connecting', port, at: Date.now() });
  try {
    const j = await guardedFetch(TOR_CHECK_URL, { cache: 'no-store', signal: AbortSignal.timeout(25_000) }, {torCheck:true}, readJSON);
    if (j?.IsTor === true) return setTorState({ state: 'on', port, at: Date.now() });
    return setTorState({ state: 'error', error: 'NOT_TOR', port, at: Date.now() });
  } catch {
    return setTorState({ state: 'error', error: 'NO_TOR', port, at: Date.now() });
  }
}

async function maybeRecheckTor() {
  const t = await torState();
  const s = await settingsStore.load();
  if (!s.tor) return;
  if (t.state !== 'on' || Date.now() - (t.at || 0) > TOR_RECHECK_MS) await applyTor().catch(() => {});
}

// ------------------------------------------------------------ spend index --
// The spends of every block, as an observer sees them (an interval of AOCL
// leaves per spend; light_core::anonymity). Public chain data, kept so the
// privacy panel can give each coin's exact anonymity count. Stored in pages of
// 1000 blocks, keyed by height, so re-applying a block simply overwrites it.

const SPEND_PAGE = 1000;
const spendPageKey = (net, page) => `spends:${net}:${String(page).padStart(6, '0')}`;
let spendCache = null; // { net, height, flat } for the last complete build

// Pages are read, changed and written back; parallel downloads must not
// interleave those steps, or one batch's blocks would overwrite another's.
let spendWrites = Promise.resolve();
function recordSpends(net, list) {
  const run = spendWrites.then(() => writeSpends(net, list));
  spendWrites = run.catch(() => {});
  return run;
}

async function writeSpends(net, list) {
  if (!list?.length) return;
  const pages = new Map();
  for (const b of list) {
    const page = Math.floor((b.height - 1) / SPEND_PAGE);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(b);
  }
  for (const [page, blocks] of pages) {
    const k = spendPageKey(net, page);
    const cur = (await db.get(db.STORES.kv, k)) || {};
    for (const b of blocks) cur[b.height] = b.ranges ? Array.from(b.ranges) : null;
    await db.put(db.STORES.kv, k, cur);
  }
  spendCache = null;
}

/** Heights in [1, upTo] the index lacks (or could not compute), as runs. */
async function spendGaps(net, upTo) {
  const gaps = [];
  let have = 0;
  let runStart = null;
  const lastPage = Math.floor((upTo - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(net, page))) || {};
    const end = Math.min(upTo, (page + 1) * SPEND_PAGE);
    for (let h = page * SPEND_PAGE + 1; h <= end; h++) {
      const ok = Array.isArray(cur[h]);
      if (ok) have += 1;
      if (!ok && runStart == null) runStart = h;
      if (ok && runStart != null) {
        gaps.push([runStart, h - 1]);
        runStart = null;
      }
    }
  }
  if (runStart != null) gaps.push([runStart, upTo]);
  return { gaps, have, total: Math.max(0, upTo) };
}

/** Every spend interval of blocks 1..upTo, flattened, or null if incomplete. */
async function spendIndex(net, upTo) {
  if (spendCache && spendCache.net === net && spendCache.height === upTo) return spendCache.flat;
  const flat = [];
  const lastPage = Math.floor((upTo - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(net, page))) || {};
    const end = Math.min(upTo, (page + 1) * SPEND_PAGE);
    for (let h = page * SPEND_PAGE + 1; h <= end; h++) {
      if (!Array.isArray(cur[h])) return null;
      for (const v of cur[h]) flat.push(v);
    }
  }
  spendCache = { net, height: upTo, flat };
  return flat;
}

/** Fill in missing blocks of the spend index, a chunk per run. Returns true when more is left. */
async function fillSpendIndex(server, net, upTo) {
  const { gaps, have, total } = await spendGaps(net, upTo);
  await setStatus({ spendIndex: { have, total } });
  if (!gaps.length) return false;
  let budget = MAX_BLOCKS_PER_RUN;
  const heights = [];
  for (const [a, b] of gaps) {
    for (let h = a; h <= b && budget > 0; h++, budget--) heights.push(h);
    if (budget <= 0) break;
  }
  let done = have;
  await fetchBlocksAt(server, heights, async (body) => {
    const list = light.spendRanges(body, net);
    await recordSpends(net, list);
    done += list.filter((b) => b.ranges).length;
    await setStatus({ spendIndex: { have: done, total } });
  }, true);
  // Count again from what is stored, not from what was attempted.
  const after = await spendGaps(net, upTo);
  await setStatus({ spendIndex: { have: after.have, total: after.total } });
  return after.gaps.length > 0 && (after.have > have || yieldNow());
}

// ------------------------------------------------------------ fast restore --

/** Download the blocks at `heights` (any order) in ranges, a few at a time. */
async function fetchBlocksAt(server, heights, onBody, stopEarly = false) {
  const perCall = light.maxBlocksPerCall();
  const sorted = [...new Set(heights)].sort((a, b) => a - b);
  const ranges = [];
  for (const h of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && h === last[1] + 1 && h - last[0] < perCall) last[1] = h;
    else ranges.push([h, h]);
  }
  let next = 0;
  const worker = async () => {
    while (next < ranges.length && !(stopEarly && yieldNow())) {
      const [from, to] = ranges[next++];
      let body;
      for (let attempt = 0; ; attempt++) {
        try {
          body = await rpc.post(server, light.getBlocksRequest(rpc.id(), from, to), { timeoutMs: BLOCKS_TIMEOUT_MS, background: true });
          break;
        } catch (e) {
          if (yieldNow() || e.name === 'AbortError' || attempt >= 3) throw e;
          await sleep(800 * (attempt + 1));
        }
      }
      await onBody(body);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ranges.length) }, worker));
}

/**
 * Fast restore through the server's UTXO index (light_core::fast). Seconds
 * instead of a full scan; the server learns which coins are the wallet's.
 * Throws FAST_UNSUPPORTED when the server has no UTXO index.
 */
async function fetchFlagHeights(server, request, restore) {
  const original=JSON.parse(request),params=original.params;
  const flags=Array.isArray(params)&&Array.isArray(params[0])?params[0]:params?.announcement_flags;
  if(!Array.isArray(flags)||!flags.length)return restore.heightsToFetch(await rpc.post(server,request,{timeoutMs:BLOCKS_TIMEOUT_MS,background:true}));
  const found=new Set();
  const fetchPart=async part=>{
    const next={...original,id:rpc.id(),params:Array.isArray(params)?[part,...params.slice(1)]:{...params,announcement_flags:part}};
    try{for(const height of restore.heightsToFetch(await rpc.post(server,JSON.stringify(next),{timeoutMs:BLOCKS_TIMEOUT_MS,background:true})))found.add(height);}
    catch(e){
      if(yieldNow()||part.length<=1||!/(?:timeout|timed out|HTTP (?:413|429|502|503|504)|too many|too large|limit)/i.test(String(e.message)))throw e;
      const mid=Math.ceil(part.length/2);await fetchPart(part.slice(0,mid));await fetchPart(part.slice(mid));
    }
  };
  for(let i=0;i<flags.length;i+=20){if(yieldNow())throw new DOMException('Interrupted','AbortError');await fetchPart(flags.slice(i,i+20));}
  return [...found].sort((a,b)=>a-b);
}

async function fastRestore(wallet, server, onProgress) {
  const fr = new light.FastRestore();
  try {
    if(typeof fr.setChunkSize!=='function')throw new Error('Wallet modules are out of date. Rebuild both WASM modules and reload the extension.');
    // 1. Which blocks hold payments to our keys. Each round can reveal keys
    //    beyond the look-ahead window; the next round asks about those too.
    for (let round = 0; round < 64; round++) {
      const req = fr.flagsRequest(wallet, rpc.id());
      if (!req) break;
      let heights;
      try {
        heights = await fetchFlagHeights(server, req, fr);
      } catch (e) {
        if (round === 0 && /-32601|method not found|index.*(?:disabled|not enabled|not available)/i.test(String(e.message))) throw new Error(`FAST_UNSUPPORTED: ${e.message}`);
        throw e;
      }
      await fetchBlocksAt(server, heights, async (b) => {
        fr.scanBlocks(wallet, b);
        onProgress?.({...fr.progress(),phase:'scan'});
      });
    }
    if(fr.flagsRequest(wallet,rpc.id())) throw new Error('Fast restore key discovery exceeded its safety limit. Use the full scan.');
    // 2. Membership proofs, all relative to one block, checked locally.
    onProgress?.({...fr.progress(),phase:'proofs'});
    let proofSize=64;fr.setChunkSize(proofSize);
    if (fr.restoreChunks() > 0) {
      for (let attempt = 0; ; attempt++) {
        try {
          for (let i = 0; i < fr.restoreChunks(); i++) {
            fr.applyRestore(i, await rpc.post(server, fr.restoreRequest(rpc.id(), i), { timeoutMs: BLOCKS_TIMEOUT_MS, background:true }));
          }
          break;
        } catch (e) {
          const error=String(e.message);
          if(yieldNow()||attempt>=6)throw e;
          if(/TIP_MOVED/.test(error)){fr.resetProofs();continue;}
          if(proofSize>1&&/(?:timeout|timed out|HTTP (?:413|429|502|503|504)|too many|too large|limit)/i.test(error)){proofSize=Math.max(1,Math.floor(proofSize/2));fr.setChunkSize(proofSize);continue;}
          throw e;
        }
      }
      // 3. Where spent coins were spent, for the history. Optional.
      onProgress?.({...fr.progress(),phase:'history'});
      const spentReq = fr.spentRequest(rpc.id());
      if (spentReq) {
        try {
          const heights = fr.parseSpentHeights(await rpc.post(server, spentReq, { timeoutMs: BLOCKS_TIMEOUT_MS, background:true }));
          await fetchBlocksAt(server, heights, async (b) => fr.scanSpends(wallet, b));
        } catch {
          // Without it, spent coins still count as spent; only their dates are missing.
        }
      }
    }
    // 4. Wallet state at the block the proofs belong to (the tip if nothing was found).
    onProgress?.({...fr.progress(),phase:'finish'});
    const h = fr.snapshotHeight() ?? (await fetchHeight(server));
    if(h===0) return {height:0,state:wallet.genesisState(),events:[]};
    const block = await rpc.post(server, light.getBlocksRequest(rpc.id(), h, h), { timeoutMs: BLOCKS_TIMEOUT_MS, background: true });
    return fr.finish(wallet, block);
  } finally {
    fr.free?.();
  }
}

/** Run a pending fast restore inside a sync run. Returns the new snapshot, or null. */
async function saveRestorePlan(key,network,plan) {
  await db.put(db.STORES.kv,`restorePlan:${network}`,{box:await vault.encrypt(key,enc.encode(JSON.stringify(plan)))});
}
async function readRestorePlan(key,network) {
  const saved=await db.get(db.STORES.kv,`restorePlan:${network}`);if(!saved)return null;
  if(saved.box)return JSON.parse(dec.decode(await vault.decrypt(key,saved.box)));
  await saveRestorePlan(key,network,saved);return saved;
}

async function runFastRestore({ key, wallet, s, server, st, snap }) {
  const mode = st.fastPending;
  await setStatus({ fastPhase: 'scan', syncing: true });
  try {
    const out = await fastRestore(wallet, server, (p) => {
      setStatus({ fastPhase:p.phase||'scan', fastFound: p.coins_found, fastBlocks: p.blocks_scanned }).catch(() => {});
    });
    if (snap?.state) out.state = wallet.carryOver(snap.state, out.state);
    await dropSnapshots(s.network);
    await saveSnapshot(key, out.height, out.state);
    if (out.events?.length && (await recordBlockEvents(key, out.events))) notify('activity');
    await db.put(db.STORES.kv, `fastRestored:${s.network}`, { mode, server, at: Date.now() });
    await saveRestorePlan(key,s.network,{mode,pending:false,completedAt:Date.now()});
    await setStatus({ fastPending: null, fastPhase: null, fastFailed: null, fastFailureDetail:null, height: out.height, startHeight: out.height, restored: true });
    return { height: out.height, state: out.state };
  } catch (e) {
    // No index on this server, or it answered something we could not check:
    // fall back to the private full scan, which needs nothing from the server.
    const msg = String(e.message || e);
    const interrupted = e.name==='AbortError' && yieldNow();
    const failure = /FAST_UNSUPPORTED/.test(msg) ? 'unsupported' : interrupted ? 'interrupted' : 'failed';
    await saveRestorePlan(key,s.network,{mode,pending:interrupted,error:msg.slice(0,500),failure,failedAt:Date.now(),fallback:interrupted?null:'private'});
    await setStatus({ fastPending: interrupted?mode:null, fastPhase:null, fastFailed:failure, fastFailureDetail:msg.slice(0,500) });
    return null;
  }
}

// Request size and parallelism, adjusted to how the server answers.
const tune = { parallel: 2, maxParallel: PREFETCH, size: 0, good: 0 };

let followUp = null;
function scheduleFollowUp() {
  if (followUp || pauseRequested) return;
  followUp = setTimeout(() => {
    followUp = null;
    syncOnce().catch(() => {});
  }, 200);
}

let activeSync = null;
function syncOnce() {
  if (activeSync) return activeSync;
  activeSync = runSync().finally(() => { activeSync = null; });
  return activeSync;
}

function runSync() {
  return keepAlive(() =>
    exclusive(async () => {
      await migrateStorage();
      if (!(await vault.sessionKey())) return;
      const s0 = await settingsStore.load();
      pauseRequested = Boolean(await db.get(db.STORES.kv, `scanPaused:${s0.network}`));
      if (pauseRequested) { await setStatus({scanPaused:true, syncing:false}); return; }
      const server = settingsStore.serversFor(s0).sync;

      let tip;
      try {
        tip = await fetchHeight(server);
      } catch (e) {
        await setStatus({ serverOk: false, lastCheckAt: Date.now(), error: e.message === 'NEED_SERVER' ? 'NEED_SERVER' : null });
        throw e;
      }
      let st = await status();
      const restorePlan = await readRestorePlan(await vault.sessionKey(),s0.network);
      if(restorePlan?.pending && !st.fastPending) st=await setStatus({fastPending:restorePlan.mode});
      const current = await openWallet();
      const currentSnap = current && await latestSnapshot(current.key);
      const watchNeed = currentSnap && current.wallet.watchNeeds(currentSnap.state);
      // Nothing new on chain: a status update and done. The wallet is not
      // opened, nothing is decrypted and no wasm is loaded.
      const [savedHeight] = await snapHeights(s0.network);
      const indexDone = s0.exactPrivacy === false
        || (st.spendIndex && st.spendIndex.total >= savedHeight && st.spendIndex.have >= st.spendIndex.total);
      const archiveDone = !s0.localArchive || (st.archive && st.archive.state === 'ready'
        && st.archive.target >= Math.max(0, savedHeight - ARCHIVE_LAG) && !st.adoptPending);
      if (savedHeight != null && savedHeight >= tip && st.height === savedHeight && !st.error && indexDone && !watchNeed && archiveDone && !st.fastPending) {
        await setStatus({ serverOk: true, lastCheckAt: Date.now(), tip, syncing: false });
        return;
      }

      const w = await openWallet();
      if (!w) return;
      const { key, wallet, s } = w;
      let snap = await latestSnapshot(key);
      if (!snap) throw new Error('This network has no wallet state yet. Switch to it again from the home page.');
      if (st.fastPending && snap.height <= 1) {
        await setStatus({height:snap.height,tip,serverOk:true});
        snap = (await runFastRestore({ key, wallet, s, server, st, snap })) || snap;
        if(yieldNow()){scheduleFollowUp();return;}
      }
      await setStatus({
        serverOk: true, lastCheckAt: Date.now(), tip,
        lastTipChangeAt: !st.tip || tip > st.tip ? Date.now() : st.lastTipChangeAt,
        syncing: snap.height < tip, height: snap.height, error: null,
        startHeight: st.startHeight ?? snap.height,
      });

      let applied = 0;
      let retries = 0;
      const perCall = light.maxBlocksPerCall();
      const runEnd = Math.min(tip, snap.height + MAX_BLOCKS_PER_RUN);
      // Download several batches at once (the network is the slow part) and
      // apply them strictly in order. A batch that no longer fits after a
      // reorganization is thrown away and fetched again. When the server is
      // slow or refuses, the wallet asks for fewer blocks, one request at a
      // time, and speeds up again once answers come back quickly.
      tune.size = Math.min(tune.size || perCall, perCall);
      let pending = [];
      let nextFrom = snap.height + 1;
      const fill = () => {
        while (pending.length < tune.parallel && nextFrom <= runEnd) {
          const from = nextFrom;
          const to = Math.min(from + tune.size - 1, runEnd);
          const job = { from, to, started: Date.now() };
          job.body = rpc.post(server, light.getBlocksRequest(rpc.id(), from, to), { timeoutMs: BLOCKS_TIMEOUT_MS, background: true });
          job.body.then(() => { job.ms = Date.now() - job.started; }, () => {}); // a discarded batch must not raise
          pending.push(job);
          nextFrom = to + 1;
        }
      };
      const restart = () => {
        pending = [];
        nextFrom = snap.height + 1;
      };
      let unsaved = 0;
      let savedAt = Date.now();
      let failures = 0;
      const save = async () => {
        if (!unsaved) return;
        await saveSnapshot(key, snap.height, snap.state);
        unsaved = 0;
        savedAt = Date.now();
      };

      while (snap.height < runEnd) {
        // A user action is waiting: save and step aside; the next run continues.
        if (yieldNow()) break;
        fill();
        const job = pending.shift();
        if (!job) break;
        if (job.from !== snap.height + 1) {
          restart();
          continue;
        }
        let body;
        try {
          body = await job.body;
        } catch (e) {
          // Keep what was scanned so far, then ask for less, one at a time.
          await save();
          if (yieldNow() || e.name === 'AbortError') break;
          if (++failures > MAX_FETCH_FAILURES) throw e;
          // Refused while several requests were open: stay below that from now on.
          if (tune.parallel > 1) tune.maxParallel = Math.max(1, tune.parallel - 1);
          tune.parallel = 1;
          tune.size = Math.max(1, Math.floor((job.to - job.from + 1) / 2));
          tune.good = 0;
          await setStatus({ height: snap.height, retrying: true });
          await sleep(Math.min(10_000, 500 * 2 ** failures));
          restart();
          continue;
        }
        failures = 0;
        if (job.ms > SLOW_MS) {
          tune.parallel = Math.max(1, tune.parallel - 1);
          if (tune.parallel === 1) tune.size = Math.max(1, Math.floor(tune.size / 2));
          tune.good = 0;
        } else if (job.ms < SLOW_MS / 4 && ++tune.good >= 5) {
          // Speed up again only after several quick answers in a row.
          tune.good = 0;
          if (tune.size < perCall) tune.size = Math.min(perCall, tune.size * 2);
          else if (tune.parallel < tune.maxParallel) tune.parallel += 1;
        }

        const out = wallet.applyBlocks(snap.state, body);
        const r = out.result;

        if (r.reorg) {
          if (++retries > 5) throw new Error('The server keeps returning blocks that do not connect');
          await save();
          if (r.applied === 0) {
            // Our tip was orphaned: drop this snapshot and step back.
            const latestWatchState = snap.state;
            await db.del(db.STORES.snapshots, snapKey(s.network, snap.height));
            snapCache = null;
            snap = await latestSnapshot(key);
            if (!snap) throw new Error('Reorganization deeper than saved history. Restore the wallet again.');
            snap.state = wallet.reconcileWatch(latestWatchState, snap.state);
            await saveSnapshot(key, snap.height, snap.state);
          }
          restart(); // the chain changed mid-request: refetch
          continue;
        }

        snap = { height: r.height, state: out.state };
        applied += r.applied;
        unsaved += r.applied;
        const found = r.events.length > 0;
        // Saving encrypts the whole state, so during a long scan it happens
        // every SAVE_EVERY blocks or SAVE_EVERY_MS, and right after coins are found.
        if (found || unsaved >= SAVE_EVERY || Date.now() - savedAt >= SAVE_EVERY_MS || snap.height >= runEnd) {
          await save();
        }
        if (found && (await recordBlockEvents(key, r.events))) notify('activity');
        await recordSpends(s.network, r.spends).catch(() => {});
        await setStatus({ height: snap.height, retrying: false });
      }
      if (unsaved) await saveSnapshot(key, snap.height, snap.state);

      // Free inputs of our transactions that never confirmed.
      const released = wallet.releaseStale(snap.state, STALE_RESERVATION_BLOCKS);
      await saveSnapshot(key, snap.height, released);
      snap.state = released;
      if (await expireOldSends(key, snap.height)) notify('activity');

      await setStatus({ syncing: snap.height < tip, height: snap.height, lastSyncAt: Date.now() });
      await watchAlerts({key, wallet, snap, network:s.network}).catch(() => {});
      // Not at the tip yet (a restore): carry on right away instead of waiting
      // a minute for the alarm. Each chunk releases the lock in between, so
      // other actions (send, receive, settings) are never blocked for long.
      if (snap.height < tip) {
        scheduleFollowUp();
      } else {
        // Caught up. Background work, one chunk per run, each retried on the
        // next run if it fails: watch-only addresses that lag behind, then the
        // local archive (which also fills the spend index), or else the
        // spend index alone, for exact anonymity counts.
        let more = false;
        try {
          if (yieldNow()) more = true;
          else more = (await watchCatchUp({ key, wallet, server, snap })) || more;
        } catch (e) {
          await setStatus({ watchError: String(e.message || e).slice(0, 200) });
        }
        if (yieldNow()) {
          more = true;
        } else if (s.localArchive) {
          try {
            more = (await archiveStep({ key, wallet, server, net: s.network, snap })) || more;
          } catch (e) {
            await setArchiveStatus({ state: 'error', error: String(e.message || e).slice(0, 200) });
          }
        } else if (s.exactPrivacy !== false) {
          try {
            more = (await fillSpendIndex(server, s.network, snap.height)) || more;
          } catch {
            // Retried on the next run.
          }
        }
        if (more) scheduleFollowUp();
      }
    }),
  ).catch(async (e) => {
    if (e.message !== 'NEED_SERVER') await setStatus({ syncing: false, error: String(e.message || e) }).catch(() => {});
    throw e;
  });
}

// --------------------------------------------- blocks in strict order -----

/**
 * Download blocks `from..to` and hand each response to `onBody` in order (two
 * requests ahead). Stops early, between batches, when a user action waits.
 * Returns the last height handed over.
 */
async function fetchInOrder(server, from, to, onBody, parallel = 2) {
  const perCall = light.maxBlocksPerCall();
  const ranges = [];
  for (let a = from; a <= to; a += perCall) ranges.push([a, Math.min(to, a + perCall - 1)]);
  const get = ([a, b]) => {
    const p = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await rpc.post(server, light.getBlocksRequest(rpc.id(), a, b), { timeoutMs: BLOCKS_TIMEOUT_MS, background: true });
        } catch (e) {
          if (yieldNow() || e.name === 'AbortError' || attempt >= 3) throw e;
          await sleep(800 * (attempt + 1));
        }
      }
    })();
    p.catch(() => {}); // awaited below; a rejection before that must not surface
    return p;
  };
  const ahead = ranges.slice(0, parallel).map(get);
  let last = from - 1;
  for (let i = 0; i < ranges.length; i++) {
    if (yieldNow()) break;
    let body;
    try { body = await ahead[i]; } catch (e) {
      if (yieldNow() || e.name === 'AbortError') break;
      throw e;
    }
    if (i + parallel < ranges.length) ahead.push(get(ranges[i + parallel]));
    await onBody(body, ranges[i]);
    last = ranges[i][1];
  }
  return last;
}

// ---------------------------------------------------------- watch-only -----
// Other wallets' addresses, followed with their viewing keys. They live in
// the wallet state (so a reorg rollback restores them too). A new one is
// scanned from its first block in the background, here, a chunk per run.

async function watchCatchUp({ key, wallet, server, snap }) {
  const prefs = await settingsStore.load();
  const need = wallet.watchNeeds(snap.state);
  if (!need) {
    await setStatus({ watchBehind: null, watchError: null });
    return false;
  }
  const [from, end] = need;
  const to = Math.min(end, from + MAX_BLOCKS_PER_RUN - 1);
  let state = snap.state;
  await setStatus({ watchBehind: { at: from - 1, end } });
  await fetchInOrder(server, from, to, async (body) => {
    const out = wallet.watchCatchUp(state, body);
    state = out.state;
    // Commit each successful batch before publishing its progress.
    await saveSnapshot(key, snap.height, state);
    snap.state = state;
    await watchAlerts({key, wallet, snap, network:prefs.network}).catch(() => {});
    const remaining = wallet.watchNeeds(state);
    await setStatus({ watchBehind: remaining ? { at: remaining[0] - 1, end: remaining[1] } : null });
  }, prefs.watchScanMode === 'fast' ? 3 : 1);
  // Same height, same chain: only the watch-only part changed.
  await saveSnapshot(key, snap.height, state);
  snap.state = state;
  const left = Boolean(wallet.watchNeeds(state));
  await setStatus({ watchBehind: left ? { at: wallet.watchNeeds(state)[0] - 1, end } : null, watchError: null });
  notify('watch');
  return left;
}

/**
 * Change the latest wallet state under the sync lock; `fn` returns
 * `{ state, out }`. Jumps ahead of background work; a job the popup
 * cancelled while waiting stops here, before any change.
 */
async function withState(fn, jobId) {
  jobProgress(jobId, { phase: 'waiting' });
  return exclusiveNow(async () => {
    cancelled(jobId);
    const { key, wallet, s } = await requireWallet();
    jobProgress(jobId, { phase: 'saving' });
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    const r = await fn({ key, wallet, s, snap });
    if (r?.state) await saveSnapshot(key, snap.height, r.state);
    return r?.out;
  });
}

// ------------------------------------------------------------- archive -----
// The archival mutator set on this device (light_core::archive): every AOCL
// leaf and Bloom-filter chunk, tens of MB, built from genesis in order and
// checked against every block's commitment. It stays ARCHIVE_LAG blocks
// behind the wallet so that a small reorganization never reaches it; coins
// it finds are carried to the wallet's block through those last blocks.
// Stored as pages in one atomic write per run; reading it also fills the
// spend index for exact anonymity counts.

const ARCHIVE_LAG = 10;
const archKey = (net, part) => `arch:${net}:${part}`;
const pageKey = (net, kind, p) => archKey(net, `${kind}:${String(p).padStart(6, '0')}`);
let archiveCache = null; // { net, a }

function dropArchive() {
  archiveCache?.a.free?.();
  archiveCache = null;
}

async function setArchiveStatus(patch) {
  const st = await status();
  await setStatus({ archive: { ...(st.archive || {}), ...patch, at: Date.now() } });
}

async function deleteArchive(net) {
  dropArchive();
  await db.delPrefix(db.STORES.kv, archKey(net, ''));
}

/** The archive of `net`, from memory, from storage, or new at genesis. */
async function loadArchive(net) {
  if (archiveCache?.net === net) return archiveCache.a;
  await wasm();
  dropArchive();
  const meta = await db.get(db.STORES.kv, archKey(net, 'meta'));
  let a;
  if (!meta) {
    a = new light.Archive(net);
  } else {
    try {
      a = light.Archive.fromMeta(meta, net);
      for (let p = 0; ; p++) {
        const b = await db.get(db.STORES.kv, pageKey(net, 'L', p));
        if (!b) break;
        a.loadLeafPage(p, b);
      }
      for (let p = 0; ; p++) {
        const b = await db.get(db.STORES.kv, pageKey(net, 'C', p));
        if (!b) break;
        a.loadChunkPage(p, b);
      }
      a.finishLoad();
    } catch (e) {
      // Damaged or from an older layout: start over from genesis.
      a?.free?.();
      await db.delPrefix(db.STORES.kv, archKey(net, ''));
      await setArchiveStatus({ note: `rebuilt: ${String(e.message || e).slice(0, 120)}` });
      a = new light.Archive(net);
    }
  }
  archiveCache = { net, a };
  return a;
}

/** Write the pages changed since the last save, and the meta record, in one transaction. */
async function saveArchive(net, a) {
  const dirty = a.dirtyPages();
  const entries = [];
  for (const p of dirty.leaves) entries.push([pageKey(net, 'L', p), a.leafPage(p)]);
  for (const p of dirty.chunks) entries.push([pageKey(net, 'C', p), a.chunkPage(p)]);
  entries.push([archKey(net, 'meta'), a.metaBytes()]);
  await db.putMany(db.STORES.kv, entries);
  a.clearDirty();
}

/** One chunk of archive work. Returns true when more is left. */
async function archiveStep({ key, wallet, server, net, snap }) {
  const target = Math.max(0, snap.height - ARCHIVE_LAG);
  const a = await loadArchive(net);
  if (a.height() < target) {
    const from = a.height() + 1;
    const to = Math.min(target, from + MAX_BLOCKS_PER_RUN - 1);
    const prev = (await status()).archive || {};
    await setArchiveStatus({ state: 'building', height: a.height(), target, error: null, startedAt: prev.startedAt || Date.now() });
    let applyError = null;
    let downloaded = prev.downloaded || 0;
    let rate = prev.rate || 0; // blocks per minute, smoothed
    try {
      let lastAt = Date.now();
      await fetchInOrder(server, from, to, async (body, [ra, rb]) => {
        let spends;
        try {
          spends = a.applyBlocks(body);
        } catch (e) {
          applyError = e;
          throw e;
        }
        await recordSpends(net, spends).catch(() => {});
        downloaded += body.length;
        // Blocks per minute, download and checking included, smoothed.
        const now = Date.now();
        const inst = ((rb - ra + 1) * 60_000) / Math.max(1, now - lastAt);
        lastAt = now;
        rate = rate ? rate * 0.8 + inst * 0.2 : inst;
        await setArchiveStatus({ state: 'building', height: a.height(), target, downloaded, rate: Math.round(rate), leaves: a.numLeaves(), size: a.sizeBytes() });
      });
    } catch (e) {
      if (!applyError) {
        // The network failed between blocks: what was applied is whole. Keep it.
        await saveArchive(net, a);
        throw e;
      }
      if (/does not extend the archive/.test(String(applyError.message || applyError))) {
        // The archive's last block was orphaned by a deep reorganization.
        await deleteArchive(net);
        await setArchiveStatus({ state: 'building', height: 0, target, error: null, note: 'reorg' });
        return true;
      }
      // A block may be half applied: forget the copy in memory, keep what was saved.
      dropArchive();
      throw applyError;
    }
    await saveArchive(net, a);
  }
  const ready = a.height() >= target;
  await setArchiveStatus({ state: ready ? 'ready' : 'building', height: a.height(), target, size: a.sizeBytes(), leaves: a.numLeaves(), error: null, ...(ready ? { rate: 0 } : {}) });
  if (ready && !yieldNow()) {
    const adopted = await adoptWaiting({ key, wallet, server, snap, a });
    await setStatus({ adoptPending: false, ...(adopted.length ? { lastAdopted: { at: Date.now(), list: adopted } } : {}) });
  }
  return !ready || yieldNow();
}

/**
 * What the archive will take on this device, from the chain as the wallet
 * sees it: every AOCL leaf (40 bytes), every Bloom-filter chunk (its hash and
 * a length, 48 bytes), the 45 indices of every spend (4 bytes each, 180 per
 * spend) and the AOCL size after each block (8 bytes). The spend count is
 * exact once the spend index is complete, otherwise scaled from its pages.
 */
let estimateCache = null;
async function archiveEstimate(s) {
  const key = await vault.sessionKey();
  if (!key) return null;
  const snap = await latestSnapshot(key);
  if (!snap) return null;
  if (estimateCache && estimateCache.net === s.network && Math.abs(estimateCache.height - snap.height) < 50) return estimateCache.value;
  await wasm();
  const { wallet } = await requireWallet();
  const c = wallet.chainCounts(snap.state);
  let spends = 0;
  let blocks = 0;
  const lastPage = Math.floor((snap.height - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(s.network, page))) || {};
    for (const v of Object.values(cur)) {
      if (!Array.isArray(v)) continue;
      blocks += 1;
      spends += v.length / 2;
    }
  }
  const exact = blocks >= snap.height && snap.height > 0;
  // Without a spend index yet: about one spend for every two coins created.
  const spendCount = blocks > 0 ? Math.round((spends * snap.height) / blocks) : Math.round(c.aocl_leaves / 2);
  const bytes = c.aocl_leaves * 40 + c.chunks * 48 + spendCount * 180 + snap.height * 8 + c.active * 4;
  const value = { bytes, leaves: c.aocl_leaves, chunks: c.chunks, spends: spendCount, spendsExact: exact, spendsSampled: blocks > 0, height: snap.height };
  estimateCache = { net: s.network, height: snap.height, value };
  return value;
}

/** Timestamp (ms) of block `height`; the genesis block's is not served, so 0. */
async function blockTime(server, height) {
  if (height <= 0) return 0;
  try {
    return light.blockInfo(await rpc.post(server, light.getBlocksRequest(rpc.id(), height, height))).timestamp_ms;
  } catch {
    return 0;
  }
}

/** Registered coins the archive finds become the wallet's. */
async function adoptWaiting({ key, wallet, server, snap, a }) {
  if (!wallet.expectedList(snap.state).length) return [];
  if (a.height() > snap.height) return [];
  const body = a.height() < snap.height
    ? await rpc.post(server, light.getBlocksRequest(rpc.id(), a.height() + 1, snap.height), { timeoutMs: BLOCKS_TIMEOUT_MS, background: true })
    : undefined;
  const out = wallet.adoptFromArchive(snap.state, a, body);
  if (!out.adopted.length) return [];
  await saveSnapshot(key, snap.height, out.state);
  snap.state = out.state;
  const events = [];
  for (const x of out.adopted.filter((c) => !c.spent)) {
    events.push({
      height: x.height, hash: '', timestamp_ms: await blockTime(server, x.height), spent: [],
      received: [{ aocl_index: x.aocl_index, amount: x.amount, is_change: false, tx_id: null, address_kind: x.key_kind === 'change' ? null : x.key_kind }],
    });
  }
  if (events.length && (await recordBlockEvents(key, events))) notify('activity');
  return out.adopted;
}

// ----------------------------------------------------- offscreen prover -----

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Prove and broadcast transactions in parallel Web Workers',
  });
}

async function offscreenAlive() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function closeOffscreenIfIdle() {
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec && ['proving', 'proved', 'submitting'].includes(rec.status)) return;
  }
  if (await offscreenAlive()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let i = 0; i < 15; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (e) {
      if (!/Receiving end|Could not establish/i.test(String(e.message))) throw e;
      await sleep(200);
    }
  }
  throw new Error('The proving page did not start');
}

/** Which send the offscreen page is working on right now, if any. */
async function offscreenBusyWith() {
  if (!(await offscreenAlive())) return null;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
    return r?.sendId || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- send ----

// Send records live in IndexedDB. Who you pay, how much, and your note are
// sealed with the vault key, so a locked wallet's disk shows only progress.
const SEALED_FIELDS = ['to', 'amount', 'fee', 'view', 'pinned', 'toKind', 'fromKind', 'note', 'error'];
const enc = new TextEncoder();
const dec = new TextDecoder();

async function getSend(id) {
  const rec = await db.get(db.STORES.sends, id);
  if (!rec?.sealed) return rec;
  const key = await vault.sessionKey();
  if (!key) return rec; // locked: progress fields only
  try {
    Object.assign(rec, JSON.parse(dec.decode(await vault.decrypt(key, rec.sealed))));
    rec.unsealed = true;
  } catch {
    /* sealed by a previous wallet: leave it */
  }
  return rec;
}

async function saveSend(rec) {
  rec.updatedAt = Date.now();
  const stored = { ...rec };
  delete stored.unsealed;
  const plain = {};
  let has = false;
  for (const f of SEALED_FIELDS) {
    if (f in stored) {
      plain[f] = stored[f];
      has = true;
      delete stored[f];
    }
  }
  const key = await vault.sessionKey();
  if (has && key) stored.sealed = await vault.encrypt(key, enc.encode(JSON.stringify(plain)));
  else if (has && !rec.sealed) throw new Error('Wallet locked: refusing to save unencrypted payment details');
  await db.put(db.STORES.sends, rec.id, stored);
  notify('send', { send: { ...(key ? rec : stored), prepared: undefined, sealed: undefined } });
}

const ACTIVE = ['starting', 'waiting-block', 'preparing', 'rebuilding', 'proving', 'proved', 'submitting', 'needs-lustration'];

async function activeSend(network) {
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec && rec.network === network && ACTIVE.includes(rec.status)) return rec;
  }
  return null;
}

async function ensureNoActivePayment() {
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await db.get(db.STORES.sends,id);
    if (rec && ACTIVE.includes(rec.status)) throw new Error('Finish or cancel active payments before replacing or resetting the wallet');
  }
  if (await offscreenBusyWith()) throw new Error('Wait for the approved payment to finish before resetting the wallet');
}

async function startSend(req) {
  return exclusiveNow(async () => {
  await requireWallet();
  await migrateStorage();
  const network = await currentNetwork();
  const busy = await activeSend(network);
  if (busy) throw new Error('A payment is still being sent. Wait until it finishes, or open it from the home page.');
  const rec = {
    id: crypto.randomUUID(),
    network,
    to: req.to,
    toKind: req.toKind || null,
    note: String(req.note || '').slice(0, 200),
    fromKind: ['generation', 'ec-hybrid'].includes(req.fromKind) ? req.fromKind : 'any',
    amount: req.amount,
    fee: req.fee,
    acceptLustration: Boolean(req.acceptLustration),
    waitForFreshBlock: req.waitForFreshBlock !== false,
    attempt: 1,
    pinned: null,
    createdAt: Date.now(),
    status: 'starting',
  };
  await saveSend(rec);
  runSend(rec.id).catch(() => {});
  return rec.id;
  });
}

const running = new Set(); // send ids with a step in progress in this worker

function guarded(id, fn) {
  if (running.has(id)) return Promise.resolve();
  running.add(id);
  return keepAlive(fn).finally(() => running.delete(id));
}

async function failSend(rec, error) {
  rec.status = 'failed';
  rec.error = friendlyError(error);
  pushNotice('failed', { e: rec.error });
  delete rec.prepared;
  await saveSend(rec);
  await db.delPrefix(db.STORES.jobs, `${rec.id}:`);
  await db.delPrefix(db.STORES.proofs, `${rec.id}:`);
  await closeOffscreenIfIdle();
}

function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/HTTP 413|RequestBodyTooBig|too big|too large/i.test(m)) {
    return 'The broadcast server refused the transaction because of its size. Choose another broadcast server in Settings > Servers.';
  }
  if (/Failed to fetch|NetworkError|aborted|timed out/i.test(m)) {
    return 'Could not reach the broadcast server. Check your connection; your coins were not spent.';
  }
  if (/FeeNegative|fee/i.test(m) && /node:/.test(m)) return `The node refused the fee. ${m}`;
  if (/insufficient spendable balance/i.test(m)) return m.replace('insufficient spendable balance', 'Not enough available balance');
  return m;
}

function runSend(id) {
  return guarded(id, async () => {
    let rec = await getSend(id);
    if (!rec || !['starting', 'waiting-block', 'rebuilding'].includes(rec.status)) return;
    try {
      const w = await openWallet();
      if (!w) throw new Error('The wallet is locked. Unlock it to continue sending.');
      const { key, wallet, s } = w;
      if (s.network !== rec.network) return; // resumes when that network is active again

      // Timing: start right after a block, so proving finishes before the next.
      if (rec.waitForFreshBlock && rec.attempt === 1) {
        const st = await status();
        const sinceBlock = Date.now() - (st.lastTipChangeAt || 0);
        const freshSinceStart = (st.lastTipChangeAt || 0) > rec.createdAt;
        const waitedTooLong = Date.now() - rec.createdAt > MAX_BLOCK_WAIT_MS;
        if (sinceBlock > FRESH_BLOCK_WINDOW_MS && !freshSinceStart && !waitedTooLong) {
          if (rec.status !== 'waiting-block') {
            rec.status = 'waiting-block';
            await saveSend(rec);
          }
          return; // resumed by the sync alarm
        }
      }

      rec.status = 'preparing';
      await saveSend(rec);
      await syncOnce();
      if (await wasCancelled(id)) return;

      const live = await openWallet();
      if (!live || live.wallet !== wallet || live.s.network !== rec.network) throw new Error('Wallet locked or network changed before preparation');
      const snap = await latestSnapshot(key);
      const out = wallet.prepareSend(
        snap.state, rec.to, rec.amount, rec.fee, Date.now(),
        rec.pinned ? new Float64Array(rec.pinned) : undefined,
        rec.acceptLustration,
        rec.fromKind || 'any',
      );
      rec.view = out.view;
      rec.pinned = out.view.input_aocl_indices;
      rec.prepared = await vault.encrypt(key, out.prepared);
      rec.builtAtHeight = snap.height;
      rec.jobCount = out.jobs.length;
      rec.jobsDone = 0;
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
      await db.del(db.STORES.kv, `submit:${id}`);
      for (let i = 0; i < out.jobs.length; i++) {
        await db.put(db.STORES.jobs, `${id}:${i}`, await vault.encrypt(key, out.jobs[i]));
      }
      if (await wasCancelled(id)) return;
      await saveSend(rec);

      if (out.jobs.length === 0) return await dispatchSubmit(rec); // mock-proof network
      await dispatchProve(rec);
    } catch (e) {
      rec = (await getSend(id)) || rec;
      const msg = String(e.message || e);
      if (msg.includes('LUSTRATION_REQUIRED')) {
        rec.status = 'needs-lustration';
        rec.error = null;
        await saveSend(rec);
      } else {
        await failSend(rec, e);
      }
    }
  });
}

async function wasCancelled(id) {
  return (await getSend(id))?.status === 'cancelled';
}

const CANCELLABLE = ['starting', 'waiting-block', 'preparing', 'rebuilding', 'proving', 'needs-lustration'];

/** Stop a payment that has not reached the network yet. */
async function cancelSend(id) {
  const rec = await getSend(id);
  if (!rec) throw new Error('Payment not found');
  if (!CANCELLABLE.includes(rec.status)) {
    throw new Error('Too late to cancel: the payment is already being sent to the network.');
  }
  if (rec.status === 'proving' && (await offscreenBusyWith()) === id) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', sendId: id }).catch(() => {});
  }
  rec.status = 'cancelled';
  rec.dismissed = true;
  rec.doneAt = Date.now();
  delete rec.prepared;
  await saveSend(rec);
  await db.delPrefix(db.STORES.jobs, `${id}:`);
  await db.delPrefix(db.STORES.proofs, `${id}:`);
  await closeOffscreenIfIdle().catch(() => {});
}

async function dispatchProve(rec) {
  const raw = await vault.sessionKeyRaw();
  if (!raw) throw new Error('The wallet is locked. Unlock it to continue sending.');
  const s = await settingsStore.load();
  rec.status = 'proving';
  rec.provingStartedAt ??= Date.now();
  await saveSend(rec);
  await toOffscreen({
    type: 'prove', sendId: rec.id, count: rec.jobCount, labels: rec.view?.job_labels,
    workers: s.workers, key: Array.from(raw), lowMemory: s.lowMemoryProving || 'auto',
  });
}

async function dispatchSubmit(rec) {
  const raw = await vault.sessionKeyRaw();
  if (!raw) throw new Error('The wallet is locked. Unlock it to continue sending.');
  rec.status = 'submitting';
  await saveSend(rec);
  await toOffscreen({ type: 'submit', sendId: rec.id, key: Array.from(raw) });
}

/** The offscreen page wrote a submit result to `kv/submit:<id>`. */
function onSubmitted(id) {
  return guarded(id, () => handleSubmitted(id)).then((next) => {
    if (next === 'rebuild') return runSend(id);
  });
}

async function handleSubmitted(id) {
  {
    await wasm();
    const res = await db.get(db.STORES.kv, `submit:${id}`);
    let rec = await getSend(id);
    if (!res || !rec) return;
    if (['done', 'failed'].includes(rec.status) || (rec.status === 'cancelled' && !res.ok)) {
      await db.del(db.STORES.kv, `submit:${id}`);
      return;
    }
    const w = await openWallet();
    if (!w) return; // finished on unlock (resumeSends)
    const { key, wallet } = w;

    if (res.ok && !rec.prepared) {
      // Cancelled at the last moment, but the network already has it: the
      // coins are spent. Their state updates on the next sync.
      rec.status = 'done';
      rec.doneAt = Date.now();
      rec.note = 'cancel-too-late';
      await saveSend(rec);
      await db.del(db.STORES.kv, `submit:${id}`);
      return;
    }
    if (res.ok) {
      const prepared = await vault.decrypt(key, rec.prepared);
      let height = rec.builtAtHeight;
      await exclusive(async () => {
        const snap = await latestSnapshot(key, rec.network);
        height = snap.height;
        const next = wallet.recordBroadcast(snap.state, prepared);
        await saveSnapshot(key, snap.height, next, rec.network);
      });
      const list = await readActivity(key, rec.network);
      if (!list.some((e) => e.txId === rec.view.tx_id)) {
        list.unshift({
          kind: 'sent', id: `t:${rec.view.tx_id}`, txId: rec.view.tx_id, status: 'pending',
          amount: rec.view.amount, fee: rec.view.fee, change: rec.view.change, to: rec.to,
          toKind: rec.toKind || null, note: rec.note || '', at: Date.now(), atHeight: height, height: null,
        });
        await writeActivity(key, list, rec.network);
      }
      notify('activity');
      const total = plus(rec.view.amount, rec.view.fee);
      const change = amt(rec.view.change || '0');
      pushNotice(toUnits(change) > 0n ? 'sentChange' : 'sent', { n: total, c: change });
      rec.status = 'done';
      rec.doneAt = Date.now();
      delete rec.prepared;
      await saveSend(rec);
      await db.del(db.STORES.kv, `submit:${id}`);
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
      await closeOffscreenIfIdle();
      return;
    }

    await db.del(db.STORES.kv, `submit:${id}`);
    if (light.isNotConfirmable(res.error || '') && rec.attempt < MAX_SEND_ATTEMPTS) {
      // A block arrived while proving. Rebuild with the same inputs.
      rec.attempt += 1;
      rec.status = 'rebuilding';
      await saveSend(rec);
      return 'rebuild';
    }
    rec = (await getSend(id)) || rec;
    await failSend(rec, res.error);
    return null;
  }
}

/** Pick up sends interrupted by a worker restart, a browser restart or a lock. */
async function resumeSends() {
  await migrateStorage();
  const network = await currentNetwork();
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (!rec || rec.network !== network || running.has(id)) continue;
    const stalled = Date.now() - (rec.updatedAt || rec.createdAt) > STALLED_MS;

    if (['starting', 'waiting-block'].includes(rec.status)) {
      await runSend(id);
    } else if (['preparing', 'rebuilding'].includes(rec.status) && stalled) {
      rec.status = rec.attempt > 1 ? 'rebuilding' : 'starting';
      await saveSend(rec);
      await runSend(id);
    } else if (['proving', 'proved', 'submitting'].includes(rec.status)) {
      if (await db.get(db.STORES.kv, `submit:${id}`)) {
        await onSubmitted(id);
        continue;
      }
      if ((await offscreenBusyWith()) === id || !stalled) continue;
      await guarded(id, async () => {
        try {
          let proofs = 0;
          let jobs = 0;
          for (let i = 0; i < (rec.jobCount || 0); i++) {
            if (await db.get(db.STORES.proofs, `${id}:${i}`)) proofs += 1;
            if (await db.get(db.STORES.jobs, `${id}:${i}`)) jobs += 1;
          }
          if (rec.prepared && proofs === rec.jobCount) await dispatchSubmit(rec);
          else if (rec.prepared && jobs === rec.jobCount) await dispatchProve(rec);
          else {
            rec.status = 'starting';
            await saveSend(rec);
          }
        } catch (e) {
          await failSend(rec, e);
        }
      });
      if (rec.status === 'starting') await runSend(id);
    }
  }
}

async function latestSend(network) {
  let latest = null;
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec?.network !== network) continue;
    if (!latest || rec.createdAt > latest.createdAt) latest = rec;
  }
  return latest ? { ...latest, prepared: undefined, sealed: undefined } : null;
}

// ----------------------------------------------------------------- price ----

// NPT price for the optional local-currency line. CoinGecko learns only that
// someone asked for the NPT price, never an address or a balance.
const PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=neptune-cash,tether&vs_currencies=usd,eur,gbp&include_24hr_change=true';
const PRICE_TTL_MS = 5 * 60_000;
let priceCache = null;

async function fetchPrice() {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache;
  const j = await guardedFetch(PRICE_URL, { cache: 'no-store', signal:AbortSignal.timeout(15000) }, {}, readJSON);
  const npt = j['neptune-cash'] || {};
  const tether = j.tether || {};
  if (!Number.isFinite(npt.usd) || npt.usd<=0) throw new Error('no valid NPT price available');
  priceCache = {
    at: Date.now(),
    usd: npt.usd,
    eur: npt.eur,
    gbp: npt.gbp,
    // NPT trades against USDT; USDT is close to, but not exactly, one dollar.
    usdt: tether.usd ? npt.usd / tether.usd : npt.usd,
    change24h: typeof npt.usd_24h_change === 'number' ? npt.usd_24h_change : null,
  };
  return priceCache;
}

// The NPT price over the last 7 days, for the chart behind the balance.
const HISTORY_TTL_MS = 30 * 60_000;
let historyCache = null;
async function fetchPriceHistory(cur) {
  const vs = cur === 'eur' ? 'eur' : cur === 'gbp' ? 'gbp' : 'usd';
  if (historyCache && historyCache.vs === vs && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache;
  const url = `https://api.coingecko.com/api/v3/coins/neptune-cash/market_chart?vs_currency=${vs}&days=7`;
  const j = await guardedFetch(url, { cache: 'no-store', signal:AbortSignal.timeout(15000) }, {}, readJSON);
  const raw = (j.prices || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1]>0);
  if (raw.length < 2) throw new Error('no price history');
  // About 64 points is plenty for a small chart.
  const step = Math.max(1, Math.floor(raw.length / 64));
  const points = raw.filter((_, i) => i % step === 0 || i === raw.length - 1).map(([t, p]) => [t, p]);
  historyCache = { at: Date.now(), vs, points };
  return historyCache;
}

// ------------------------------------------------------------- commands ----

async function bumpAutoLock() {
  const s = await settingsStore.load();
  await chrome.alarms.create('autolock', { delayInMinutes: Number(s.autoLockMinutes) || 15 });
}

async function requireWallet() {
  await migrateStorage();
  const w = await openWallet();
  if (!w) throw new Error('locked');
  return w; // Read-only polling must not extend the unlock lifetime.
}

/** Start height for a restore: a block height, a date, or the tip. */
async function startHeight(server, { birthday, birthdayDate }) {
  if (birthday !== undefined && birthday !== null && birthday !== '') {
    const b = Math.floor(Number(birthday));
    if (!Number.isFinite(b) || b < 0) throw new Error('Not a block height');
    return b <= 1 ? 0 : b; // from the very beginning: the genesis block
  }
  if (birthdayDate) return heightAtDate(server, Number(birthdayDate));
  return fetchHeight(server);
}

// ------------------------------------------------------------ contacts ----

async function readContacts(key, network) {
  const n = network || (await currentNetwork());
  const box = await db.get(db.STORES.kv, `contacts:${n}`);
  return box ? JSON.parse(dec.decode(await vault.decrypt(key, box))) : [];
}

async function readHiddenWatch(key, network) {
  const box=await db.get(db.STORES.kv,`watchHidden:${network||await currentNetwork()}`);
  return box?JSON.parse(dec.decode(await vault.decrypt(key,box))):[];
}
async function writeHiddenWatch(key,network,ids) {
  await db.put(db.STORES.kv,`watchHidden:${network}`,await vault.encrypt(key,enc.encode(JSON.stringify(ids))));
}

async function writeContacts(key, list, network) {
  const n = network || (await currentNetwork());
  await db.put(db.STORES.kv, `contacts:${n}`, await vault.encrypt(key, enc.encode(JSON.stringify(list))));
}

/** Seal send records written in plain text by versions before 0.6. */
async function sealOldSends() {
  if (!(await vault.sessionKey())) return;
  for (const id of await db.keys(db.STORES.sends)) {
    const raw = await db.get(db.STORES.sends, id);
    if (raw && !raw.sealed && SEALED_FIELDS.some((f) => f in raw)) await saveSend(raw);
  }
}

async function genericWatchNotice(id,message) {
  await chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title:'Escanour watch monitor',message,priority:1});
}
function watchBaseline(wallet,snap){return Object.fromEntries(wallet.watchList(snap.state,Date.now()).map(w=>[w.key_short,w.coins.length]));}
async function saveWatchAlertBaseline(key,wallet,snap,network) {
  await db.put(db.STORES.kv,`watchAlertBaseline:${network}`,await vault.encrypt(key,enc.encode(JSON.stringify(watchBaseline(wallet,snap)))));
}
async function watchAlerts({key,wallet,snap,network}) {
  const prefs=await settingsStore.load();if(!prefs.watchAlerts||prefs.notifications===false)return;
  const box=await db.get(db.STORES.kv,`watchAlertBaseline:${network}`);
  const previous=box?JSON.parse(dec.decode(await vault.decrypt(key,box))):null;
  const next=watchBaseline(wallet,snap);
  const found=previous&&Object.entries(next).some(([k,count])=>k in previous&&count>previous[k]);
  await saveWatchAlertBaseline(key,wallet,snap,network);
  if(found)await genericWatchNotice(`watch-received:${network}`,'New payments were found for watched addresses. Open the contact activity feed to review them.');
}
async function stalledAlert() {
  const prefs=await settingsStore.load();if(!prefs.watchAlerts||prefs.notifications===false||!(await vault.sessionKey()))return;
  const st=await status(prefs.network),scan=scanProgress(st,st),key=`watchStalled:${prefs.network}`;
  if(scan.paused||!scan.stalled){await db.del(db.STORES.kv,key);return;}
  if(await db.get(db.STORES.kv,key))return;
  await db.put(db.STORES.kv,key,Date.now());
  await genericWatchNotice(`watch-stalled:${prefs.network}`,'Block reading has not progressed for three minutes. Open Scans or Node health to investigate.');
}

const commands = {
  async touch() { return Boolean(await vault.sessionKey()); },
  async parametersData() {
    const {key,wallet,s}=await requireWallet();const snap=await latestSnapshot(key);if(!snap)throw new Error('NO_STATE');
    const st=await status(s.network), contacts=await readContacts(key,s.network);
    if(typeof wallet.watchExport!=='function')throw new Error('Wallet modules are out of date. Use the new compiled extension from GitHub Actions.');
    const metadata=wallet.watchExport(snap.state);
    const watch=wallet.watchList(snap.state,Date.now()).map(w=>({...w,address:metadata.find(m=>m.id===w.id)?.address}));
    const groups=portfolios(watch,contacts,snap.height);
    const activity=await readActivity(key);
    const active=await latestSend(s.network);
    const sent=activity.filter(a=>a.kind==='sent');
    if(active&&!sent.some(a=>a.id===active.id||(a.txId&&a.txId===active.view?.tx_id)))sent.unshift(active);
    const fullFeed=activityFeed(groups);
    const publicGroups=groups.map(g=>({...g,addresses:g.addresses.map(({coins,...w})=>w)}));
    return {network:s.network,theme:s.theme,status:st,scan:scanProgress(st,st),portfolios:publicGroups,feed:fullFeed.slice(0,5000),feedLimited:fullFeed.length>5000,payments:sent.slice(0,100).map(p=>paymentTimeline(p,snap.height)),restore:await readRestorePlan(key,s.network)||null,node:await db.get(db.STORES.kv,`nodeHealth:${s.network}`)||null,alerts:s.watchAlerts===true,authenticator:await authenticator.enabled()};
  },
  async scanControl({action}) {
    if(!['pause','resume','retry'].includes(action))throw new Error('Invalid scan action');
    const {s}=await requireWallet();
    pauseRequested=action==='pause';if(pauseRequested)rpc.cancelBackground();
    await db.put(db.STORES.kv,`scanPaused:${s.network}`,pauseRequested);
    await setStatus({scanPaused:pauseRequested,syncing:false,...(pauseRequested?{}:{error:null,watchError:null,scanSample:null})},s.network);
    if(!pauseRequested)scheduleFollowUp();
    return true;
  },
  async setWatchAlerts({enabled}) {
    const {key,wallet,s}=await requireWallet();
    await settingsStore.save({watchAlerts:enabled===true});
    if(enabled===true){const snap=await latestSnapshot(key);if(snap)await saveWatchAlertBaseline(key,wallet,snap,s.network);}
    return true;
  },
  async nodeHealth() {
    const {s}=await requireWallet();await wasm();const server=settingsStore.serversFor(s).sync;
    const started=Date.now();let result;
    try {
      const info=await commands.serverInfo({url:server});const latencyMs=info.latencyMs;
      const blocks=[];
      for(let h=info.height;h>Math.max(0,info.height-4);h--){
        try{blocks.push(light.blockInfo(await rpc.post(server,light.getBlocksRequest(rpc.id(),h,h),{timeoutMs:10000})));}catch{break;}
      }
      const intervals=blocks.slice(1).map((b,i)=>blocks[i].timestamp_ms-b.timestamp_ms).filter(n=>n>0);
      result={...info,ok:true,host:new URL(server).host,latencyMs,checkedAt:Date.now(),blocks,walletBlocks:blocks.length?true:null,averageBlockMs:intervals.length?intervals.reduce((a,b)=>a+b,0)/intervals.length:null};
    } catch(e){result={ok:false,checkedAt:Date.now(),error:String(e.message||e).slice(0,200)};}
    await db.put(db.STORES.kv,`nodeHealth:${s.network}`,result);return result;
  },
  async explorerBlock({height}) {
    const {s}=await requireWallet();const h=Number(height);
    if(!Number.isSafeInteger(h)||h<1)throw new Error('Enter a block height of 1 or greater');
    await wasm();return light.blockInfo(await rpc.post(settingsStore.serversFor(s).sync,light.getBlocksRequest(rpc.id(),h,h),{timeoutMs:15000}));
  },
  async assistant({question}) { return assistantAnswer(question,await commands.parametersData()); },
  async authBegin({password}) {
    const {key}=await requireWallet();await vault.checkPassword(password);return authenticator.begin(key);
  },
  async authConfirm({code}) {const {key}=await requireWallet();return authenticator.confirm(key,code);},
  async authDisable({password}) {await requireWallet();await vault.checkPassword(password);await authenticator.disable();return true;},
  async backupExport({password}) {
    const {key,wallet,s}=await requireWallet();const snap=await latestSnapshot(key);if(!snap)throw new Error('NO_STATE');
    const contacts=(await readContacts(key,s.network)).map(c=>({name:c.name,addresses:(c.addresses||[c]).map(a=>({address:a.address}))}));
    const watch=wallet.watchExport(snap.state).map(({label,viewingKey,spendKey,from})=>({label,viewingKey,spendKey,from}));
    return backup.seal({network:s.network,contacts,watch,createdAt:Date.now()},password);
  },
  async backupPreview({text,password}) {
    const {key,s}=await requireWallet();const payload=backup.validate(await backup.unseal(text,password),s.network);
    const token=crypto.randomUUID();
    await db.put(db.STORES.kv,'backup:pending',await vault.encrypt(key,enc.encode(JSON.stringify({token,payload,expires:Date.now()+600000}))));
    return {token,network:s.network,contacts:payload.contacts.length,watch:payload.watch.length};
  },
  async backupApply({token}) {
    return withState(async ({key,wallet,s,snap})=>{
      const box=await db.get(db.STORES.kv,'backup:pending');if(!box)throw new Error('Preview a backup first');
      const pending=JSON.parse(dec.decode(await vault.decrypt(key,box)));
      if(pending.token!==token||pending.expires<Date.now())throw new Error('Import preview expired');
      const payload=backup.validate(pending.payload,s.network);
      const contacts=await readContacts(key,s.network);let state=snap.state;
      for(const c of payload.contacts){
        const addresses=c.addresses.map(a=>{const address=a.address.trim().toLowerCase();const info=light.addressInfo(address,s.network);if(!info.valid)throw new Error('Backup contains an invalid receiving address');return {address,kind:info.kind};});
        if(new Set(addresses.map(a=>a.kind)).size!==addresses.length)throw new Error('Contact has duplicate address types');
        const matches=contacts.filter(old=>(old.addresses||[old]).some(a=>addresses.some(b=>a.address===b.address)));
        if(matches.length){
          if(matches.length!==1||addresses.some(a=>!(matches[0].addresses||[matches[0]]).some(b=>a.address===b.address)))throw new Error('Contact conflict: edit overlapping contacts before importing');
          continue;
        }
        contacts.push({id:crypto.randomUUID(),name:c.name,...addresses[0],addresses,createdAt:Date.now()});
      }
      const existing=wallet.watchExport(state);
      for(const w of payload.watch){
        const found=existing.find(x=>x.viewingKey.toLowerCase()===w.viewingKey.trim().toLowerCase());
        if(found){if((found.spendKey||'')!==(w.spendKey||''))throw new Error('Watch key conflict: existing spend visibility differs');continue;}
        state=wallet.watchAdd(state,w.label,w.viewingKey,w.spendKey||undefined,w.from);
        existing.push(w);
      }
      if(contacts.length>1000)throw new Error('Contact limit exceeded');
      contacts.sort((a,b)=>a.name.localeCompare(b.name));
      const [contactBox,stateBox]=await Promise.all([vault.encrypt(key,enc.encode(JSON.stringify(contacts))),vault.encrypt(key,state)]);
      await db.putAcross([{store:db.STORES.kv,key:`contacts:${s.network}`,value:contactBox},{store:db.STORES.snapshots,key:snapKey(s.network,snap.height),value:stateBox}]);
      snapCache={key,network:s.network,height:snap.height,state};
      await db.del(db.STORES.kv,'backup:pending');
      const need=wallet.watchNeeds(state);await setStatus({watchBehind:need?{at:need[0]-1,end:need[1]}:null,watchError:null});
      notify('watch');scheduleFollowUp();return {out:true};
    });
  },

  async state() {
    await migrateStorage();
    const s = await settingsStore.load();
    return {
      exists: await vault.exists(),
      authenticator: await authenticator.enabled(),
      unlocked: Boolean(await vault.sessionKey()),
      settings: s,
      tor: { ...(await torState()), hosts: torHosts(s) },
      status: await status(s.network),
      send: await latestSend(s.network),
      networks: Object.fromEntries(
        await Promise.all(settingsStore.NETWORKS.map(async (n) => [n, (await snapHeights(n)).length > 0])),
      ),
    };
  },

  async newPhrase() {
    await wasm();
    return light.phraseFromEntropy(crypto.getRandomValues(new Uint8Array(24)));
  },

  async checkPhrase({ phrase, network = 'main' }) {
    await wasm();
    const w = new light.LightWallet(String(phrase).trim().toLowerCase().split(/\s+/).join(' '), network);
    w.free?.();
    return true;
  },

  async create({ password, phrase, network, birthday, birthdayDate, restoreMode = 'private', nodeUrl }) {
    return exclusiveNow(async () => {
    await ensureNoActivePayment();
    if (!password || password.length < 10) throw new Error('Use a password of at least 10 characters');
    await wasm();
    const clean = String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
    const wallet = new light.LightWallet(clean, network); // validates the phrase
    let prev = await settingsStore.load();
    const restoring = (birthday!==undefined && birthday!==null && birthday!=='') || Boolean(birthdayDate);
    if (restoring && restoreMode === 'node') {
      // Fast and private: the user's own node does the lookups and keeps
      // serving this network afterwards.
      const url = rpc.normalizeServer(nodeUrl || 'http://127.0.0.1:9797/');
      prev = { ...prev, servers: { ...prev.servers, [network]: { sync: url, broadcast: url } } };
    }
    const server = settingsStore.serversFor(prev, network).sync;
    if (!server) throw new Error(`Add a ${network} server in Settings > Servers first.`);
    // New wallet: start at the tip. Restore: start at the birthday (height or date).
    const start = await startHeight(server, { birthday, birthdayDate });
    const state = await initialState(wallet, server, start);
    const premine = start===0 && wallet.summary(state,Date.now()).utxos.length>0;
    wallet.free?.();
    dropWallet();
    // The spend index and the archive are public chain data, not the wallet's: keep them.
    await db.wipeExcept(['spends:', 'arch:']);
    dropArchive();
    await chrome.storage.session.clear();
    // The start height is not kept in plain settings: it would date the wallet.
    await settingsStore.save({ ...prev, network, birthday: null });
    const key = await vault.create(password, clean);
    await saveSnapshot(key, start, state, network);
    const fastPending = restoring && ['fast', 'node'].includes(restoreMode) && !premine ? restoreMode : null;
    await saveRestorePlan(key,network,{mode:restoreMode,pending:Boolean(fastPending),failure:premine&&restoreMode!=='private'?'premine-full-scan':null,fallback:premine?'private':null});
    await setStatus({ height: start, startHeight: start, restored: restoring, syncing: true, fastPending }, network);
    await bumpAutoLock();
    notify('walletChanged');
    syncOnce().catch(() => {});
    return { start };
    });
  },

  async unlock({ password, authCode }) {
    return exclusiveNow(async () => {
    if (!password) throw new Error('Enter your password');
    if (!(await vault.exists())) throw new Error('No wallet on this device. Create or restore one.');
    await vault.unlock(password, key => authenticator.authorize(key, authCode));
    await bumpAutoLock();
    sealOldSends().catch(() => {});
    syncOnce().catch(() => {}).finally(() => resumeSends().catch(() => {}));
    return true;
    });
  },

  async lock() {
    return exclusiveNow(async () => { await vault.lock(); dropWallet(); notify('locked'); return true; });
  },

  /** Everything the home screen shows, from one decrypted state. */
  async home() {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    const [activity, contacts, privacy] = await Promise.all([
      readActivity(key),
      readContacts(key),
      commands.privacy().catch(() => null),
    ]);
    return {
      summary: wallet.summary(snap.state, Date.now()),
      addresses: { generation: wallet.addressAt('generation', 0), 'ec-hybrid': wallet.addressAt('ec-hybrid', 0) },
      activity,
      contacts,
      privacy,
      watch: wallet.watchList(snap.state, Date.now()).map(w=>({...w,coinCount:w.coins.length,coins:w.coins.slice(0,6)})),
      hiddenWatchIds:await readHiddenWatch(key),
    };
  },

  async summary() {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    return wallet.summary(snap.state, Date.now());
  },

  async privacy() {
    const { key, s } = await requireWallet();
    await wasm();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    let spends = null;
    if (s.exactPrivacy !== false) spends = await spendIndex(s.network, snap.height);
    const report = light.privacyReport(snap.state, Date.now(), spends ? new Float64Array(spends) : undefined);
    const st = await status();
    report.spendIndex = st.spendIndex || null;
    const srv = settingsStore.serversFor(s);
    let sameServer = true;
    let ownNode = false;
    try {
      const a = new URL(srv.sync).hostname;
      const b = new URL(srv.broadcast).hostname;
      sameServer = a === b;
      ownNode = ['localhost', '127.0.0.1'].includes(a) && ['localhost', '127.0.0.1'].includes(b);
    } catch {
      /* missing server: reported elsewhere */
    }
    const fast = await db.get(db.STORES.kv, `fastRestored:${s.network}`);
    let fastRestored = null;
    if (fast) {
      let host = '';
      try {
        host = new URL(fast.server).hostname;
      } catch {
        /* keep empty */
      }
      fastRestored = { host, own: fast.mode === 'node' || ['localhost', '127.0.0.1'].includes(host), at: fast.at };
    }
    return { ...report, sameServer: sameServer && !ownNode, ownNode, fastRestored, priceLookup: s.priceLookup !== false && s.currency !== 'off' };
  },

  async sync() {
    await syncOnce();
    resumeSends().catch(() => {});
    return status();
  },

  /**
   * The one address of `kind` for this wallet: index 0, the same in every
   * Neptune wallet. Derived from the seed alone, so it never waits for a sync.
   */
  async receive({ kind = 'generation' } = {}) {
    const { wallet } = await requireWallet();
    return { index: 0, address: wallet.addressAt(kind, 0), kind };
  },

  async qr({ text, dark = '#0b1220', bg = '#ffffff' }) {
    await wasm();
    return light.qrSvg(text, dark, bg);
  },

  async addressInfo({ text }) {
    await wasm();
    return light.addressInfo(String(text || ''), await currentNetwork());
  },

  async price() {
    const s = await settingsStore.load();
    if (s.priceLookup === false || s.currency === 'off') return null; // no request at all
    return fetchPrice();
  },

  async priceHistory() {
    const s = await settingsStore.load();
    if (s.priceLookup === false || s.currency === 'off' || s.network !== 'main') return null;
    return fetchPriceHistory(s.currency);
  },

  async testServer({ url }) {
    await wasm();
    return fetchHeight(rpc.normalizeServer(url));
  },

  /** What a server offers: its tip, its network, and the optional features
   *  the wallet can use (fast restore via the UTXO index). */
  async serverInfo({ url }) {
    const server = rpc.normalizeServer(url);
    const pingStarted = Date.now();
    const height = await fetchHeight(server);
    const latencyMs = Date.now() - pingStarted;
    const probe = async (method, params) => {
      try {
        const text = await rpc.post(server, JSON.stringify({ jsonrpc: '2.0', id: rpc.id(), method, params }), { timeoutMs: 15_000 });
        return JSON.parse(text).result ?? null;
      } catch {
        return undefined;
      }
    };
    const net = await probe('node_network', []);
    await wasm();
    if(typeof light.fastProbeRequests!=='function'||typeof light.validateFastProbeResponse!=='function')throw new Error('Wallet modules are out of date. Use the new compiled extension from GitHub Actions.');
    const firstProbeId=rpc.id();rpc.id();const requests=light.fastProbeRequests(firstProbeId);
    const capabilities={};
    for(const [name,body] of Object.entries(requests)) {
      try {
        const text=await rpc.post(server,body,{timeoutMs:BLOCKS_TIMEOUT_MS});
        light.validateFastProbeResponse(name,text);
        const parsed=JSON.parse(text);if(!Object.hasOwn(parsed,'result'))throw new Error('Response has no result');
        capabilities[name]={supported:true,error:null};
      } catch(e) {
        const message=String(e.message||e);
        capabilities[name]={supported:/-32601|method not found|index.*(?:disabled|not enabled|not available)/i.test(message)?false:null,error:message.slice(0,300)};
      }
    }
    let host = '';
    try {
      host = new URL(server).hostname;
    } catch {
      /* keep empty */
    }
    return {
      height, latencyMs,
      network: typeof net?.network === 'string' ? net.network : null,
      own: ['localhost', '127.0.0.1'].includes(host),
      fastRestore: capabilities.flags.supported===false||capabilities.proofs.supported===false?false:capabilities.flags.supported===true&&capabilities.proofs.supported===true?true:null,
      fastCapabilities:capabilities,
      // neptune-core has no endpoint yet for proving help (a proof collection
      // without chunk data, or lock-script-only proving); every send is a
      // full proof collection made in the browser.
      proving: 'full',
    };
  },

  async proofReport() {
    return (await db.get(db.STORES.kv, 'proofReport')) || null;
  },

  async maxSendable({ fee, fromKind = 'any' }) {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    return wallet.maxSendable(snap.state, fee, Date.now(), fromKind);
  },

  async send(req) {
    await requireWallet();
    await wasm();
    if (await db.get(db.STORES.kv, `scanPaused:${await currentNetwork()}`)) throw new Error('Resume scanning before sending');
    const info = light.addressInfo(String(req.to || ''), await currentNetwork());
    if (!info.valid) throw new Error(info.error || 'Not a valid address');
    return startSend({ ...req, toKind: info.kind });
  },

  async retrySend({ id }) {
    const rec = await getSend(id);
    if (!rec) throw new Error('Payment not found');
    return commands.send({ to: rec.to, amount: rec.amount, fee: rec.fee, fromKind: rec.fromKind, waitForFreshBlock: false });
  },

  async cancelSend({ id }) {
    await cancelSend(id);
    return true;
  },

  async testNotice() {
    await pushNotice('test');
    return true;
  },

  async contacts() {
    const { key } = await requireWallet();
    return readContacts(key);
  },

  async saveContact({ id, name, address, address2 }) {
    return exclusiveNow(async () => {
    const { key } = await requireWallet();
    await wasm();
    const clean = String(address || '').trim().toLowerCase();
    const label = String(name || '').trim().slice(0, 40);
    if (!label) throw new Error('NAME_REQUIRED');
    const info = light.addressInfo(clean, await currentNetwork());
    if (!info.valid) throw new Error(info.error || 'Not a valid address');
    const second = String(address2 || '').trim().toLowerCase();
    const addresses = [{ address: clean, kind: info.kind }];
    if (second) {
      const extra = light.addressInfo(second, await currentNetwork());
      if (!extra.valid) throw new Error(extra.error || 'Not a valid second address');
      if (extra.kind === info.kind) throw new Error('Use one Generation and one Hybrid address');
      addresses.push({ address: second, kind: extra.kind });
    }
    const list = await readContacts(key);
    if (list.some((c) => c.id !== id && (c.addresses || [c]).some((a) => addresses.some((b) => a.address === b.address)))) throw new Error('DUPLICATE');
    if (list.length >= 1000 && !list.some(c=>c.id===id)) throw new Error('Contact limit exceeded');
    const existing = list.find((c) => c.id === id);
    if (existing) Object.assign(existing, { name: label, address: clean, kind: info.kind, addresses, updatedAt: Date.now() });
    else list.push({ id: crypto.randomUUID(), name: label, address: clean, kind: info.kind, addresses, createdAt: Date.now() });
    list.sort((a, b) => a.name.localeCompare(b.name));
    await writeContacts(key, list);
    return list;
    });
  },

  async deleteContact({ id }) {
    return exclusiveNow(async () => {
    const { key } = await requireWallet();
    const list = (await readContacts(key)).filter((c) => c.id !== id);
    await writeContacts(key, list);
    return list;
    });
  },

  async setNote({ id, note }) {
    const { key } = await requireWallet();
    const list = await readActivity(key);
    const e = list.find((x) => x.id === id);
    if (!e) throw new Error('Payment not found');
    e.note = String(note || '').slice(0, 200);
    await writeActivity(key, list);
    return e;
  },

  async dismissSend({ id }) {
    const rec = await getSend(id);
    if (rec && ['failed', 'done', 'needs-lustration'].includes(rec.status)) {
      rec.status = rec.status === 'needs-lustration' ? 'failed' : rec.status;
      rec.dismissed = true;
      await saveSend(rec);
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
    }
    return true;
  },

  async latestSend() {
    return latestSend(await currentNetwork());
  },

  async acceptLustrationAndRetry({ id }) {
    const rec = await getSend(id);
    rec.acceptLustration = true;
    rec.status = 'starting';
    rec.error = null;
    await saveSend(rec);
    runSend(id).catch(() => {});
    return true;
  },

  async activity() {
    const { key } = await requireWallet();
    return readActivity(key);
  },

  async saveSettings(patch) {
    const clean = settingsStore.validatePatch(patch);
    if (clean.servers) {
      const prev = await settingsStore.load();
      const servers = { ...prev.servers };
      for (const [n, v] of Object.entries(clean.servers)) {
        servers[n] = {
          sync: v.sync ? rpc.normalizeServer(v.sync) : '',
          broadcast: v.broadcast ? rpc.normalizeServer(v.broadcast) : v.sync ? rpc.normalizeServer(v.sync) : '',
        };
      }
      clean.servers = servers;
    }
    delete clean.network; // use switchNetwork
    const saved = await settingsStore.save(clean);
    // Servers or Tor changed: the proxy script must name the right hosts.
    if ('tor' in clean || 'torPort' in clean || clean.servers) await applyTor({ check: 'tor' in clean || 'torPort' in clean }).catch(() => {});
    return saved;
  },

  async torStatus() {
    const s = await settingsStore.load();
    return { ...(await torState()), hosts: torHosts(s) };
  },

  async checkTor() {
    const s = await settingsStore.load();
    return { ...(await applyTor()), hosts: torHosts(s) };
  },

  async switchNetwork({ network }) {
    if (!settingsStore.NETWORKS.includes(network)) throw new Error('Unknown network');
    await migrateStorage();
    const s = await settingsStore.load();
    if (network === s.network) return { network };
    const server = settingsStore.serversFor(s, network).sync;
    if (!server) throw new Error('NEED_SERVER');
    const key = await vault.sessionKey();
    if (!key) throw new Error('locked');
    return exclusiveNow(async () => {
      await wasm();
      if (!(await snapHeights(network)).length) {
        // First visit to this network: start at its tip.
        const phrase = await vault.phrase(key);
        const w = new light.LightWallet(phrase, network);
        try {
          const tip = await fetchHeight(server);
          await saveSnapshot(key, tip, await initialState(w, server, tip), network);
          await setStatus({ height: tip, tip, startHeight: tip, lastTipChangeAt: Date.now() }, network);
        } finally {
          w.free?.();
        }
      }
      await settingsStore.save({ network });
      dropWallet();
      syncOnce().catch(() => {});
      return { network };
    });
  },

  /** Scan again from an earlier point: finds payments a restore without a date missed. */
  async rescan({ birthday, birthdayDate, restoreMode }) {
    if(restoreMode && !['private','fast','node'].includes(restoreMode)) throw new Error('Invalid restore mode');
    await ensureNoActivePayment();
    const { key, wallet, s } = await requireWallet();
    const server = settingsStore.serversFor(s).sync;
    if (!server) throw new Error('NEED_SERVER');
    const start = await startHeight(server, { birthday, birthdayDate });
    await exclusiveNow(async () => {
      const current = await requireWallet();
      if(current.wallet !== wallet || current.s.network !== s.network) throw new Error('Wallet or network changed. Try the rescan again.');
      const old = await latestSnapshot(key);
      let state = await initialState(wallet, server, start);
      // Waiting coins and watch-only addresses survive the new scan.
      if (old) state = wallet.carryOver(old.state, state);
      await dropSnapshots(s.network);
      await saveSnapshot(key, start, state);
      // In node mode, a full rescan uses the node's UTXO index when it has
      // one: fast, and only your own node is asked.
      let local = false;
      try {
        local = ['localhost', '127.0.0.1'].includes(new URL(server).hostname);
      } catch {
        local = false;
      }
      // A scan from genesis that already found premine coins stays a full
      // scan: the fast restore cannot see unannounced coins.
      const premine = start <= 0 && wallet.summary(state, Date.now()).utxos.length > 0;
      const selected = restoreMode || (local?'node':'private');
      const fastPending = start <= 1 && selected!=='private' && !premine ? selected : null;
      await saveRestorePlan(key,s.network,{mode:selected,pending:Boolean(fastPending),failure:premine&&selected!=='private'?'premine-full-scan':null});
      await db.put(db.STORES.kv, `scanPaused:${s.network}`, false); pauseRequested=false;
      await setStatus({ height: start, startHeight: start, syncing: true, error: null, restored: true, fastPending, fastFailed:premine&&selected!=='private'?'premine-full-scan':null, fastFailureDetail:null, watchError:null, scanPaused:false });
    });
    syncOnce().catch(() => {});
    return { start };
  },

  async restoreCurrent({mode='private'}) {
    const {s}=await requireWallet();
    if(mode==='node' && !isLocalHost(new URL(settingsStore.serversFor(s).sync).hostname))throw new Error('Configure your local node in Servers before choosing this option');
    return commands.rescan({birthday:0,restoreMode:mode}); },

  async heightForDate({ date }) {
    const s = await settingsStore.load();
    return heightAtDate(settingsStore.serversFor(s).sync, Number(date));
  },

  // ------------------------------------------------------- watch-only --

  async watchSetHidden({id,hidden}) {
    return withState(async({key,wallet,s,snap})=>{
      const number=Number(id);if(!Number.isSafeInteger(number)||!wallet.watchList(snap.state,Date.now()).some(w=>w.id===number))throw new Error('Watched address not found');
      const ids=new Set(await readHiddenWatch(key,s.network));if(hidden===true)ids.add(number);else ids.delete(number);
      await writeHiddenWatch(key,s.network,[...ids]);notify('watch');return {out:true};
    });
  },

  async watchList() {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    const st = await status();
    const need = wallet.watchNeeds(snap.state);
    return { list: wallet.watchList(snap.state, Date.now()).map(w=>({...w,coinCount:w.coins.length,coins:w.coins.slice(0,6)})), hiddenIds:await readHiddenWatch(key), height: snap.height, behind: need ? { at: need[0] - 1, end: need[1] } : null, error: st.watchError || null };
  },

  /** `from`: 'start' (block 1), 'now' (next block) or a block height. */
  async watchAdd({ label, viewingKey, spendKey, viewingKey2, spendKey2, from, jobId }) {
    await withState(async ({ wallet, snap }) => {
      let fromHeight = 1;
      if (from === 'now') fromHeight = snap.height + 1;
      else if (from !== 'start' && from != null && from !== '') {
        fromHeight = Math.floor(Number(from));
        if (!Number.isFinite(fromHeight) || fromHeight < 1) throw new Error('Not a block height');
      }
      const spend = spendKey && String(spendKey).trim() ? String(spendKey).trim() : undefined;
      let state = wallet.watchAdd(snap.state, String(label || ''), String(viewingKey || ''), spend, fromHeight);
      if (String(viewingKey2 || '').trim()) {
        state = wallet.watchAdd(state, String(label || ''), String(viewingKey2).trim(), String(spendKey2 || '').trim() || undefined, fromHeight);
      }
      // Tell the next sync run there is catching up to do.
      const need = wallet.watchNeeds(state);
      await setStatus({ watchBehind: need ? { at: need[0] - 1, end: need[1] } : null, watchError: null });
      return { state };
    }, jobId);
    notify('watch');
    scheduleFollowUp();
    return true;
  },

  async watchRemove({ id }) {
    await withState(async ({ key, wallet, s, snap }) => {
      await writeHiddenWatch(key,s.network,(await readHiddenWatch(key,s.network)).filter(x=>x!==Number(id)));
      const state = wallet.watchRemove(snap.state, Number(id));
      const need = wallet.watchNeeds(state);
      await setStatus({ watchBehind: need ? { at: need[0] - 1, end: need[1] } : null, watchError: null });
      return { state };
    });
    notify('watch');
    return true;
  },

  /** This wallet's viewing keys (and spend keys), after the password. */
  async viewingKeys({ password }) {
    try {
      await vault.checkPassword(password);
    } catch {
      throw new Error('Wrong password');
    }
    const { wallet } = await requireWallet();
    return wallet.viewingKeys();
  },

  // ------------------------------------------------- registered coins --

  async claimCheck({ text }) {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    return wallet.claimDecode(snap.state, String(text || ''));
  },

  async claimRegister({ text, jobId }) {
    const s = await settingsStore.load();
    const claim = await withState(async ({ wallet, snap }) => {
      const out = wallet.claimRegister(snap.state, String(text || ''));
      return { state: out.state, out: out.claim };
    }, jobId);
    if (s.localArchive) await setStatus({ adoptPending: true });
    syncOnce().catch(() => {});
    return claim;
  },

  async claimRemove({ record }) {
    await withState(async ({ wallet, snap }) => ({ state: wallet.claimRemove(snap.state, String(record)) }));
    return true;
  },

  async waiting() {
    const { key, wallet, s } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    const st = await status();
    return { list: wallet.expectedList(snap.state), archive: s.localArchive ? st.archive || { state: 'building' } : null, lastAdopted: st.lastAdopted || null };
  },

  /**
   * Look for this wallet's premine allocations, one key at a time (with
   * progress), then register what was found. The archive (or a scan from
   * genesis) then adds them.
   */
  async findPremine({ jobId }) {
    const { wallet, s } = await requireWallet();
    jobProgress(jobId, { phase: 'genesis', done: 0, total: 10 });
    await sleep(0);
    const hits = [];
    for (let i = 0; i < 10; i++) {
      cancelled(jobId);
      if (wallet.premineForKey(i) > 0) hits.push(i);
      jobProgress(jobId, { phase: 'keys', done: i + 1, total: 10 });
      await sleep(0); // let the progress message go out
    }
    if (!hits.length) return { found: 0, archive: Boolean(s.localArchive) };
    const found = await withState(async ({ wallet: w, snap }) => {
      const out = w.registerPremine(snap.state, new Float64Array(hits));
      return { state: out.found ? out.state : null, out: out.found };
    }, jobId);
    if (found && s.localArchive) await setStatus({ adoptPending: true });
    if (found) syncOnce().catch(() => {});
    return { found, archive: Boolean(s.localArchive) };
  },

  /** Stop a job that is still waiting (watch-only add, registration, premine). */
  async cancelJob({ jobId }) {
    if (!jobId) return false;
    cancelledJobs.add(jobId);
    setTimeout(() => cancelledJobs.delete(jobId), 120_000);
    return true;
  },

  // ---------------------------------------------------------- archive --

  async archiveStatus() {
    const s = await settingsStore.load();
    const st = await status();
    return { on: Boolean(s.localArchive), lag: ARCHIVE_LAG, walletHeight: st.height ?? null, estimate: await archiveEstimate(s).catch(() => null), ...(st.archive || {}) };
  },

  async archiveSet({ on }) {
    const s = await settingsStore.save({ localArchive: Boolean(on) });
    if (!on) {
      dropArchive();
      await db.delPrefix(db.STORES.kv, 'arch:');
      await setStatus({ archive: null, adoptPending: false });
    } else {
      await setStatus({ archive: { state: 'building', height: 0, target: null, at: Date.now() }, adoptPending: true });
      syncOnce().catch(() => {});
    }
    return { on: Boolean(s.localArchive) };
  },

  /** Rebuild every commitment from the stored leaves and chunks. */
  async archiveCheck() {
    const s = await settingsStore.load();
    if (!s.localArchive) throw new Error('The local archive is off');
    return keepAlive(() =>
      exclusiveNow(async () => {
        const a = await loadArchive(s.network);
        a.check();
        await setArchiveStatus({ checkedAt: Date.now(), checkedHeight: a.height() });
        return { ok: true, height: a.height(), size: a.sizeBytes() };
      }),
    );
  },

  async revealPhrase({ password }) {
    try {
      return await vault.checkPassword(password);
    } catch {
      throw new Error('Wrong password');
    }
  },

  async reset() {
    return exclusiveNow(async () => {
    await ensureNoActivePayment();
    await vault.lock();
    dropWallet();
    dropArchive();
    const s = await settingsStore.load();
    await db.wipe();
    // Keep interface and server preferences; everything about the wallet goes.
    await settingsStore.save({ ...s, birthday: null, network: 'main' });
    await chrome.storage.session.clear();
    await closeOffscreenIfIdle().catch(() => {});
    notify('locked');
    return true;
    });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  if (!trustedMessage(_sender, chrome.runtime.id, msg)) { sendResponse({ok:false,error:'Unauthorized extension message'}); return false; }

  // From the offscreen page.
  if (msg.type === 'proveProgress') {
    getSend(msg.sendId).then((rec) => {
      if (!rec || rec.status !== 'proving') return;
      rec.jobsDone = msg.done;
      rec.lastJob = msg.label;
      return saveSend(rec);
    });
    return false;
  }
  if (msg.type === 'proved') {
    getSend(msg.sendId).then((rec) => {
      if (!rec || rec.status !== 'proving') return;
      rec.status = 'submitting';
      rec.jobsDone = rec.jobCount;
      return saveSend(rec);
    });
    return false;
  }
  if (msg.type === 'submitted') {
    onSubmitted(msg.sendId).catch(() => {});
    return false;
  }
  if (msg.type === 'proveFailed') {
    getSend(msg.sendId).then(async (rec) => {
      if (!rec || ['done', 'failed'].includes(rec.status)) return;
      await failSend(rec, `Proving failed: ${msg.error}. Try fewer proving workers in Settings > Advanced, or a payment that uses fewer coins.`);
    });
    return false;
  }

  // From the popup.
  const fn = Object.hasOwn(commands, msg.cmd) ? commands[msg.cmd] : null;
  if (!fn) {
    sendResponse({ ok: false, error: `unknown command ${msg.cmd}` });
    return false;
  }
  keepAlive(async () => {
    const args = msg.args || {};
    const sensitive = new Set(['send','retrySend','acceptLustrationAndRetry','revealPhrase','viewingKeys','backupExport','backupPreview','backupApply','authDisable','rescan','restoreCurrent','reset','create']);
    if (sensitive.has(msg.cmd) && await authenticator.enabled()) {
      const key = await vault.sessionKey();
      if (!key) throw new Error('Unlock the wallet before this action');
      await authenticator.authorize(key,args.authCode);
    }
    const clean = {...args}; delete clean.authCode;
    if (msg.cmd === 'unlock') clean.authCode = args.authCode;
    const interactive = new Set(['touch','send','retrySend','acceptLustrationAndRetry','saveSettings','saveContact','deleteContact','setNote','watchAdd','watchRemove','watchSetHidden','scanControl','setWatchAlerts','authBegin','authConfirm','authDisable','backupExport','backupPreview','backupApply','claimRegister','claimRemove','switchNetwork','rescan','restoreCurrent','archiveSet']);
    if (interactive.has(msg.cmd) && await vault.sessionKey()) await bumpAutoLock();
    const epoch = walletEpoch;
    const result = await fn(clean);
    if(msg.cmd==='state' && (epoch!==walletEpoch || !(await vault.sessionKey()))) {result.unlocked=false;result.send=null;}
    if (['home','summary','privacy','watchList','activity','parametersData','assistant','contacts','saveContact','deleteContact','latestSend','maxSendable','waiting','claimCheck','findPremine','receive','viewingKeys','revealPhrase','backupExport','backupPreview','authBegin','authConfirm'].includes(msg.cmd) && (epoch !== walletEpoch || !(await vault.sessionKey()))) throw new Error('locked');
    return result;
  })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// ---------------------------------------------------------------- alarms ----

// The wallet lives in Chrome's side panel: a click on the toolbar icon opens
// it next to the page. Setting up a wallet takes a full tab.
function panelOnClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
panelOnClick();

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  panelOnClick();
  if (details?.reason === 'install' && !(await vault.exists().catch(() => false))) {
    Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') })).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  // The proxy setting survives a restart; check Tor is still there.
  applyTor().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autolock') {
    await exclusiveNow(async () => { await vault.lock(); dropWallet(); notify('locked'); });
    return;
  }
  if (alarm.name === 'sync') {
    if (!(await vault.sessionKey())) return;
    await maybeRecheckTor().catch(() => {});
    await syncOnce().catch(() => {});
    await stalledAlert().catch(() => {});
    await resumeSends().catch(() => {});
  }
});
