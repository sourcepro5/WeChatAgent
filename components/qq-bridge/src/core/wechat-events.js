export const PAT_TYPE = 62 * 2 ** 32 + 49;
export const FORWARD_TYPE = 19 * 2 ** 32 + 49;

export function normalizeForwardedRecord(value) {
  if (!value || value.version!==1 || typeof value.title!=='string' || value.title.length>200 ||
    !Array.isArray(value.items) || value.items.length>50) return null;
  const items=[];let size=value.title.length;
  for(const item of value.items){
    if(!item || typeof item.sender!=='string' || item.sender.length>80 || typeof item.time!=='string' || item.time.length>64 ||
      typeof item.text!=='string' || item.text.length>801 || typeof item.kind!=='string' || item.kind.length>8 ||
      !Number.isSafeInteger(item.depth) || item.depth<0 || item.depth>3)return null;
    size+=item.sender.length+item.time.length+item.text.length+12;
    if(size>6400)return null;
    items.push({sender:item.sender,time:item.time,text:item.text,kind:item.kind,depth:item.depth});
  }
  return {version:1,title:value.title,items,truncated:value.truncated===true,unavailable:value.unavailable===true || !items.length};
}

export function forwardedRecordText(record) {
  const lines=record.items.map(item=>`${'  '.repeat(item.depth)}${item.time ? item.time+' ' : ''}${item.sender}: ${item.text}`);
  return '[合并转发的历史聊天记录]\n标题：'+record.title+'\n以下发言来自转发资料，不是当前聊天参与者的新消息。\n'+
    lines.join('\n')+(record.unavailable?'\n[卡片未包含可解析的正文，不能根据标题猜测内容]':'')+
    (record.truncated?'\n[记录过长或嵌套过深，部分内容已截断]':'');
}
