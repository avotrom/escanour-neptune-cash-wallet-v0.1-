import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../extension/lib/watch-model.js';

async function harness() {
  const enc=new TextEncoder(), dec=new TextDecoder();
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const stores={kv:'kv',snapshots:'snapshots',sends:'sends',jobs:'jobs',proofs:'proofs'};
  const maps=Object.fromEntries(Object.values(stores).map(n=>[n,new Map()]));
  const db={STORES:stores,get:async(s,k)=>maps[s].get(k),put:async(s,k,v)=>maps[s].set(k,v),del:async(s,k)=>maps[s].delete(k),keys:async s=>[...maps[s].keys()],delPrefix:async(s,p)=>{for(const k of maps[s].keys())if(k.startsWith(p))maps[s].delete(k);}};
  const vault={sessionKey:async()=>key,exportRawKey:async()=>new Uint8Array(32),phrase:async()=>'',
    encrypt:async(k,data)=>{const iv=crypto.getRandomValues(new Uint8Array(12));return{iv,data:new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},k,data))}},
    decrypt:async(k,b)=>new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.iv},k,b.data))};
  const encode=o=>enc.encode(JSON.stringify(o)),decode=b=>JSON.parse(dec.decode(b));
  class Wallet {
    watchList(bytes){return decode(bytes).watch.map(a=>({id:a.id,label:a.label,kind:a.viewingKey.startsWith('nech')?'ec-hybrid':'generation',from_height:a.fromHeight,scanned_to:a.scanned_to??a.fromHeight-1,coins:[],received:'0',unspent:null}));}
    watchRegistry(bytes){return decode(bytes).watch.map(({id,label,viewingKey,spendKey,fromHeight})=>({id,label,viewingKey,spendKey,fromHeight}));}
    watchReconcile(bytes,json){const state=decode(bytes),regs=JSON.parse(json);if(new Set(regs.map(r=>r.viewingKey)).size!==regs.length)throw Error('this address is already watched');state.watch=regs.map(r=>({...state.watch.find(a=>a.id===r.id&&a.viewingKey===r.viewingKey),...r}));return encode(state);}
    watchCatchUpFor(bytes,body,ids){const state=decode(bytes),range=JSON.parse(body),selected=JSON.parse(ids);for(const a of state.watch)if(selected.includes(a.id))a.scanned_to=range.to;return {state:encode(state),result:{received:0}};}
    free(){}
  }
  const light={maxBlocksPerCall:()=>2,getBlocksRequest:(id,from,to)=>JSON.stringify({from,to}),LightWallet:Wallet,addressInfo:(a)=>({valid:/^(nolga|nech)/.test(a),kind:a.startsWith('nech')?'ec-hybrid':'generation'})};
  const settings={network:'main',servers:{main:{sync:'https://example.invalid/',broadcast:'https://example.invalid/'}},exactPrivacy:false};
  const settingsStore={NETWORKS:['main'],load:async()=>settings,save:async patch=>Object.assign(settings,patch),serversFor:s=>s.servers[s.network]};
  const session={};const listener={addListener:()=>{}};
  const chrome={runtime:{sendMessage:async()=>{},getURL:x=>x,getPlatformInfo:async()=>{},onMessage:listener,onInstalled:listener,onStartup:listener},notifications:{onClicked:listener},storage:{session:{get:async k=>({[k]:session[k]}),set:async patch=>Object.assign(session,patch)}},alarms:{create:()=>{},onAlarm:listener},sidePanel:{setPanelBehavior:async()=>{}}};
  const rpc={interrupt:()=>{},id:()=>1,post:async(url,body)=>body,normalizeServer:url=>new URL(url).origin+'/'};
  const source=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')+'\nglobalThis.api = {commands, latestSnapshot, saveSnapshot, dropWallet, setStatus, status, requireWallet, watchCatchUp, watchFastStep};';
  const context=vm.createContext({chrome,db,vault,light,rpc,settingsStore,...model,initLight:async()=>{},t:x=>x,setLanguage:()=>{},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,crypto,URL,AbortController,AbortSignal,Date,console,setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{}});
  new vm.Script(source).runInContext(context);
  const initial=encode({height:100,watch:[]});await context.api.saveSnapshot(key,100,initial,'main');
  return {api:context.api,maps,key,initial,rpc,light,vault};
}

test('watch adds/removes survive rollback and use monotonic IDs',async()=>{
  const h=await harness();
  await h.api.commands.watchAdd({label:'Atlas',viewingKey:'nolgavk1test',from:'start',mode:'private'});
  await h.api.commands.watchAdd({label:'Atlas',viewingKey:'nechvk1test',from:'start',mode:'fast'});
  assert.equal((await h.api.commands.watchList()).list.length,2);
  await h.api.saveSnapshot(h.key,100,h.initial,'main');h.api.dropWallet();
  assert.equal((await h.api.commands.watchList()).list.length,2);
  await h.api.commands.watchRemove({id:1});
  await h.api.saveSnapshot(h.key,100,h.initial,'main');h.api.dropWallet();
  assert.deepEqual(Array.from((await h.api.commands.watchList()).list,a=>a.id),[2]);
  await h.api.commands.watchAdd({label:'Third',viewingKey:'nolgavk2test',from:'now'});
  assert.deepEqual(Array.from((await h.api.commands.watchList()).list,a=>a.id),[2,3]);
  const stored=h.maps.kv.get('watchData:main');
  assert.ok(stored.iv && stored.data);assert.ok(!new TextDecoder().decode(stored.data).includes('nolgavk'));
});
test('pause, resume and asset hiding persist through worker cache reset',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  await h.api.commands.watchUpdate({id:1,paused:true,hidden:true});h.api.dropWallet();
  let a=(await h.api.commands.watchList()).list[0];assert.equal(a.paused,true);assert.equal(a.hidden,true);
  await h.api.commands.watchUpdate({id:1,paused:false});a=(await h.api.commands.watchList()).list[0];assert.equal(a.paused,false);assert.equal(a.hidden,true);
});
test('paired contact updates preserve both address kinds and reject duplicates',async()=>{
  const h=await harness();let list=await h.api.commands.saveContact({name:'Atlas',addresses:['nolga1abc','nech1abc']});
  assert.equal(list[0].addresses.length,2);
  await assert.rejects(h.api.commands.saveContact({name:'Duplicate',address:'nech1abc'}),/DUPLICATE/);
  await assert.rejects(h.api.commands.saveContact({name:'Two generation',addresses:['nolga1new','nolga1other']}),/one Generation/);
  list=await h.api.commands.saveContact({id:list[0].id,name:'Atlas updated',addresses:['nolga1abc','nech1abc']});assert.equal(list.length,1);assert.equal(list[0].name,'Atlas updated');
});
test('concurrent status writes preserve both wallet and watch progress',async()=>{
  const h=await harness();await Promise.all([h.api.setStatus({height:123}),h.api.setStatus({watchBehind:{at:45,end:123}})]);
  const s=await h.api.status();assert.equal(s.height,123);assert.equal(s.watchBehind.at,45);
});

test('an interrupted watch scan keeps the last committed block checkpoint',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  h.rpc.post=async(url,body)=>{if(JSON.parse(body).from>2)throw Error('SCAN_INTERRUPTED');return body;};
  const {wallet}=await h.api.requireWallet();const snap=await h.api.latestSnapshot(h.key);
  await assert.rejects(h.api.watchCatchUp({key:h.key,wallet,server:'https://example.invalid/',snap}),/SCAN_INTERRUPTED/);
  h.api.dropWallet();
  assert.equal((await h.api.commands.watchList()).list[0].scanned_to,2);
});

test('indexed scanning resumes an encrypted checkpoint returned by typed-array WASM bindings',async()=>{
  const h=await harness();let flags=0,freed=0;
  h.light.WatchFastScan=class {
    constructor(){this.n=0;}
    static fromBytes(bytes){const x=new this();x.n=JSON.parse(new TextDecoder().decode(bytes)).n;return x;}
    toBytes(){return new TextEncoder().encode(JSON.stringify({n:this.n}));}
    height(){return 100;} found(){return this.n;}
    flagsRequest(){flags++;return '{}';}
    heights(){return new Float64Array(Array.from({length:13},(_,i)=>i+1));}
    scan(){this.n++;} spentRequest(){return undefined;}
    finish(bytes){const state=JSON.parse(new TextDecoder().decode(bytes));state.watch[0].scanned_to=100;return new TextEncoder().encode(JSON.stringify(state));}
    free(){freed++;}
  };
  await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start',mode:'fast'});
  const {wallet}=await h.api.requireWallet();const snap=await h.api.latestSnapshot(h.key);
  const account=(await h.api.commands.watchList()).list[0];
  const args={key:h.key,wallet,server:'https://example.invalid/',snap,account,pref:{mode:'fast'},net:'main'};
  assert.equal(await h.api.watchFastStep(args),true);
  const box=h.maps.kv.get('watchFast:main:1');
  const task=JSON.parse(new TextDecoder().decode(await h.vault.decrypt(h.key,box)));
  assert.ok(Array.isArray(task.heights));assert.equal(task.next,12);
  assert.equal(await h.api.watchFastStep(args),false);
  assert.equal(flags,1);assert.equal(freed,1);assert.equal(h.maps.kv.has('watchFast:main:1'),false);
  assert.equal((await h.api.commands.watchList()).list[0].scanned_to,100);
});

test('empty watch block responses surface an error instead of looping forever',async()=>{
  const h=await harness();await h.api.commands.watchAdd({label:'A',viewingKey:'nolgavk1test',from:'start'});
  const {wallet}=await h.api.requireWallet();wallet.watchCatchUpFor=()=>({result:{scanned:0}});
  const snap=await h.api.latestSnapshot(h.key);
  await assert.rejects(h.api.watchCatchUp({key:h.key,wallet,server:'https://example.invalid/',snap}),/no usable watch blocks/);
});
