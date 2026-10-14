import * as db from './db.js';

export const NETWORKS = ['main', 'testnet', 'testnet-mock'];

/** Public servers known to work, per network. Empty: the user adds one. */
export const DEFAULT_SERVERS = {
  main: {
    // Blocks are fetched from here. It learns only which heights you ask for.
    sync: 'https://wallet.neptunefundamentals.org/',
    // Transactions are sent here. A different operator than the sync server
    // means no single server sees both your syncing and your transaction.
    broadcast: 'https://wallet.neptunefundamentals.org/',
  },
  testnet: { sync: '', broadcast: '' },
  'testnet-mock': { sync: '', broadcast: '' },
};

export const DEFAULTS = {
  network: 'main',
  servers: DEFAULT_SERVERS,
  workers: 'auto',
  autoLockMinutes: 15,
  // Start proving right after a block arrives, to finish before the next one.
  waitForFreshBlock: true,
  lowMemoryProving: 'auto', // 'auto' | 'on' | 'off'
  // Route the wallet's servers and price lookups through Tor on this computer.
  tor: false,
  torPort: 9150, // Tor Browser; the tor service uses 9050
  // Keep every block's spends (public data) for exact anonymity counts.
  exactPrivacy: true,
  // Keep the whole archival mutator set (tens of MB) on this device, so
  // membership proofs and spend checks never need a server.
  localArchive: false,
  birthday: null,
  // Receiving address kind shown first: 'generation' (post-quantum, long) or
  // 'ec-hybrid' (short; notification privacy relies on elliptic curves).
  addressKind: 'generation',
  // Interface: 'auto' follows the system / browser.
  theme: 'auto',
  language: 'auto',
  // Value shown under the balance: 'off', 'usdt', 'usd', 'eur' or 'gbp'.
  currency: 'usdt',
  // Ask CoinGecko for the NPT price. CoinGecko then sees this computer's IP.
  priceLookup: true,
  // Chrome notifications: payment sent, received, confirmed, failed.
  notifications: true,
  notificationDetails: false,
};

/** Settings written by versions before 0.3 kept one server pair for the wallet's network. */
function migrate(s) {
  const out = { ...DEFAULTS, ...s };
  out.servers = {};
  for (const n of NETWORKS) out.servers[n] = { ...DEFAULT_SERVERS[n], ...(s.servers?.[n] || {}) };
  if (s.syncServer && !s.servers) {
    out.servers[out.network] = { sync: s.syncServer, broadcast: s.broadcastServer || s.syncServer };
  }
  delete out.syncServer;
  delete out.broadcastServer;
  return out;
}

export async function load() {
  return migrate((await db.get(db.STORES.kv, 'settings')) || {});
}

export async function save(patch) {
  const next = migrate({ ...(await load()), ...patch });
  await db.put(db.STORES.kv, 'settings', next);
  return next;
}

/** The server pair for a network (the wallet's current one by default). */
export function serversFor(s, network = s.network) {
  return s.servers?.[network] || { sync: '', broadcast: '' };
}

/** Worker count: about one per 2 GB of device memory, at most 4, leaving a core free. */
export function workerCount(setting, deviceMemoryGb, cores) {
  if (setting !== 'auto') return Math.max(1, Number(setting) || 1);
  const byMemory = Math.floor((deviceMemoryGb || 4) / 2);
  const byCores = Math.max(1, (cores || 2) - 1);
  return Math.max(1, Math.min(4, byMemory, byCores));
}

/** Validate UI settings before they reach persistent storage. */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings');
  const extra = new Set(['watchScanMode','watchAlerts']);
  const clean = {};
  const choices = {theme:['auto','light','dark'],language:['auto','en','fr','ar'],currency:['off','usdt','usd','eur','gbp'],addressKind:['generation','ec-hybrid'],lowMemoryProving:['auto','on','off'],watchScanMode:['private','fast']};
  for (const [key,value] of Object.entries(patch)) {
    if (key === 'network' || key === 'birthday' || (!Object.hasOwn(DEFAULTS,key) && !extra.has(key))) throw new Error('Unsupported setting');
    if (choices[key] && !choices[key].includes(value)) throw new Error(`Invalid ${key}`);
    if (['tor','exactPrivacy','localArchive','priceLookup','notifications','waitForFreshBlock','watchAlerts','notificationDetails'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    if (key === 'torPort' && (!Number.isSafeInteger(value) || value < 1 || value > 65535)) throw new Error('Invalid Tor port');
    if (key === 'autoLockMinutes' && (!Number.isFinite(value) || value < 1 || value > 240)) throw new Error('Auto-lock must be 1–240 minutes');
    if (key === 'workers' && value !== 'auto' && (!Number.isSafeInteger(Number(value)) || Number(value)<1 || Number(value)>16)) throw new Error('Invalid worker count');
    if (key === 'servers') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid servers');
      for (const [network,server] of Object.entries(value)) {
        if (!NETWORKS.includes(network) || !server || typeof server!=='object' || Object.keys(server).some(k=>!['sync','broadcast'].includes(k)) || Object.values(server).some(v=>typeof v!=='string'||v.length>2048)) throw new Error('Invalid server settings');
      }
    }
    clean[key]=value;
  }
  return clean;
}
