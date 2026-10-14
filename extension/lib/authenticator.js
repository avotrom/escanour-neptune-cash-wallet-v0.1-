// Local TOTP approval guard. This does not add a second encryption factor.
import * as db from './db.js';
import * as vault from './vault.js';
const enc = new TextEncoder();
const dec = new TextDecoder();
const CONFIG = 'authenticator:v1';
const PENDING = 'authenticator:pending';
let queue = Promise.resolve();
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function decode32(text) {
  let bits = 0, value = 0; const out = [];
  for (const ch of text) { const n = alphabet.indexOf(ch); if (n < 0) throw new Error('Invalid authenticator secret'); value = (value << 5) | n; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export async function totp(secret, step, digits = 6) {
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey('raw', decode32(secret), {name:'HMAC', hash:'SHA-1'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  const offset = mac[mac.length - 1] & 15;
  const n = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(n % (10 ** digits)).padStart(digits, '0');
}
function same(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))), b => b.toString(16).padStart(2,'0')).join(''); }
const pack = (key, value) => vault.encrypt(key, enc.encode(JSON.stringify(value)));
const unpack = async (key, box) => JSON.parse(dec.decode(await vault.decrypt(key, box)));
export async function enabled() { return Boolean(await db.get(db.STORES.kv, CONFIG)); }
export async function begin(key) {
  return serial(async () => {
    if (await enabled()) throw new Error('Authenticator is already enabled');
    const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
    await db.put(db.STORES.kv, PENDING, await pack(key, {secret, expires: Date.now() + 600_000, failures:0}));
    return {secret, uri:`otpauth://totp/Escanour:Wallet?secret=${secret}&issuer=Escanour&algorithm=SHA1&digits=6&period=30`};
  });
}
async function matchingStep(secret, code, last = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const n of [step, step - 1, step + 1]) if (n > last && same(await totp(secret, n), code)) return n;
  return null;
}
export async function confirm(key, code) {
  return serial(async () => {
    if (await enabled()) throw new Error('Authenticator is already enabled');
    const box = await db.get(db.STORES.kv, PENDING);
    if (!box) throw new Error('Start authenticator setup first');
    const pending = await unpack(key, box);
    if (pending.expires < Date.now() || pending.failures >= 5) throw new Error('Setup expired. Start again.');
    const step = await matchingStep(pending.secret, String(code || '').trim());
    if (step === null) { pending.failures++; await db.put(db.STORES.kv,PENDING,await pack(key,pending)); throw new Error('Invalid code'); }
    const recovery = Array.from({length:8}, () => base32(crypto.getRandomValues(new Uint8Array(16))));
    const config = {secret:pending.secret,lastStep:step,recovery:await Promise.all(recovery.map(digest))};
    await db.put(db.STORES.kv,CONFIG,{box:await pack(key,config), failures:0, blockedUntil:0});
    await db.del(db.STORES.kv,PENDING);
    return recovery;
  });
}
export async function authorize(key, code) {
  return serial(async () => {
    const saved = await db.get(db.STORES.kv,CONFIG); if (!saved) return;
    if (saved.blockedUntil > Date.now()) throw new Error('Too many codes. Wait one minute and retry.');
    if (!code) throw new Error('AUTH_CODE_REQUIRED');
    const config = await unpack(key,saved.box);
    const clean = String(code).trim().toUpperCase();
    const step = await matchingStep(config.secret, clean, config.lastStep);
    const recoveryHash = /^[A-Z2-7]{26}$/.test(clean) ? await digest(clean) : '';
    const index = config.recovery.findIndex(x => same(x, recoveryHash));
    if (step === null && index < 0) {
      saved.failures = (saved.failures || 0) + 1;
      if (saved.failures >= 5) saved.blockedUntil = Date.now() + 60_000;
      await db.put(db.STORES.kv,CONFIG,saved);
      throw new Error('Invalid or already used code. Wait for a fresh code in your authenticator.');
    }
    if (index >= 0) config.recovery.splice(index,1); else config.lastStep = step;
    await db.put(db.STORES.kv,CONFIG,{box:await pack(key,config), failures:0, blockedUntil:0});
  });
}
// Caller must authorize a fresh code and re-check the password first.
export async function disable() { return serial(async () => { await db.del(db.STORES.kv,CONFIG); await db.del(db.STORES.kv,PENDING); }); }
