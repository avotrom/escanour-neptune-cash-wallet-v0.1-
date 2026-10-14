const $=id=>document.getElementById(id);
let hideBalances=localStorage.getItem('esc.hideAssets')==='true';
function applyPrivacy(){document.body.classList.toggle('hide-balances',hideBalances);$('hideBalances').textContent=hideBalances?'Show balances':'Hide balances';$('hideBalances').setAttribute('aria-pressed',String(hideBalances));}
$('hideBalances').onclick=()=>{hideBalances=!hideBalances;localStorage.setItem('esc.hideAssets',String(hideBalances));applyPrivacy();};
applyPrivacy();
let data=null,activePage='overview',loading=false,previewToken=null,feedLimit=100;
let approvalPending=null;
function approval(){
  if(approvalPending)return Promise.reject(new Error('Finish the current approval first'));
  return new Promise(resolve=>{approvalPending=resolve;$('approvalCode').value='';$('codeDialog').showModal();$('approvalCode').focus();});
}
$('codeDialog').addEventListener('close',()=>{const code=$('codeDialog').returnValue==='approve'?$('approvalCode').value.trim():null;$('approvalCode').value='';const resolve=approvalPending;approvalPending=null;resolve?.(code);});
async function call(cmd,args={}){
  const result=await chrome.runtime.sendMessage({target:'background',cmd,args});
  if(!result?.ok){
    if(result?.error==='AUTH_CODE_REQUIRED'){const code=await approval();if(!code)throw new Error('Approval cancelled');return call(cmd,{...args,authCode:code});}
    throw new Error(result?.error||'Wallet service unavailable');
  }
  return result.data;
}
function message(text){$('message').textContent=text||'';}
async function action(button,fn){button=button||{disabled:false};button.disabled=true;message('');try{await fn();}catch(e){message(e.message);}finally{button.disabled=false;}}
function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=String(text);if(cls)el.className=cls;return el;}
function stats(target,values){const out=$(target);out.replaceChildren();for(const [label,value]of values){const box=node('div',null,'stat');box.append(node('small',label),node('strong',value??'Unknown'));out.append(box);}}
const num=n=>Number.isFinite(n)?n.toLocaleString():'Unknown';
const date=n=>n?new Date(n).toLocaleString():'Time unavailable';
const money=n=>n==null?'Unknown':`${n} NPT`;
function row(title,detail,right){const el=node('div',null,'row'),left=node('div');left.append(node('b',title),node('small',detail));el.append(left,node('span',right,'row-value'));return el;}
function clearSecrets(){for(const id of ['authPassword','authDisablePassword','authSetupCode','exportPassword','exportRepeat','importPassword','approvalCode'])$(id).value='';$('authSecret').textContent='';$('authQR').replaceChildren();$('recoveryCodes').textContent='';$('recoveryBox').hidden=true;$('authSetup').hidden=true;$('importFile').value='';previewToken=null;$('applyImport').hidden=true;}
function locked(){data=null;clearSecrets();if($('codeDialog').open)$('codeDialog').close('cancel');$('workspace').hidden=true;$('locked').hidden=false;for(const id of ['portfolioList','activityList','paymentList','answer'])$(id).replaceChildren();}
async function refresh(){if(loading||document.hidden)return;loading=true;try{data=await call('hubData');$('workspace').hidden=false;$('locked').hidden=true;render();}catch(e){if(/locked|Unlock/.test(e.message))locked();else message(e.message);}finally{loading=false;}}
function render(){
  document.documentElement.dataset.theme = data.theme==='light'||(data.theme!=='dark'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';
  $('network').textContent=`${data.network.toUpperCase()} · LOCAL WALLET`;
  const scan=data.scan,health=data.node;
  stats('overviewStats',[['Last known chain tip',num(data.status.tip)],['Wallet height',num(data.status.height)],['Watched portfolios',data.portfolios.length],['Block reading',scan.paused?'Paused':scan.stalled?'Stalled':scan.remaining?`${num(scan.remaining)} left`:'Caught up']]);
  $('pulse').textContent=health?.ok?`Last checked ${date(health.checkedAt)}. ${health.averageBlockMs?`Mean of ${Math.max(0,health.blocks.length-1)} recent block intervals: ${(health.averageBlockMs/60000).toFixed(1)} minutes.`:'Not enough block timestamps to estimate timing.'}`:'Run a node health check to load recent blocks.';
  $('recentBlocks').replaceChildren(...(health?.blocks||[]).map(b=>row(`Block ${num(b.height)}`,date(b.timestamp_ms),'Observed')));
  $('scanHeading').textContent=scan.paused?'Scanning paused':scan.stalled?'Scan needs attention':`${scan.phase==='watch'?'Watch-only':'Wallet'} block reading`;
  $('scanProgress').max=Math.max(1,scan.end);$('scanProgress').value=Math.max(0,scan.at);
  stats('scanStats',[['Read / target',`${num(scan.at)} / ${num(scan.end)}`],['Speed',scan.paused?'Paused':scan.rate>0?`${scan.rate.toFixed(1)} blocks/s`:'Measuring…'],['Estimated remaining',scan.remaining===0?'Caught up':scan.etaSeconds?`${Math.ceil(scan.etaSeconds/60)} min`:'Not enough data']]);
  $('scanError').textContent=data.status.watchError||data.status.error||'';$('pauseScan').disabled=scan.paused;$('resumeScan').disabled=!scan.paused;$('watchAlerts').checked=data.alerts;
  renderPortfolios();renderActivity();renderPayments();renderNode();
  $('authState').textContent=data.authenticator?'Enabled · a fresh code is needed for each protected action.':'Not enabled';
  $('authBeginForm').hidden=data.authenticator;$('authDisableForm').hidden=!data.authenticator;
}
function renderPortfolios(){const list=$('portfolioList');list.replaceChildren();for(const p of data.portfolios){const card=node('article');card.append(node('h2',p.name),node('p',`${p.complete?'Scanned to the wallet’s saved height':'Partial scan — totals may change'} · ${p.addresses.length} address(es)`,'muted'));const totals=node('div',null,'stats');for(const [label,value]of [['Received',money(p.received)],['Known unspent',money(p.unspent)]]){const box=node('div',null,'stat');box.append(node('small',label),node('strong',value));totals.append(box);}card.append(totals);for(const w of p.addresses)card.append(row(w.kind,`Read through block ${num(w.scanned_to)} · ${w.sees_spends?'Spends visible':'Receipts only'}`,money(w.unspent??w.received)));list.append(card);}if(!data.portfolios.length)list.append(node('p','No watched addresses yet. Add viewing keys from the wallet’s Watch-only page.','muted'));
 const filter=$('contactFilter'),selected=filter.value,signature=JSON.stringify(data.portfolios.map(p=>[p.id,p.name]));if(filter.dataset.options!==signature&&document.activeElement!==filter){filter.replaceChildren(new Option('All contacts',''),...data.portfolios.map(p=>new Option(p.name,p.id)));filter.value=data.portfolios.some(p=>p.id===selected)?selected:'';filter.dataset.options=signature;}
}
function renderActivity(){const rows=data.feed.filter(e=>(!$('contactFilter').value||e.contactId===$('contactFilter').value)&&(!$('kindFilter').value||e.kind===$('kindFilter').value)&&(!$('eventFilter').value||e.event===$('eventFilter').value));$('activityList').replaceChildren(...rows.slice(0,feedLimit).map(e=>row(`${e.contact} · ${e.event}`,`${e.kind} · block ${num(e.height)}${e.at?' · '+date(e.at):''}`,money(e.amount))));if(!rows.length)$('activityList').append(node('p','No matching watched activity.','muted'));if(data.feedLimited)$('activityList').append(node('p','Showing the latest 5,000 watched events.','muted'));$('moreActivity').hidden=rows.length<=feedLimit;}
function renderPayments(){const list=$('paymentList');list.replaceChildren();for(const p of data.payments){const card=node('article');card.append(node('h2',`${money(p.amount)} · ${p.status}`),node('p',p.to?`${p.to.slice(0,16)}…${p.to.slice(-8)}`:p.id,'muted'));const steps=node('ol',null,'timeline');for(const step of p.steps)steps.append(node('li',step.name,step.state));card.append(steps);if(p.error)card.append(node('p',p.error,'error'));if(p.confirmations!=null)card.append(node('p',`${p.confirmations} confirmation(s)`));list.append(card);}if(!data.payments.length)list.append(node('p','No outgoing payments recorded.','muted'));}
function renderNode(){const n=data.node;stats('nodeStats',[['Host',n?.host],['Reachable',n?n.ok?'Yes':'No':'Not checked'],['RPC latency',n?.latencyMs!=null?`${n.latencyMs} ms`:null],['Block reading',n?.walletBlocks?'Supported':'Unknown'],['Chain height',n?.height],['Reported network',n?.network],['Indexed restore',n?.fastRestore===true?'Supported':n?.fastRestore===false?'Unsupported':'Unknown']]);$('nodeError').textContent=n?.error||'';}
$('nav').onclick=event=>{const b=event.target.closest('button[data-page]');if(!b)return;activePage=b.dataset.page;for(const page of document.querySelectorAll('.page'))page.hidden=page.id!==activePage;for(const button of $('nav').querySelectorAll('button'))button.setAttribute('aria-current',button===b?'page':'false');$('title').textContent=b.textContent;message('');};
$('refresh').onclick=()=>refresh();$('lock').onclick=()=>action($('lock'),async()=>{await call('lock');locked();});
for(const [id,kind]of [['pauseScan','pause'],['resumeScan','resume'],['retryScan','retry']])$(id).onclick=()=>action($(id),async()=>{await call('scanControl',{action:kind});await refresh();});
$('watchAlerts').onchange=()=>action($('watchAlerts'),async()=>{await call('setWatchAlerts',{enabled:$('watchAlerts').checked});await refresh();});
for(const id of ['nodeCheck','checkOverview'])$(id).onclick=()=>action($(id),async()=>{message('Checking your node…');await call('nodeHealth');message('');await refresh();});
$('blockForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{const b=await call('explorerBlock',{height:$('blockHeight').value});$('blockResult').textContent=`Block ${num(b.height)} · ${date(b.timestamp_ms)}`;});};
for(const id of ['contactFilter','kindFilter','eventFilter'])$(id).onchange=()=>{feedLimit=100;if(data)renderActivity();};$('moreActivity').onclick=()=>{feedLimit+=100;renderActivity();};
$('exportForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{if($('exportPassword').value!==$('exportRepeat').value)throw new Error('Backup passwords do not match');const text=await call('backupExport',{password:$('exportPassword').value});const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=node('a');a.href=url;a.download=`escanour-contacts-${data.network}-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);$('exportPassword').value='';$('exportRepeat').value='';message('Encrypted backup downloaded. Keep its password separately.');});};
$('importForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{previewToken=null;$('applyImport').hidden=true;const file=$('importFile').files[0];if(!file||file.size>3*1024*1024)throw new Error('Choose a backup smaller than 3 MB');const preview=await call('backupPreview',{text:await file.text(),password:$('importPassword').value});$('importPassword').value='';previewToken=preview.token;$('importPreview').textContent=`${preview.contacts} contacts and ${preview.watch} watched addresses for ${preview.network}. Existing entries stay; exact duplicates are skipped.`;$('applyImport').hidden=false;});};
$('applyImport').onclick=()=>action($('applyImport'),async()=>{await call('backupApply',{token:previewToken});previewToken=null;$('applyImport').hidden=true;$('importPreview').textContent='Import complete.';await refresh();});
$('authBeginForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{const result=await call('authBegin',{password:$('authPassword').value});$('authPassword').value='';$('authSecret').textContent=result.secret;$('authSetup').hidden=false;const svg=await call('qr',{text:result.uri});const parsed=new DOMParser().parseFromString(svg,'image/svg+xml');const root=parsed.documentElement;if(root.localName==='svg'&&!root.querySelector('script,foreignObject,image,use,a')){for(const el of root.querySelectorAll('*'))for(const a of [...el.attributes])if(a.name.startsWith('on'))el.removeAttribute(a.name);$('authQR').replaceChildren(document.importNode(root,true));}});};
$('authConfirmForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{const codes=await call('authConfirm',{code:$('authSetupCode').value});$('authSetupCode').value='';$('authSecret').textContent='';$('authQR').replaceChildren();$('authSetup').hidden=true;$('recoveryCodes').textContent=codes.join('\n');$('recoveryBox').hidden=false;await refresh();});};
$('recoverySaved').onclick=()=>{$('recoveryCodes').textContent='';$('recoveryBox').hidden=true;};
$('authDisableForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{if(!confirm('Disable authenticator protection for this wallet?'))return;await call('authDisable',{password:$('authDisablePassword').value});$('authDisablePassword').value='';await refresh();message('Authenticator disabled.');});};
async function ask(question){$('answer').textContent=await call('assistant',{question});}
$('assistantForm').onsubmit=e=>{e.preventDefault();action(e.submitter,()=>ask($('question').value));};for(const b of document.querySelectorAll('.ask'))b.onclick=()=>action(b,()=>ask(b.dataset.question));
chrome.runtime.onMessage.addListener(msg=>{if(msg?.target==='popup'&&msg.type==='locked')locked();else if(msg?.target==='popup'&&msg.type==='walletChanged')refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
window.addEventListener('pagehide',clearSecrets);
setInterval(refresh,5000);refresh();

// Only real interaction refreshes auto-lock; timer-driven reads never do.
let lastInteractionPing = 0;
for (const type of ['pointerdown','keydown']) document.addEventListener(type, event => {
  if (!event.isTrusted || Date.now()-lastInteractionPing < 30000) return;
  lastInteractionPing = Date.now(); call('touch').catch(() => {});
}, {passive:true});
