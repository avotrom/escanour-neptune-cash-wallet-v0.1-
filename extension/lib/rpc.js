import { guardedFetch, readText } from './network.js';
// Transport only: POST a JSON-RPC body to neptune-core's existing endpoint.
// Request bodies are built in wasm with neptune-rpc-api's own types, so the
// parameter encoding always matches what the node expects.
//
// Extensions with host permission for a server can call it even without
// CORS headers, so no change to the node is needed.

let nextId = 1;
const backgroundRequests = new Set();
export function cancelBackground() {
  for (const ctrl of backgroundRequests) ctrl.abort();
}

export function id() {
  return nextId++;
}

export async function post(url, body, { timeoutMs = 60_000, background = false } = {}) {
  const ctrl = new AbortController();
  if (background) backgroundRequests.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await guardedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    }, {}, async response => ({ok:response.ok,status:response.status,text:await readText(response)}));
    const text = res.text;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    // JSON-RPC errors arrive with HTTP 200; surface them here so callers can
    // match the node's message (e.g. "not confirmable").
    if (text.trimStart().startsWith('{') && text.includes('"error"')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) throw new Error(`node: ${JSON.stringify(parsed.error)}`);
      } catch (e) {
        if (e.message.startsWith('node:')) throw e;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
    backgroundRequests.delete(ctrl);
  }
}

export function normalizeServer(url) {
  const u = new URL(url.trim());
  if (u.username || u.password) throw new Error('Node URLs cannot contain credentials');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw new Error('Use https:// (plain http is only allowed for localhost)');
  }
  return `${u.origin}/`;
}
