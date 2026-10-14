// Hide monetary text with literal stars while leaving cards and layout visible.
let amounts=new WeakMap();let hidden=false;
try{hidden=localStorage.getItem('esc.hideAssets')==='true';}catch{}
export const amountsHidden=()=>hidden;
export function setAmount(element,value){if(!element)return;const text=String(value??'');amounts.set(element,text);element.setAttribute('data-private-amount','');element.textContent=hidden?'**':text;}
export function setAmountsHidden(value){hidden=Boolean(value);try{localStorage.setItem('esc.hideAssets',String(hidden));}catch{}for(const element of document.querySelectorAll('[data-private-amount]')){const text=amounts.get(element);if(text!==undefined)element.textContent=hidden?'**':text;}}
export function clearAmountCache(){for(const el of document.querySelectorAll('[data-private-amount]'))el.textContent='';amounts=new WeakMap();}
