import crypto from 'node:crypto';
import {verifiedAssistantSender} from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import { normalizeForwardedRecord, normalizeQuoteReply, normalizeSharedCard } from '../core/wechat-events.js';

export function normalizeOneBotEvent(platform, adapter, event) {
  if (!event || event.post_type !== 'message' && event.post_type !== undefined) return null;
  const kind = event.message_type;
  if (kind !== 'private' && kind !== 'group') return null;
  const conversationId = String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? '');
  const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
  if (!conversationId || !senderId) return null;
  const segments = typeof event.message === 'string'
    ? [{ type: 'text', data: { text: event.message } }]
    : Array.isArray(event.message) ? event.message : [];
  const text = segments.filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? '')).join('').trim();
  const types = [...new Set(segments.map((segment) => segment?.type).filter(Boolean))];
  const voice=platform==='wechat'?segments.find(segment=>segment?.type==='record'&&/^[a-f0-9]{64}$/.test(segment.data?.voice_id??'')&&segment.data.file==='wechatagent://voice/'+segment.data.voice_id&&Number.isFinite(segment.data.duration)&&segment.data.duration>0&&segment.data.duration<=60):null;
  const images = segments.filter(segment => segment?.type === 'image' && /^[a-f0-9]{64}$/.test(segment.data?.media_id ?? '') && segment.data?.file === 'wechatagent://image/'+segment.data.media_id)
    .map(segment => ({id:segment.data.media_id,...(platform==='wechat'&&segment.data.media_kind==='sticker'?{kind:'sticker'}:{})}));
  const files=platform==='wechat'?segments.filter(segment=>segment?.type==='file'&&/^[a-f0-9]{64}$/.test(segment.data?.id??'')&&typeof segment.data?.name==='string'&&segment.data.name.length<=180&&Number.isSafeInteger(segment.data.size)&&segment.data.size>=0&&segment.data.size<=50*1024*1024).slice(0,3).map(segment=>({id:segment.data.id,name:segment.data.name,size:segment.data.size})):[];
  const messageType = types.length === 0 || types.every((type) => type === 'text' || type === 'at') ? 'text' : types.find((type) => type !== 'text' && type !== 'at');
  const timestamp = Number(event.time ?? Date.now() / 1000);
  const quoteReply=platform==='wechat'?normalizeQuoteReply(event.wechatagent?.quoteReply):null;
  const sharedCard=platform==='wechat'?normalizeSharedCard(event.wechatagent?.sharedCard):null;
  // A peer may omit message_id. A stable fingerprint only deduplicates a short receive window.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([platform, kind, conversationId, senderId, text, timestamp])).digest('hex').slice(0, 24);
  return {
    platform, adapter, kind, conversation_id: conversationId, sender_id: senderId,
    ...(verifiedAssistantSender({platform,kind,conversation_id:conversationId,sender_id:senderId,sender_wxid:event.wechatagent?.senderWxid})?{sender_wxid:event.wechatagent.senderWxid}:{}),
    conversation_name: String(kind === 'group' ? event.group_name ?? conversationId : event.sender?.nickname ?? conversationId),
    sender_name: String(event.sender?.card ?? event.sender?.nickname ?? senderId),
    ...(platform==='wechat'&&kind==='group'&&/^[a-f0-9]{64}$/.test(event.wechatagent?.memberId??'')?{sender_key:event.wechatagent.memberId}:{}),
    self_id: String(event.self_id ?? ''), message_id: String(event.message_id ?? `local-${fingerprint}`),
    message_type: messageType ?? 'unknown', text: text || (images.length ? '[图片]' : ''), images, files, timestamp, segments, raw: event,
    ...(voice?{voice:{id:voice.data.voice_id,durationSeconds:voice.data.duration}}:{}),
    ...(platform==='wechat' && event.wechatagent?.interaction==='pat'?{interaction:'pat'}:{}),
    ...(platform==='wechat' && normalizeForwardedRecord(event.wechatagent?.forwardedRecord)?{forwardedRecord:normalizeForwardedRecord(event.wechatagent.forwardedRecord)}:{}),
    ...(quoteReply?{quoteReply}:{}),
    ...(sharedCard?{sharedCard}:{}),
  };
}
