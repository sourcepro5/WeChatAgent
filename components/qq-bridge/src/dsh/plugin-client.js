import crypto from 'node:crypto';

export class DshPluginClient {
  constructor({ url = 'http://127.0.0.1:11230', token = process.env.SOCIAL_DSH_TOKEN, timeoutMs = 125000 } = {}, log = () => {}) {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
      throw new Error('DSH plugin URL must be loopback HTTP');
    }
    if (!token) throw new Error('SOCIAL_DSH_TOKEN is required');
    this.url = parsed.origin; this.token = token; this.timeoutMs = timeoutMs; this.log = log;
  }

  async searchReady(){
    if(this.searchHealthAt && Date.now()-this.searchHealthAt<3000)return this.searchSupported;
    try{const response=await fetch(this.url+'/health',{headers:{authorization:'Bearer '+this.token},signal:AbortSignal.timeout(2000)});
      const health=await response.json();
      this.searchSupported=response.ok&&health.searchBudget==='per-turn-count-v1'&&health.searchReasoning==='model-default-v1';
    }catch{this.searchSupported=false;}
    this.searchHealthAt=Date.now();return this.searchSupported;
  }

  async followup(conversationKey, message, metadata = {}) {
    const response = await fetch(`${this.url}/followup`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...metadata, conversationKey, message }), signal: AbortSignal.timeout(this.timeoutMs + (metadata.images?.length ? 80000 : 0)),
    });
    const body = await response.json();
    if (!response.ok && body.error === 'agent_unavailable' && body.detail === 'IMAGE_READER_NOT_READY' && metadata.images?.length) {
      // This specific failure occurs before admission of the model turn. Do
      // not retry model, integrity, permission or conversation-binding errors.
      this.log(`[Social] ${conversationKey} attachment_unavailable count=${metadata.images.length}; continuing with text`);
      const notice = '\n附件状态：本批图片附件读取失败，本轮没有提供图片。不得猜测或声称看到图片内容；可回应其他文字，图片问题请明确说明未能读取。';
      if (message.length + notice.length > 18000) throw new Error('IMAGE_FALLBACK_MESSAGE_TOO_LARGE');
      const fallbackMetadata={...metadata,images:[],...(metadata.batchId?{batchId:crypto.createHash('sha256').update(metadata.batchId+'\0without-images-v1').digest('hex')}:{})};
      const output=await this.followup(conversationKey,message.replace(/\n<sticker_label_request>[\s\S]*?<\/sticker_label_request>/g,'')+notice,fallbackMetadata);
      return output.split(/STICKER_LABELS:/)[0].trim();
    }
    if (!response.ok || body.error) {
      const budgetCode=typeof body.detail==='string'?/\bSEARCH_(?:TICKET_SPENT|MODEL_REQUEST_LIMIT|BUDGET_DENIED)\b/.exec(body.detail)?.[0]:null;
      const detail = budgetCode?` (${budgetCode})`:typeof body.detail === 'string' && /^[a-zA-Z_]{3,100}$/.test(body.detail) ? ` (${body.detail})` : '';
      throw new Error(`DSH plugin: ${body.error ?? response.status}${detail}`);
    }
    return String(body.text ?? '');
  }

  async maintainContext(conversationKey, bufferVersion) {
    const health = await fetch(this.url + '/health', { headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(2000) }).then(r => r.json());
    if (health.contextMaintenance !== 'idle-threshold-v1') throw Object.assign(Error('CONTEXT_PLUGIN_NOT_READY'), { code: 'CONTEXT_PLUGIN_NOT_READY' });
    const response = await fetch(this.url + '/context-maintenance', {
      method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationKey, bufferVersion }), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(Error('Context maintenance unavailable'), { code: /^[A-Z_]{3,100}$/.test(body.detail ?? '') ? body.detail : 'CONTEXT_MAINTENANCE_FAILED' });
    return body;
  }
}
