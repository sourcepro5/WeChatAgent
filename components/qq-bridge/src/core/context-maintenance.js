import { contextPolicy, contextRowsIdle, contextBufferVersion } from '../../../../packages/dsh-social-bridge-plugin/context-policy.mjs';

export class ContextMaintenance {
  constructor({ buffer, social, settingsFor, maintain, isReady = () => true, proactivePending = () => false, now = Date.now, log = () => {} }) {
    Object.assign(this, { buffer, social, settingsFor, maintain, isReady, proactivePending, now, log });
    this.busy = false; this.stopped = false; this.retryAt = new Map();
  }
  eligible(key, policy) {
    return policy.enabled && !this.buffer.pendingReplies.has(key) && !this.proactivePending(key) && contextRowsIdle(this.buffer.recent(key, this.buffer.maxPerChat), policy.idleSeconds, this.now());
  }
  async tick() {
    if (this.busy || this.stopped || !this.isReady()) return;
    this.busy = true;
    try {
      const settings = await this.settingsFor(), wechat = settings.wechat ?? settings;
      if (wechat.context?.enabled !== true) return;
      const keys = ['private', 'group'].flatMap(kind => (wechat.whitelist?.[kind === 'group' ? 'groups' : 'private'] ?? []).map(id => `wechat:${kind}:${id}`));
      for (const key of keys) {
        if (this.stopped) break;
        if (this.now() < (this.retryAt.get(key) ?? 0) || !this.eligible(key, contextPolicy(wechat, key))) continue;
        await this.social.withConversationLock(key, async () => {
          const fresh = await this.settingsFor(), policy = contextPolicy(fresh.wechat ?? fresh, key);
          if (this.stopped || !this.eligible(key, policy)) return;
          try {
            const result = await this.maintain(key, contextBufferVersion(this.buffer.recent(key, this.buffer.maxPerChat)));
            if (result.compacted) this.log(`[Context] ${key} compacted tokens=${result.tokensBefore}->${result.contextTokens}`);
          } catch (error) {
            this.retryAt.set(key, this.now() + 300000);
            this.log(`[Context] ${key} maintenance_wait code=${error.code ?? 'unavailable'}`);
          }
        });
      }
    } catch { this.log('[Context] maintenance unavailable; settings or state could not be read'); }
    finally { this.busy = false; }
  }
  stop() { this.stopped = true; }
}
