export const PAT_TYPE = 62 * 2 ** 32 + 49;
export const FORWARD_TYPE = 19 * 2 ** 32 + 49;
export const QUOTE_TYPE = 57 * 2 ** 32 + 49;

export function normalizeQuoteReply(value) {
  const bounded=(text,limit)=>typeof text==='string' && text.length<=limit*2 && [...text].length<=limit;
  if (!value || value.version!==1 || !bounded(value.reply,4000)) return null;
  const ref=value.reference;
  if(!ref || [['senderId',128],['senderName',80],['conversationId',128],['messageId',32],['time',64],['kind',16],['text',1600]]
    .some(([key,limit])=>!bounded(ref[key],limit)))return null;
  if(ref.kind && !/^\d{1,16}$/.test(ref.kind))return null;
  return {version:1,reply:value.reply,truncated:value.truncated===true,reference:{
    senderId:ref.senderId,senderName:ref.senderName,conversationId:ref.conversationId,messageId:ref.messageId,
    time:ref.time,kind:ref.kind,text:ref.text,unavailable:ref.unavailable===true,truncated:ref.truncated===true,
    senderRelation:['self','other'].includes(ref.senderRelation)?ref.senderRelation:'unknown'}};
}

export function quoteReplyText(reply) {
  const ref=reply.reference;
  const source=ref.senderRelation==='self'?'本账号的历史发言':ref.senderRelation==='other'?'其他人的历史发言':'来源身份未确认';
  return '[引用回复]\n被引用的历史消息（'+source+'）\n被引用人：'+(ref.senderName||'未知发言人')+
    (ref.time?'；原消息时间：'+ref.time:'')+'\n引用原文：'+ref.text+
    (ref.unavailable?'\n[引用正文或附件不可用，不能猜测未解析内容]':'')+
    (ref.truncated?'\n[引用内容已截断]':'')+
    '\n当前发言人的新回复：'+(reply.reply.slice(0,2000)||'[回复正文为空]')+
    (reply.truncated||reply.reply.length>2000?'\n[回复正文已截断]':'');
}

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
