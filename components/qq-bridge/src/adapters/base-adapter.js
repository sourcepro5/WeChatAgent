import { EventEmitter } from 'node:events';

export class BaseAdapter extends EventEmitter {
  constructor(platform, capabilities = {}) {
    super();
    this.platform = platform;
    this.capabilities = Object.freeze({ text: true, image: false, quoteReply: false,
      nativeReply: false, groupHistory: false, history: false, unreadMessages: false,
      unread: false, groupMember: false, mention: false, poke: false, ...capabilities });
    this.stats = { connected: false, messages: 0, sends: 0, errors: 0 };
  }

  onMessage(callback) { this.on('message', callback); return this; }
  async start() { throw new Error('start() is not implemented'); }
  async stop() { throw new Error('stop() is not implemented'); }
  async sendText() { throw new Error('sendText() is not implemented'); }
  async sendReply() { throw new Error('unsupported capability: quoteReply'); }
  async getSelfInfo() { return null; }
  getStatus() { return { platform: this.platform, capabilities: this.capabilities, ...this.stats }; }
}
