// Pure presentation models. All monetary aggregation uses integer units.
const SCALE = 10n ** 12n;
export function units(value) { const text=String(value??'0'); if(!/^\d+(\.\d{1,12})?$/.test(text))throw new Error('Invalid amount'); const [whole,fraction='']=text.split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(12,'0')); }
export function amount(value) { const fraction=(value%SCALE).toString().padStart(12,'0').replace(/0+$/,'');return `${value/SCALE}${fraction?'.'+fraction:''}`; }
export function portfolios(watch,contacts,height) {
  const groups=new Map();
  for(const w of watch){
    const contact=contacts.find(c=>(c.addresses||[c]).some(a=>a.address===w.address));
    const id=contact?`contact:${contact.id}`:w.label?`label:${w.label}`:`watch:${w.id}`;
    if(!groups.has(id))groups.set(id,{id,name:contact?.name||w.label||w.key_short,addresses:[],received:0n,unspent:0n,seesAllSpends:true,complete:true});
    const g=groups.get(id);g.addresses.push(w);g.received+=units(w.received);g.seesAllSpends&&=w.unspent!=null;g.unspent+=units(w.unspent);g.complete&&=w.scanned_to>=height;
  }
  return [...groups.values()].map(g=>({...g,received:amount(g.received),unspent:g.seesAllSpends?amount(g.unspent):null}));
}
export function activityFeed(groups) {
  return groups.flatMap(g=>g.addresses.flatMap(w=>w.coins.flatMap((c,i)=>{
    const base={contact:g.name,contactId:g.id,watchId:w.id,kind:w.kind,amount:c.amount};
    const rows=[{...base,id:`${w.id}:${c.received_height}:${i}:received`,event:'received',height:c.received_height,at:c.received_ms}];
    if(c.spent_height!=null)rows.push({...base,id:`${w.id}:${c.received_height}:${i}:spent`,event:'spent',height:c.spent_height,at:null});return rows;
  }))).sort((a,b)=>b.height-a.height||a.id.localeCompare(b.id));
}
export function scanProgress(previous,next,now=Date.now()) {
  const phase=next.watchBehind?'watch':'wallet';
  const at=next.watchBehind?.at??next.height??0,end=next.watchBehind?.end??next.tip??at;
  const before=previous.scanSample;
  let rate=before?.phase===phase?before.rate||0:0;
  let lastProgressAt=before?.lastProgressAt||now;
  if(before?.phase===phase&&at>before.at&&now>before.atMs){const measured=(at-before.at)/((now-before.atMs)/1000);rate=rate?rate*.7+measured*.3:measured;lastProgressAt=now;}
  if(before?.phase!==phase||at<(before?.at??0)||next.scanPaused){rate=0;lastProgressAt=now;}
  const changed=!before||before.phase!==phase||at!==before.at||next.scanPaused;
  const remaining=Math.max(0,end-at),stalled=remaining>0&&!next.scanPaused&&now-lastProgressAt>180000;
  return {phase,at,end,remaining,rate:stalled?0:rate,etaSeconds:remaining>0&&rate>0&&!stalled&&!next.scanPaused?Math.ceil(remaining/rate):null,stalled,paused:Boolean(next.scanPaused),scanSample:{phase,at:changed?at:before.at,atMs:changed?now:before.atMs,rate,lastProgressAt}};
}
export function paymentTimeline(payment,height) {
  const status=payment.status==='done'?'broadcast':payment.status||'unknown';
  const stages=['queued','building','proving','broadcast','confirmed'];
  const positions={starting:0,waiting:0,'waiting-block':0,preparing:1,building:1,rebuilding:1,proving:2,submitting:3,submitted:3,broadcast:3,pending:3,confirmed:4};
  const current=positions[status]??-1;
  return {id:payment.id,amount:payment.amount,to:payment.to,status,error:payment.error||null,confirmations:status==='confirmed'&&payment.height!=null?Math.max(0,height-payment.height+1):null,steps:stages.map((name,i)=>({name,state:current<0?'unknown':i<current?'done':i===current?'current':'waiting'}))};
}
export function assistantAnswer(question,data) {
  const q=String(question||'').toLowerCase().slice(0,500),scan=data.scan;
  if(/stuck|scan|slow|block|sync|pause/.test(q)){
    if(scan.paused)return 'Scanning is paused. Open Scans and choose Resume to continue from the saved block.';
    if(data.status.watchError||data.status.error)return `The last scan reported: ${data.status.watchError||data.status.error}. Check Node health, then use Retry in Scans. Completed batches remain saved.`;
    if(scan.stalled)return 'No scan progress has been recorded for three minutes. Check Node health for connectivity, then retry the scan.';
    return scan.remaining?`${scan.remaining} blocks remain in the ${scan.phase} scan. ${scan.etaSeconds?`Estimated time: ${Math.ceil(scan.etaSeconds/60)} minutes.`:'An estimate appears after progress is measured.'}`:'The saved scan is caught up with the last known chain tip.';
  }
  if(/balance|unspent|received|spend/.test(q))return 'Received is the total discovered by the viewing key. Known unspent requires the matching spend-view key. A portfolio shows no combined unspent total if any address lacks spend visibility. Scanning may still be incomplete; watch balances cannot be spent by this wallet.';
  if(/auth|security|code/.test(q))return 'Security lets you enable authenticator app codes. Save the one-use recovery codes offline. This local approval guard does not protect a stolen recovery phrase or a compromised browser profile.';
  if(/backup|export|import/.test(q))return 'Backup exports contacts and watch configuration in a password-encrypted file. It contains sensitive viewing information but no wallet seed. Import merges into the same network after you review the entry counts.';
  if(/node|server|connection/.test(q))return 'Open Node health and run a check to see latency, tip height and RPC capabilities. Unknown means the node did not return a supported response.';
  return 'I can explain scan progress, balances, node checks, backups and authenticator setup. This is a local read-only helper: it cannot send funds, change settings or access an external AI service.';
}
export function trustedMessage(sender,runtimeId,message) {
  if(sender?.id!==runtimeId||typeof sender.url!=='string')return false;
  let url;try{url=new URL(sender.url);}catch{return false;}
  if(url.protocol!=='chrome-extension:'||url.hostname!==runtimeId)return false;
  if(message.type)return url.pathname==='/offscreen.html'&&['proved','submitted','proveProgress','proveFailed'].includes(message.type);
  return ['/popup.html','/hub.html'].includes(url.pathname)&&typeof message.cmd==='string';
}
