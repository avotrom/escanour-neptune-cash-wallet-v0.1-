// Portable encrypted contact/watch configuration backup; never includes the seed.
const enc = new TextEncoder(); const dec = new TextDecoder();
const ITERATIONS = 600000; const MAX_BYTES = 2 * 1024 * 1024;
function b64(a) { let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s); }
function bytes(s, limit) { if(typeof s!=='string'||s.length>limit||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw new Error('Invalid backup encoding');return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
async function derive(password,salt) {
  if(typeof password!=='string'||password.length<12||password.length>1024)throw new Error('Use a backup password of 12–1024 characters');
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const aad=enc.encode('Escanour contacts and watch backup v1');
export async function seal(payload,password) {
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=enc.encode(JSON.stringify(payload));if(data.length>MAX_BYTES)throw new Error('Backup too large');
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await derive(password,salt),data);
  return JSON.stringify({format:'escanour-contact-backup',version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),data:b64(new Uint8Array(encrypted))});
}
export async function unseal(text,password) {
  if(typeof text!=='string'||text.length>MAX_BYTES*1.5)throw new Error('Backup too large');
  let box;try{box=JSON.parse(text);}catch{throw new Error('Invalid backup file');}
  if(box?.format!=='escanour-contact-backup'||box.version!==1||box.kdf!=='PBKDF2-SHA256'||box.iterations!==ITERATIONS)throw new Error('Unsupported backup format');
  const salt=bytes(box.salt,24),iv=bytes(box.iv,16),data=bytes(box.data,MAX_BYTES*1.5);
  if(salt.length!==16||iv.length!==12||data.length<16)throw new Error('Invalid backup');
  try {return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},await derive(password,salt),data)));}
  catch {throw new Error('Wrong backup password or damaged backup');}
}
export function validate(payload,network) {
  if(!payload||payload.network!==network)throw new Error('Backup is for another network');
  if(!Array.isArray(payload.contacts)||payload.contacts.length>1000||!Array.isArray(payload.watch)||payload.watch.length>20)throw new Error('Invalid backup entries');
  for(const c of payload.contacts){
    if(typeof c.name!=='string'||!c.name.trim()||c.name.length>40||!Array.isArray(c.addresses)||c.addresses.length<1||c.addresses.length>2)throw new Error('Invalid contact');
    for(const a of c.addresses)if(typeof a.address!=='string'||a.address.length>20000)throw new Error('Invalid address');
  }
  for(const w of payload.watch){
    if(typeof w.label!=='string'||w.label.length>40||typeof w.viewingKey!=='string'||w.viewingKey.length>20000||!Number.isSafeInteger(w.from)||w.from<1|| (w.spendKey!=null&&(typeof w.spendKey!=='string'||!/^[0-9a-fA-F]{80}$/.test(w.spendKey))))throw new Error('Invalid watch entry');
  }
  return payload;
}
