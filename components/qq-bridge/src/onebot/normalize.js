import crypto from 'node:crypto';
import { normalizeForwardedRecord, normalizeQuoteReply } from '../core/wechat-events.js';

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
  const images = segments.filter(segment => segment?.type === 'image' && /^[a-f0-9]{64}$/.test(segment.data?.media_id ?? '') && segment.data?.file === 'wechatagent://image/'+segment.data.media_id)
    .map(segment => ({id:segment.data.media_id,...(platform==='wechat'&&segment.data.media_kind==='sticker'?{kind:'sticker'}:{})}));
  const messageType = types.length === 0 || types.every((type) => type === 'text' || type === 'at') ? 'text' : types.find((type) => type !== 'text' && type !== 'at');
  const timestamp = Number(event.time ?? Date.now() / 1000);
  const quoteReply=platform==='wechat'?normalizeQuoteReply(event.wechatagent?.quoteReply):null;
  // A peer may omit message_id. A stable fingerprint only deduplicates a short receive window.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([platform, kind, conversationId, senderId, text, timestamp])).digest('hex').slice(0, 24);
  return {
    platform, adapter, kind, conversation_id: conversationId, sender_id: senderId,
    conversation_name: String(kind === 'group' ? event.group_name ?? conversationId : event.sender?.nickname ?? conversationId),
    sender_name: String(event.sender?.card ?? event.sender?.nickname ?? senderId),
    self_id: String(event.self_id ?? ''), message_id: String(event.message_id ?? `local-${fingerprint}`),
    message_type: messageType ?? 'unknown', text: text || (images.length ? '[图片]' : ''), images, timestamp, segments, raw: event,
    ...(platform==='wechat' && event.wechatagent?.interaction==='pat'?{interaction:'pat'}:{}),
    ...(platform==='wechat' && normalizeForwardedRecord(event.wechatagent?.forwardedRecord)?{forwardedRecord:normalizeForwardedRecord(event.wechatagent.forwardedRecord)}:{}),
    ...(quoteReply?{quoteReply}:{}),
  };
}
