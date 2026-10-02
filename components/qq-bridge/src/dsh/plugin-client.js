export class DshPluginClient {
  constructor({ url = 'http://127.0.0.1:11230', token = process.env.SOCIAL_DSH_TOKEN, timeoutMs = 125000 } = {}) {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
      throw new Error('DSH plugin URL must be loopback HTTP');
    }
    if (!token) throw new Error('SOCIAL_DSH_TOKEN is required');
    this.url = parsed.origin; this.token = token; this.timeoutMs = timeoutMs;
  }

  async followup(conversationKey, message, metadata = {}) {
    const response = await fetch(`${this.url}/followup`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...metadata, conversationKey, message }), signal: AbortSignal.timeout(this.timeoutMs + (metadata.images?.length ? 80000 : 0)),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const detail = typeof body.detail === 'string' && /^[A-Z_]{3,100}$/.test(body.detail) ? ` (${body.detail})` : '';
      throw new Error(`DSH plugin: ${body.error ?? response.status}${detail}`);
    }
    return String(body.text ?? '');
  }
}
