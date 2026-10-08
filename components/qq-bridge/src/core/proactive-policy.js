import crypto from 'node:crypto';
export const PROACTIVE_DEFAULTS=Object.freeze({enabled:false,mode:'mixed',intervalMinutes:240,idleMinutes:120,
  startTime:'09:00',endTime:'22:00',useSearch:true,jitterMinutes:15});
const chatKey=/^wechat:(private|group):[1-9]\d{0,15}$/;
const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function validateProactiveSettings(value){
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid proactive settings');
  for(const key of ['enabled','useSearch'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw Error('Invalid proactive '+key);
  if(value.mode!==undefined&&!['mixed','greeting','news','meme'].includes(value.mode))throw Error('Invalid proactive mode');
  for(const [key,min,max] of [['intervalMinutes',30,1440],['idleMinutes',5,1440],['jitterMinutes',0,60]])
    if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max))throw Error('Invalid proactive '+key);
  for(const key of ['startTime','endTime'])if(value[key]!==undefined&&(typeof value[key]!=='string'||!clock.test(value[key])))throw Error('Invalid proactive '+key);
  if((value.startTime??PROACTIVE_DEFAULTS.startTime)===(value.endTime??PROACTIVE_DEFAULTS.endTime))throw Error('Invalid proactive window');
  if(value.chats!==undefined&&(!value.chats||typeof value.chats!=='object'||Array.isArray(value.chats)||Object.entries(value.chats)
    .some(([key,flag])=>!chatKey.test(key)||!Number.isSafeInteger(Number(key.split(':').at(-1)))||typeof flag!=='boolean')))throw Error('Invalid proactive chats');
}
export function proactivePolicy(wechat,key){
  const settings=wechat?.proactive;validateProactiveSettings(settings);
  const values=Object.fromEntries(Object.entries(PROACTIVE_DEFAULTS).map(([name,value])=>[name,settings?.[name]??value]));
  return {...values,enabled:values.enabled===true&&settings?.chats?.[key]===true};
}
export const proactivePolicyKey=policy=>JSON.stringify(policy);
const minute=time=>Number(time.slice(0,2))*60+Number(time.slice(3));
export function withinProactiveWindow(now,policy){
  const local=new Date(now+8*3600000),current=local.getUTCHours()*60+local.getUTCMinutes(),start=minute(policy.startTime),end=minute(policy.endTime);
  return start<end?current>=start&&current<end:current>=start||current<end;
}
export function nextProactiveAt(now,policy,random=()=>0){
  const proposed=now+(policy.intervalMinutes+random()*policy.jitterMinutes)*60000;
  if(withinProactiveWindow(proposed,policy))return proposed;
  const local=new Date(proposed+8*3600000),start=minute(policy.startTime),midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-8*3600000;
  let at=midnight+start*60000;if(at<=proposed)at+=86400000;return at;
}
export function conversationSnapshot(rows){return crypto.createHash('sha256').update(JSON.stringify(rows.slice(-5).map(row=>[row.id,row.message_id,row.timestamp,row.delivery_id??'']))).digest('hex');}
export function declinedProactive(rows){
  const latest=rows.findLast(row=>!row.outgoing&&!row.interaction);
  return !!latest&&(latest.kind==='private'||latest.direct_mention)&&/^(?:先|暂时|以后|今后)?(?:别|不要|不用).{0,12}(?:主动找我|主动发|打扰我|给我发|找话题)/.test(String(latest.text).trim());
}
