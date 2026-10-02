import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConversationKey } from './conversation-key.js';

/** Small persistent recent-message buffer. Corrupt files fail closed and are never overwritten. */
export class MessageBuffer {
  constructor(file, { maxPerChat = 300 } = {}) {
    this.file = file;
    this.maxPerChat = Math.min(1000, Math.max(10, Number(maxPerChat) || 300));
    this.chats = new Map();
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.chats || typeof saved.chats !== 'object') throw new Error('invalid message buffer');
      for (const [key, rows] of Object.entries(saved.chats)) {
        if (!Array.isArray(rows)) throw new Error(`invalid message buffer chat ${key}`);
        this.chats.set(key, rows.slice(-this.maxPerChat).map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() })));
      }
    }
  }

  append(message, { outgoing = false } = {}) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    const row = { id: crypto.randomUUID(), platform: message.platform, kind: message.kind,
      conversation_id: String(message.conversation_id), sender_id: String(message.sender_id ?? ''),
      conversation_name: String(message.conversation_name ?? message.conversation_id),
      sender_name: String(message.sender_name ?? ''), message_id: String(message.message_id ?? ''),
      text: String(message.text ?? '').slice(0, 4000), timestamp: Number(message.timestamp) || Date.now() / 1000,
      images: outgoing ? [] : (message.images ?? []).filter(image => /^[a-f0-9]{64}$/.test(image?.id ?? '')).slice(0,4),
      direct_mention: Boolean(message.direct_mention), outgoing, processed: outgoing };
    const rows = this.chats.get(key) ?? [];
    rows.push(row);
    if (rows.length > this.maxPerChat) rows.splice(0, rows.length - this.maxPerChat);
    this.chats.set(key, rows);
    this.#save();
    return row;
  }

  recent(key, limit = 50) { return (this.chats.get(key) ?? []).slice(-Math.min(this.maxPerChat, Math.max(1, Number(limit) || 50))); }
  keys() { return [...this.chats.keys()]; }
  unread(key, limit = 50) { return this.recent(key, this.maxPerChat).filter((row) => !row.processed).slice(0, limit); }
  markProcessed(key, throughId = null) {
    const rows = this.chats.get(key) ?? [];
    if (throughId && !rows.some((row) => row.id === throughId)) return;
    for (const row of rows) {
      row.processed = true;
      if (throughId && row.id === throughId) break;
    }
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const chats = Object.fromEntries(this.chats);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, chats }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
