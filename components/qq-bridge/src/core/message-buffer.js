import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConversationKey } from './conversation-key.js';
import { normalizeForwardedRecord, normalizeQuoteReply } from './wechat-events.js';

/** Small persistent recent-message buffer. Corrupt files fail closed and are never overwritten. */
export class MessageBuffer {
  constructor(file, { maxPerChat = 300 } = {}) {
    this.file = file;
    this.maxPerChat = Math.min(1000, Math.max(10, Number(maxPerChat) || 300));
    this.chats = new Map();
    this.pendingReplies=new Map();
    this.contextNotices=new Map();
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.chats || typeof saved.chats !== 'object') throw new Error('invalid message buffer');
      for (const [key, rows] of Object.entries(saved.chats)) {
        if (!Array.isArray(rows)) throw new Error(`invalid message buffer chat ${key}`);
        this.chats.set(key, rows.slice(-this.maxPerChat).map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() })));
      }
      for(const [key,item] of Object.entries(saved.pendingReplies??{})){
        if(!item||!/^[a-f0-9]{64}$/.test(item.deliveryId??'')||typeof item.throughId!=='string'||
          !['RESPOND','STICKER'].includes(item.result?.decision)||
          item.result.decision==='RESPOND'&&(typeof item.result.text!=='string'||!item.result.text.trim()||item.result.text.length>1200)||
          item.result.decision==='STICKER'&&!/^[a-f0-9]{64}$/.test(item.result.stickerId??'')||!item.message||
          buildConversationKey(item.message.platform,item.message.kind,item.message.conversation_id)!==key)throw Error('invalid reply outbox');
        this.pendingReplies.set(key,item);
      }
      for(const [key,item] of Object.entries(saved.contextNotices??{})){
        if(!item||typeof item.id!=='string'||typeof item.text!=='string'||item.text.length>1000)throw Error('invalid context notice');
        this.contextNotices.set(key,item);
      }
    }
  }

  append(message, { outgoing = false } = {}) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if(!outgoing){const existing=this.findIncoming(message);if(existing)return existing;}
    const row = { id: crypto.randomUUID(), platform: message.platform, kind: message.kind,
      conversation_id: String(message.conversation_id), sender_id: String(message.sender_id ?? ''),
      conversation_name: String(message.conversation_name ?? message.conversation_id),
      sender_name: String(message.sender_name ?? ''), message_id: String(message.message_id ?? ''),
      self_id:String(message.self_id??''),
      text: String(message.text ?? '').slice(0, 4000), timestamp: Number(message.timestamp) || Date.now() / 1000,
      images: outgoing ? [] : (message.images ?? []).filter(image => /^[a-f0-9]{64}$/.test(image?.id ?? '')).slice(0,4),
      direct_mention: Boolean(message.direct_mention), outgoing, processed: outgoing };
    if(!outgoing && message.interaction==='pat')row.interaction='pat';
    const record=!outgoing && normalizeForwardedRecord(message.forwardedRecord);
    if(record)row.forwardedRecord=record;
    const quoteReply=!outgoing && normalizeQuoteReply(message.quoteReply);
    if(quoteReply)row.quoteReply=quoteReply;
    const rows = this.chats.get(key) ?? [];
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
    this.pendingReplies.set(key,{...item,message:{platform:message.platform,kind:message.kind,conversation_id:String(message.conversation_id),
      conversation_name:String(message.conversation_name??''),self_id:String(message.self_id??''),sender_id:String(message.sender_id??''),sender_name:String(message.sender_name??'')}});
    this.#save();
  }
  forgetReply(key){this.pendingReplies.delete(key);this.#save();}
  setContextNotice(key,item){this.contextNotices.set(key,item);this.#save();}
  completeReply(key,item,outgoing){
    const rows=this.chats.get(key)??[];
    if(outgoing&&!rows.some(row=>row.outgoing&&row.delivery_id===item.deliveryId)){
      rows.push({id:crypto.randomUUID(),platform:outgoing.platform,kind:outgoing.kind,conversation_id:String(outgoing.conversation_id),
        conversation_name:String(outgoing.conversation_name??''),sender_id:String(outgoing.sender_id??''),sender_name:'AI',
        message_id:'out-'+item.deliveryId,text:String(outgoing.text).slice(0,4000),timestamp:outgoing.timestamp,
        images:[],direct_mention:false,outgoing:true,processed:true,delivery_id:item.deliveryId,delivery_status:outgoing.delivery_status,proactive:outgoing.proactive===true});
    }
    if(rows.some(row=>row.id===item.throughId))for(const row of rows){row.processed=true;if(row.id===item.throughId)break;}
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
    for (const row of rows) {
      row.processed = true;
      if (throughId && row.id === throughId) break;
    }
    if(noticeId&&this.contextNotices.get(key)?.id===noticeId)this.contextNotices.delete(key);
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const chats = Object.fromEntries(this.chats);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, chats,pendingReplies:Object.fromEntries(this.pendingReplies),contextNotices:Object.fromEntries(this.contextNotices) }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
