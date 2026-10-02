import crypto from 'node:crypto';
import { BaseAdapter } from '../base-adapter.js';
import { ReverseOneBotServer } from '../../onebot/reverse-ws-server.js';
import { normalizeOneBotEvent } from '../../onebot/normalize.js';

export class WechatOneBotAdapter extends BaseAdapter {
  constructor(config = {}, log = () => {}) {
    super('wechat', { mention: true });
    this.log = log;
    this.server = new ReverseOneBotServer(config.server ?? {});
    this.recentOutgoing = new Map();
    this.recentIncoming = new Map();
    this.antiLoopTtlMs = Math.max(1000, Number(config.antiLoopTtlMs) || 60000);
    this.server.on('open', () => { this.stats.connected = true; this.emit('open'); });
    this.server.on('close', () => { this.stats.connected = false; this.emit('close'); });
    this.server.on('error', (error) => { this.stats.errors++; this.emit('error', error); });
    this.server.on('invalid', (kind) => { this.stats.errors++; this.log(`[WeChat] ${kind}`); });
    this.server.on('event', (event) => this.#receive(event));
  }

  #fingerprint(kind, target, content) {
    return crypto.createHash('sha256').update(JSON.stringify([kind, String(target), String(content).trim()])).digest('hex');
  }

  #prune(now) {
    for (const cache of [this.recentOutgoing, this.recentIncoming]) {
      for (const [key, expires] of cache) if (expires <= now) cache.delete(key);
      while (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
  }

  #receive(event) {
    if (event?.post_type === 'meta_event') { this.emit('meta', event); return; }
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    if (!message) return;
    if (!['text','image'].includes(message.message_type) || message.message_type === 'image' && !message.images.length) { this.log(`[WeChat] unsupported_message_type=${message.message_type}`); return; }
    if (!message.text) return;
    const now = Date.now(); this.#prune(now);
    const key = this.#fingerprint(message.kind, message.conversation_id, message.text);
    const selfId = message.self_id;
    if (selfId && (message.sender_id === selfId || String(event.user_id ?? '') === selfId)) return;
    if (this.recentOutgoing.has(key)) return;
    const incomingKey = `${message.message_id}:${key}`;
    if (this.recentIncoming.has(incomingKey)) return;
    this.recentIncoming.set(incomingKey, now + this.antiLoopTtlMs);
    this.stats.messages++; this.emit('message', message);
  }

  async start() { await this.server.start(); }
  async stop() { await this.server.stop(); }
  async sendText({ kind, target, text }) {
    if (kind !== 'private' && kind !== 'group') throw new TypeError('invalid WeChat kind');
    const content = String(text ?? '').trim();
    if (!content) throw new TypeError('empty WeChat message');
    const id = Number(target);
    // Only synthetic numeric IDs resolved by the WeChat I/O service are accepted.
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('WeChat target must be a synthetic integer ID');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = { [kind === 'group' ? 'group_id' : 'user_id']: id,
      message: [{ type: 'text', data: { text: content } }] };
    const result = await this.server.action(action, params);
    // The I/O service acknowledges only after a new matching server receipt.
    if (result.data?.receipt !== 'wechat-server-id') throw new Error('WeChat send response has no verified server receipt');
    this.#prune(Date.now());
    this.recentOutgoing.set(this.#fingerprint(kind, id, content), Date.now() + this.antiLoopTtlMs);
    this.stats.sends++; return { accepted: true, response: result, delivered: 'database-confirmed' };
  }
  async sendPrivateMessage(target, text) { return this.sendText({ kind: 'private', target, text }); }
  async sendGroupMessage(target, text) { return this.sendText({ kind: 'group', target, text }); }
  async reply() { throw new Error('unsupported_capability: nativeReply'); }
  getCapabilities() { return this.capabilities; }
}
