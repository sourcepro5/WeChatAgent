import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConversationKey } from './conversation-key.js';
import { normalizeForwardedRecord, normalizeQuoteReply } from './wechat-events.js';
import {STICKER_CANDIDATE_MAX} from './sticker-policy.js';
import {validReplyMessageLimit} from '../../../../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import {verifiedAssistantSender} from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';

export function replyDeliveryParts(result,deliveryId) {
  // A voice reply is one part; its text fallback is derived from the same delivery.
  const parts=result.decision==='RESPOND'?result.mode==='voice'?[{voiceText:result.text}]:(result.textParts??[result.text]).map(text=>({text})):[];
  if(result.stickerId)parts.push({stickerId:result.stickerId});
  return parts.map((part,index)=>({...part,deliveryId:index===0?deliveryId:crypto.createHash('sha256').update(deliveryId+(part.stickerId?'\0sticker':'\0text-'+(index+1))).digest('hex'),state:'queued'}));
}
function validReplyParts(item){
  if(item.parts===undefined)return true;
  const expected=replyDeliveryParts(item.result,item.deliveryId);
  return Array.isArray(item.parts)&&item.parts.length===expected.length&&item.parts.length<=(item.result.text?.length??0)+1&&item.parts.every((part,index)=>{
    const target=expected[index];
    return part&&part.text===target.text&&part.stickerId===target.stickerId&&part.voiceText===target.voiceText&&part.deliveryId===target.deliveryId&&
      (part.voiceFallback===undefined||part.voiceFallback===true&&typeof part.voiceText==='string')&&
      ['queued','sending','submitted','confirmed','unconfirmed','failed','cancelled','expired'].includes(part.state)&&
      ['busyAttempts','receiptChecks'].every(name=>part[name]===undefined||Number.isSafeInteger(part[name])&&part[name]>=0&&part[name]<=10)&&
      ['retryAt','busyDeadline'].every(name=>part[name]===undefined||Number.isSafeInteger(part[name])&&part[name]>=0);
  })&&(item.deliveryNotice===undefined||typeof item.deliveryNotice==='string'&&item.deliveryNotice.length<=1000);
}
function validPendingRequest(item){
  return item&&Array.isArray(item.rowIds)&&item.rowIds.length>0&&item.rowIds.length<=20&&item.rowIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=100)&&item.throughId===item.rowIds.at(-1)&&
    /^[a-f0-9]{64}$/.test(item.signature??'')&&typeof item.prompt==='string'&&item.prompt.length>0&&item.prompt.length<=18000&&
    item.metadata&&/^[a-f0-9]{64}$/.test(item.metadata.batchId??'')&&JSON.stringify(item.metadata.historyExcludeIds)===JSON.stringify(item.rowIds)&&
    (item.metadata.replyMaxMessages===undefined||validReplyMessageLimit(item.metadata.replyMaxMessages))&&
    [[item.stickerRefs,STICKER_CANDIDATE_MAX],[item.annotationRefs,4]].every(([refs,limit])=>refs&&typeof refs==='object'&&!Array.isArray(refs)&&Object.keys(refs).length<=limit&&Object.values(refs).every(id=>/^[a-f0-9]{64}$/.test(id)))&&Array.isArray(item.stickerChoices)&&item.stickerChoices.length<=STICKER_CANDIDATE_MAX&&JSON.stringify(item).length<=100000;
}

/** Small persistent recent-message buffer. Corrupt files fail closed and are never overwritten. */
export class MessageBuffer {
  constructor(file, { maxPerChat = 300, archive = null } = {}) {
    this.file = file;
    this.archive = archive;
    this.maxPerChat = Math.min(1000, Math.max(10, Number(maxPerChat) || 300));
    this.chats = new Map();
    this.pendingReplies=new Map();
    this.mediaReplies=new Map();
    this.contextNotices=new Map();
    this.pendingRequests=new Map();
    this.dshConnection=null;
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.chats || typeof saved.chats !== 'object') throw new Error('invalid message buffer');
      if(saved.dshConnection!==undefined&&saved.dshConnection!==null){
        const state=saved.dshConnection;
        if(state.version!==1||typeof state.ready!=='boolean'||!Number.isSafeInteger(state.epoch)||state.epoch<1||typeof state.instanceId!=='string'||state.instanceId.length>100||!Number.isFinite(state.cutoff)||state.cutoff<0)throw Error('invalid DSH connection boundary');
        this.dshConnection=state;
      }
      for (const [key, rows] of Object.entries(saved.chats)) {
        if (!Array.isArray(rows)) throw new Error(`invalid message buffer chat ${key}`);
        this.archive?.backfill(key,rows);
        this.chats.set(key, rows.slice(-this.maxPerChat).map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() })));
      }
      for(const [key,item] of Object.entries(saved.pendingReplies??{})){
        if(!item||!/^[a-f0-9]{64}$/.test(item.deliveryId??'')||typeof item.throughId!=='string'||
          !['RESPOND','STICKER'].includes(item.result?.decision)||
          item.result.decision==='RESPOND'&&(typeof item.result.text!=='string'||!item.result.text.trim()||item.result.text.length>(item.message?.work_mode==='assistant'?12000:1200))||
          item.result.textParts!==undefined&&(!Array.isArray(item.result.textParts)||item.result.textParts.length<2||item.result.textParts.length>item.result.text.length||item.result.textParts.some(part=>typeof part!=='string'||!part.trim())||item.result.textParts.join('\n\n')!==item.result.text)||
          item.result.decision==='STICKER'&&!/^[a-f0-9]{64}$/.test(item.result.stickerId??'')||!item.message||
          item.result.stickerId!==undefined&&!/^[a-f0-9]{64}$/.test(item.result.stickerId)||!validReplyParts(item)||
          buildConversationKey(item.message.platform,item.message.kind,item.message.conversation_id)!==key)throw Error('invalid reply outbox');
        this.pendingReplies.set(key,item);
      }
      for(const [key,item] of Object.entries(saved.contextNotices??{})){
        if(!item||typeof item.id!=='string'||typeof item.text!=='string'||item.text.length>1000)throw Error('invalid context notice');
        this.contextNotices.set(key,item);
      }
      for(const [key,item]of Object.entries(saved.pendingRequests??{})){
        if(!this.chats.has(key)||!validPendingRequest(item))throw Error('invalid pending model request');
        this.pendingRequests.set(key,item);
      }
      for(const [id,item] of Object.entries(saved.mediaReplies??{})){
        if(!/^[a-f0-9]{64}$/.test(id)||item?.part?.deliveryId!==id||!/^[a-f0-9]{64}$/.test(item.part.stickerId??'')||
          !['queued','sending','submitted'].includes(item.part.state)||!item.message||
          buildConversationKey(item.message.platform,item.message.kind,item.message.conversation_id)!==item.key||
          !['createdAt','expiresAt'].every(name=>Number.isSafeInteger(item[name])&&item[name]>=0)||item.expiresAt<item.createdAt||item.expiresAt-item.createdAt>60000||
          ['busyAttempts','receiptChecks'].some(name=>item.part[name]!==undefined&&(!Number.isSafeInteger(item.part[name])||item.part[name]<0||item.part[name]>10)))throw Error('invalid media outbox');
        this.mediaReplies.set(id,item);
      }
      if(this.mediaReplies.size>64)throw Error('media outbox limit');
    }
  }

  append(message, { outgoing = false,skipReason } = {}) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if(!outgoing){const existing=this.findIncoming(message);if(existing)return existing;}
    const row = { id: crypto.randomUUID(), platform: message.platform, kind: message.kind,
      conversation_id: String(message.conversation_id), sender_id: String(message.sender_id ?? ''),
      conversation_name: String(message.conversation_name ?? message.conversation_id),
      sender_name: String(message.sender_name ?? ''), message_id: String(message.message_id ?? ''),
      ...(!outgoing&&message.kind==='group'&&/^[a-f0-9]{64}$/.test(message.sender_key??'')?{sender_key:message.sender_key}:{}),
      ...(typeof message.sender_wxid==='string'?{sender_wxid:message.sender_wxid}:{}),
      self_id:String(message.self_id??''),...(message.work_mode?{work_mode:message.work_mode}:{}),
      ...(message.assistant_chat_only===true?{assistant_chat_only:true}:{}),
      text: String(message.text ?? '').slice(0, 4000), timestamp: Number(message.timestamp) || Date.now() / 1000,
      images: outgoing ? [] : (message.images ?? []).filter(image => /^[a-f0-9]{64}$/.test(image?.id ?? '')).slice(0,4),
      files:outgoing?[]:(message.files??[]).filter(file=>/^[a-f0-9]{64}$/.test(file?.id??'')&&typeof file.name==='string'&&file.name.length<=180&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=50*1024*1024).slice(0,3),
      direct_mention: Boolean(message.direct_mention), outgoing, processed: outgoing };
    if(!outgoing && message.interaction==='pat')row.interaction='pat';
    const record=!outgoing && normalizeForwardedRecord(message.forwardedRecord);
    if(record)row.forwardedRecord=record;
    const quoteReply=!outgoing && normalizeQuoteReply(message.quoteReply);
    if(quoteReply)row.quoteReply=quoteReply;
    if(!outgoing&&skipReason){
      row.processed=true;row.reply_skip_reason=skipReason;row.reply_skipped_at=Date.now();
      if(row.work_mode==='assistant')row.reply_review_required=true;
      this.contextNotices.set(key,{id:crypto.randomUUID(),text:'离线旧消息仅作为背景，不能逐条补答或自动执行旧任务。请根据恢复后的当前新消息处理。'});
    }
    const rows = this.chats.get(key) ?? [];
    this.archive?.append(key,row,{fullText:message.text});
    rows.push(row);
    if (rows.length > this.maxPerChat) rows.splice(0, rows.length - this.maxPerChat);
    this.chats.set(key, rows);
    this.#save();
    return row;
  }

  findIncoming(message){
    if(!message.message_id)return null;
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
    return (this.chats.get(key)??[]).find(row=>!row.outgoing&&row.message_id===String(message.message_id)&&
      row.sender_id===String(message.sender_id??'')&&row.text===String(message.text??'').slice(0,4000))??null;
  }
  rememberReply(key,item){
    const message=item.message;
    this.pendingRequests.delete(key);
    this.pendingReplies.set(key,{...item,message:{platform:message.platform,kind:message.kind,conversation_id:String(message.conversation_id),
      conversation_name:String(message.conversation_name??''),self_id:String(message.self_id??''),sender_id:String(message.sender_id??''),sender_name:String(message.sender_name??''),...(verifiedAssistantSender(message)?{sender_wxid:message.sender_wxid}:{}),...(message.work_mode?{work_mode:message.work_mode}:{}),...(message.assistant_chat_only===true?{assistant_chat_only:true}:{})}});
    this.#save();
  }
  forgetReply(key){this.pendingReplies.delete(key);this.#save();}
  rememberRequest(key,item){if(!validPendingRequest(item))throw Error('invalid pending model request');this.pendingRequests.set(key,structuredClone(item));this.#save();}
  forgetRequest(key){this.pendingRequests.delete(key);this.#save();}
  saveMedia(){this.#save();}
  skipOfflineInputs({before=Infinity,reason='dsh_offline'}={}){
    let skipped=0;
    for(const [key,rows]of this.chats){
      let changed=false;
      for(const row of rows)if(!row.outgoing&&!row.processed&&(before===Infinity||Number(row.timestamp)*1000<before)){
        row.processed=true;row.reply_skip_reason=reason;row.reply_skipped_at=Date.now();
        if(row.work_mode==='assistant')row.reply_review_required=true;
        skipped++;changed=true;
      }
      const request=this.pendingRequests.get(key);
      if(request&&request.rowIds.some(id=>rows.some(row=>row.id===id&&row.processed)))this.pendingRequests.delete(key);
      if(changed)this.contextNotices.set(key,{id:crypto.randomUUID(),text:'DSH 离线或重启期间的旧消息已留作历史，不逐条补答，也不把其中旧任务当成当前授权；只处理恢复后的新消息。旧助手任务请由管理员重新下达或明确继续。'});
    }
    this.#save();return skipped;
  }
  skipOfflineRow(row,reason='dsh_offline'){
    row.processed=true;row.reply_skip_reason=reason;row.reply_skipped_at=Date.now();
    if(row.work_mode==='assistant')row.reply_review_required=true;
    this.contextNotices.set(buildConversationKey(row.platform,row.kind,row.conversation_id),{id:crypto.randomUUID(),text:'离线旧消息仅作为背景，不能逐条补答或自动执行旧任务。请根据恢复后的当前新消息处理。'});
    this.#save();
  }
  setContextNotice(key,item){this.contextNotices.set(key,item);this.#save();}
  recordReplyPart(key,item,outgoing){
    if(outgoing)this.archive?.append(key,{...outgoing,outgoing:true,sender_name:'AI',delivery_id:item.deliveryId,message_id:'out-'+item.deliveryId});
    const rows=this.chats.get(key)??[];
    const existing=rows.find(row=>row.outgoing&&row.delivery_id===item.deliveryId);
    if(outgoing&&existing?.delivery_status==='unconfirmed'&&outgoing.delivery_status==='confirmed'){
      existing.delivery_status='confirmed';existing.text=String(outgoing.text).slice(0,4000);
    }
    if(outgoing&&!existing){
      rows.push({id:crypto.randomUUID(),platform:outgoing.platform,kind:outgoing.kind,conversation_id:String(outgoing.conversation_id),
        conversation_name:String(outgoing.conversation_name??''),sender_id:String(outgoing.sender_id??''),sender_name:'AI',
        message_id:'out-'+item.deliveryId,text:String(outgoing.text).slice(0,4000),timestamp:outgoing.timestamp,
        images:[],direct_mention:false,outgoing:true,processed:true,delivery_id:item.deliveryId,delivery_status:outgoing.delivery_status,proactive:outgoing.proactive===true,...(outgoing.work_mode?{work_mode:outgoing.work_mode}:{}),
        ...(/^[a-f0-9]{64}$/.test(outgoing.sticker_id??'')?{sticker_id:outgoing.sticker_id}:{})});
    }
    if(rows.length>this.maxPerChat)rows.splice(0,rows.length-this.maxPerChat);
    this.chats.set(key,rows);this.#save();
  }
  completeReply(key,item,outgoing){
    if(outgoing)this.recordReplyPart(key,item,outgoing);
    const rows=this.chats.get(key)??[];
    const through=rows.find(row=>row.id===item.throughId);if(through)for(const row of rows){if((row.work_mode??'social')===(through.work_mode??'social'))row.processed=true;if(row.id===item.throughId)break;}
    if(rows.length>this.maxPerChat)rows.splice(0,rows.length-this.maxPerChat);
    this.chats.set(key,rows);this.pendingReplies.delete(key);
    if(item.noticeId&&this.contextNotices.get(key)?.id===item.noticeId)this.contextNotices.delete(key);
    this.#save();
  }

  recent(key, limit = 50) { return (this.chats.get(key) ?? []).slice(-Math.min(this.maxPerChat, Math.max(1, Number(limit) || 50))); }
  keys() { return [...this.chats.keys()]; }
  unread(key, limit = 50) { return this.recent(key, this.maxPerChat).filter((row) => !row.processed).slice(0, limit); }
  markProcessed(key, throughId = null, noticeId = null) {
    const rows = this.chats.get(key) ?? [];
    if (throughId && !rows.some((row) => row.id === throughId)) return;
    const through=throughId?rows.find(row=>row.id===throughId):null;
    for (const row of rows) {
      if(!through||(row.work_mode??'social')===(through.work_mode??'social'))row.processed = true;
      if (throughId && row.id === throughId) break;
    }
    if(noticeId&&this.contextNotices.get(key)?.id===noticeId)this.contextNotices.delete(key);
    this.pendingRequests.delete(key);
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const chats = Object.fromEntries(this.chats);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, chats,dshConnection:this.dshConnection,pendingReplies:Object.fromEntries(this.pendingReplies),mediaReplies:Object.fromEntries(this.mediaReplies),contextNotices:Object.fromEntries(this.contextNotices),pendingRequests:Object.fromEntries(this.pendingRequests) }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
