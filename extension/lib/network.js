// Wallet-origin egress guard. Tor-enabled remote requests require the expected
// proxy configuration and a successful Tor check. Redirects cannot escape the PAC host list.
import * as settingsStore from './settings.js';
export const isLocalHost = host => ['localhost','127.0.0.1','[::1]'].includes(host);
export function torHosts(settings) {
  const hosts=new Set(['api.coingecko.com','check.torproject.org']);
  for(const server of Object.values(settings.servers||{}))for(const value of [server.sync,server.broadcast]){
    try{const host=new URL(value).hostname;if(host&&!isLocalHost(host))hosts.add(host);}catch{}
  }
  return [...hosts];
}
export function pacScript(hosts,port) {
  return `function FindProxyForURL(url, host) {\n  var tor = ${JSON.stringify(hosts)};\n  for (var i = 0; i < tor.length; i++) {\n    if (host === tor[i]) return "SOCKS5 127.0.0.1:${Number(port)}";\n  }\n  return "DIRECT";\n}`;
}
export async function assertRoute(value,{torCheck=false}={}) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Unsupported network destination');
  const settings=await settingsStore.load();
  if(!settings.tor||isLocalHost(url.hostname))return;
  if(!torHosts(settings).includes(url.hostname))throw new Error('Tor blocked an unsaved destination. Save this node in server settings before testing it.');
  if(!globalThis.chrome?.proxy?.settings)throw new Error('Tor protection unavailable: proxy permission is missing. Remote requests are blocked.');
  const proxy=await chrome.proxy.settings.get({});
  const expected=pacScript(torHosts(settings),Number(settings.torPort)||9150);
  if(proxy.levelOfControl!=='controlled_by_this_extension'||proxy.value?.mode!=='pac_script'||proxy.value.pacScript?.mandatory!==true||proxy.value.pacScript.data!==expected)throw new Error('Tor proxy configuration changed or is controlled elsewhere. Remote requests are blocked.');
  if(!torCheck){const {tor}=await chrome.storage.session.get('tor');if(tor?.state!=='on'||tor.port!==(Number(settings.torPort)||9150)||!Number.isFinite(tor.at)||Date.now()-tor.at>600000||tor.at-Date.now()>60000)throw new Error('Tor verification is missing or expired. Check Tor before connecting to a remote node.');}
}
const active=new Set();
globalThis.chrome?.proxy?.settings?.onChange?.addListener(()=>{for(const controller of active)controller.abort();});
export async function guardedFetch(url,options={},policy={},consume) {
  if(typeof consume!=='function')throw new Error('A response consumer is required');
  await assertRoute(url,policy);
  const controller=new AbortController(),signal=options.signal;
  const abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  if(!isLocalHost(new URL(url).hostname))active.add(controller);
  try{return await consume(await fetch(url,{...options,signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'}));}
  finally{active.delete(controller);signal?.removeEventListener('abort',abort);}
}

/** Bound untrusted response bodies before JSON/WASM parsing. */
export async function readText(response,limit=64*1024*1024) {
  const declared=Number(response.headers?.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw new Error('Node response too large');}
  if(!response.body?.getReader){const text=await response.text();if(new TextEncoder().encode(text).length>limit)throw new Error('Node response too large');return text;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,text='';
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Node response too large');}text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}
  finally{reader.releaseLock();}
}
export async function readJSON(response) {
  if(!response.ok)throw new Error(`Service answered HTTP ${response.status}`);
  return JSON.parse(await readText(response,2*1024*1024));
}
