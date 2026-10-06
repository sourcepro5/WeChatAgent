export function validateStickerSettings(settings) {
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid sticker settings');
  for(const key of ['enabled','labelCache'])if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw Error('Invalid sticker '+key);
  if(settings.chats!==undefined){
    if(!settings.chats||typeof settings.chats!=='object'||Array.isArray(settings.chats))throw Error('Invalid sticker chats');
    for(const [key,value] of Object.entries(settings.chats))if(!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||!Number.isSafeInteger(Number(key.split(':').at(-1)))||typeof value!=='boolean')throw Error('Invalid sticker chat override');
  }
}
export function stickerPolicy(wechat,key){
  const settings=wechat?.stickers;
  validateStickerSettings(settings);
  return {enabled:settings?.chats?.[key]??settings?.enabled??true,labelCache:settings?.labelCache??true};
}
export const stickerPolicyKey=policy=>JSON.stringify([policy.enabled,policy.labelCache]);
export function cleanStickerLabel(item){
  if(!item||typeof item.description!=='string'||!item.description.trim()||item.description.length>120||/[\u0000-\u001f]/.test(item.description))return null;
  if(!Array.isArray(item.tags)||item.tags.length>6||item.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>16||/[\u0000-\u001f]/.test(tag)))return null;
  return {description:item.description.trim(),tags:[...new Set(item.tags.map(tag=>tag.trim()))]};
}
export function selectStickerChoices(choices,text,seenIds,{labelCache=true}={}){
  const requested=/表情|贴纸|梗图/.test(text);
  const score=item=>labelCache?item.tags?.filter(tag=>text.includes(tag)).length??0:0;
  const labelled=choices.filter(item=>labelCache&&cleanStickerLabel(item)).sort((a,b)=>score(b)-score(a));
  const visible=choices.filter(item=>seenIds.has(item.id)&&!labelled.some(other=>other.id===item.id));
  const unknown=requested&&!labelled.length&&!visible.length?choices.slice(0,2):[];
  return [...visible,...labelled,...unknown].slice(0,3);
}
export function splitStickerLabels(output){
  const text=String(output??'').trim();
  const marker=/STICKER_LABELS:\s*/.exec(text);
  if(!marker)return {text,labels:[]};
  const reply=text.slice(0,marker.index).trim();
  try{
    const items=JSON.parse(text.slice(marker.index+marker[0].length));
    if(!Array.isArray(items)||items.length>4)return {text:reply,labels:[]};
    return {text:reply,labels:items.filter(item=>/^I[1-4]$/.test(item?.ref??'')&&cleanStickerLabel(item)).map(item=>({ref:item.ref,...cleanStickerLabel(item)}))};
  }catch{return {text:reply,labels:[]};}
}
