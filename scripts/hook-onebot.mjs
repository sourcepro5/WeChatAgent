import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const onebotId = value => Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
export const conversationId = (wxid, name) => onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
class AdapterError extends Error { constructor(code) { super(code); this.name = 'AdapterError'; } }
const fail = code => { throw new AdapterError(code); };
const PAT_TYPE = 62 * 2 ** 32 + 49;
const cleanAccountId = value => String(value ?? '').replace(/_[a-zA-Z0-9]{4}$/, '');

export function textSegments(message) {
  if (typeof message === 'string') {
    // Raw OneBot strings may contain CQ segments. This sender only accepts text.
    if (/\[CQ:/i.test(message)) fail('TEXT_SEGMENTS_REQUIRED');
    message = [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message) || !message.length || message.some(s => s?.type !== 'text' || typeof s.data?.text !== 'string')) fail('TEXT_ONLY');
  const text = message.map(s => s.data.text).join('');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 16000) fail('INVALID_TEXT');
  return text;
}

export class HookOneBot {
  constructor({ directory = root, fetchImpl = fetch, receiptTimeoutMs, pollMs = 400 } = {}) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.receiptOverride = receiptTimeoutMs;
    this.pollMs = pollMs;
    this.socket = null;
    this.stopped = false;
    this.controllers = new Set();
    this.pending = [];
    this.seen = new Map();
    this.targetsSending = new Set();
    this.activeActions = 0;
    this.status = { backend: 'wechat-hook', ob_connected: false, reader_connected: false,
      hook_connected: false, hook_account_verified: false, received: 0, confirmed_sends: 0,
      failed_sends: 0, last_error: '', version: '' };
    this.reload();
  }
  reload() {
    this.project = read(path.join(this.directory, 'config', 'wechatagent.json'));
    this.api = read(path.join(this.directory, 'state', 'wechat-io-config.json'));
    this.hook = this.project.hook;
    if (this.project.runtime.sender !== 'wechat-hook' || !this.hook || this.project.runtime.weflowMode !== 'nt') fail('HOOK_NT_CONFIG_REQUIRED');
    const url = new URL(this.hook.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('HOOK_LOOPBACK_REQUIRED');
    this.nativeToken = fs.readFileSync(path.join(this.directory, 'state', 'hook', 'native-token.txt'), 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(this.nativeToken)) fail('HOOK_TOKEN_MISSING');
  }
  allowed(kind, target) { return this.project.wechat.whitelist[kind === 'group' ? 'groups' : 'private'].map(String).includes(String(target)); }
  async json(base, route, options = {}, timeout = 4000) {
    const response = await this.fetch(base.replace(/\/$/, '') + route, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) fail('API_HTTP_' + response.status);
    const result = await response.json();
    if (result?.success === false) fail('READER_NOT_READY');
    return result;
  }
  reader(route) { return this.json(this.api.reader_base_url, route, { headers: { Authorization: 'Bearer ' + this.api.reader_token } }); }
  native(route, body, account) {
    return this.json(this.hook.baseUrl, route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + this.nativeToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(account ? { 'X-WeChatAgent-Account': account } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.hook.requestTimeoutMs ?? 5000);
  }
  async checkNative() {
    this.status.hook_connected = false; this.status.hook_account_verified = false;
    const reader = await this.reader('/api/v1/reader/status');
    if (reader.backend !== 'weflow-cli-nt' || !reader.ownWxid || !reader.accountDirectory) fail('READER_ACCOUNT_METADATA_REQUIRED');
    this.ownWxid = reader.ownWxid;
    const native = await this.native('/WeChatAgent/health');
    this.status.hook_connected = true; this.status.version = native.version ?? '';
    if (native.integration !== 'WeChatAgent-1' || native.backend !== 'wechat-hook') fail('REVIEWED_HOOK_BUILD_REQUIRED');
    if (native.version !== this.hook.expectedVersion || native.version !== '4.1.10.27') fail('HOOK_VERSION_MISMATCH');
    if (!Array.isArray(native.databaseAccounts) || native.databaseAccounts.length !== 1 ||
        native.databaseAccounts[0] !== reader.accountDirectory.toLowerCase()) fail('HOOK_ACCOUNT_NOT_READY');
    this.status.hook_account_verified = true;
    return { account: reader.accountDirectory.toLowerCase(), selfId: onebotId(reader.ownWxid) };
  }
  async resolveTarget(kind, target) {
    const data = await this.reader('/api/v1/sessions?limit=500');
    const matches = (data.sessions ?? []).filter(s => s.username &&
      (s.username.includes('@chatroom') ? 'group' : 'private') === kind &&
      String(conversationId(s.username, s.displayName)) === String(target));
    if (matches.length !== 1 || matches[0].username === this.ownWxid) fail('TARGET_MAPPING_AMBIGUOUS_OR_MISSING');
    return matches[0].username;
  }
  async messages(wxid) {
    const result = await this.reader('/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=100');
    if (!Array.isArray(result.messages)) fail('INVALID_RECEIPT_RESPONSE');
    return result.messages;
  }
  async send(kind, target, text) {
    const key = `${kind}:${target}`;
    if (this.targetsSending.has(key) || this.targetsSending.size >= (this.hook.maxConcurrentSends ?? 4)) fail('SENDER_BUSY');
    this.targetsSending.add(key);
    try {
      const identity = await this.checkNative();
      const wxid = await this.resolveTarget(kind, target);
      // Exclude preexisting matching messages; repeated replies cannot reuse a receipt.
      const keyOf = row => JSON.stringify([row.localId, row.createTime]);
      const baseline = new Set((await this.messages(wxid)).map(keyOf));
      this.reload();
      if (!this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
      const started = Math.floor(Date.now() / 1000) - 1;
      const accepted = await this.native('/SendTextMsg', { wxidorgid: wxid, msg: text }, identity.account);
      if (accepted?.ret !== 0) fail('NATIVE_SEND_REJECTED');
      const deadline = Date.now() + (this.receiptOverride ?? this.hook.receiptTimeoutMs ?? 18000);
      do {
        for (const row of await this.messages(wxid)) {
          const body = row.fullText ?? row.content ?? row.parsedContent ?? '';
          if (row.isSend && Number.isSafeInteger(Number(row.localId)) && Number(row.localId) > 0 &&
              !baseline.has(keyOf(row)) && row.createTime >= started &&
              /^\d+$/.test(String(row.serverId)) && BigInt(row.serverId) > 0n && String(body).trim() === text.trim()) {
            this.status.confirmed_sends++; this.status.last_error = '';
            return { message_id: Number(row.localId), receipt: 'wechat-server-id', delivered: 'database-confirmed' };
          }
        }
        await sleep(this.pollMs);
      } while (Date.now() < deadline && !this.stopped);
      fail('NO_NEW_SERVER_RECEIPT');
    } finally { this.targetsSending.delete(key); }
  }
  async action(request) {
    const response = { status: 'failed', retcode: 1407, data: {}, ...(request?.echo === undefined ? {} : { echo: request.echo }) };
    this.activeActions++;
    try {
      if (this.activeActions > 8) fail('SENDER_BUSY');
      this.reload();
      const action = request?.action, params = request?.params ?? {};
      let data;
      if (['send_msg', 'send_private_msg', 'send_group_msg'].includes(action)) {
        const kind = action === 'send_group_msg' || (action === 'send_msg' && params.message_type === 'group') ? 'group' : 'private';
        if (action === 'send_msg' && !['group', 'private'].includes(params.message_type)) fail('MESSAGE_TYPE_REQUIRED');
        const target = String(params[kind === 'group' ? 'group_id' : 'user_id'] ?? '');
        if (!/^\d+$/.test(target) || !this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
        const text = textSegments(params.message);
        data = await this.send(kind, target, text);
      } else if (action === 'get_status') {
        data = { online: this.status.hook_account_verified, good: this.status.hook_account_verified && this.status.reader_connected };
      } else if (action === 'get_version_info') {
        data = { app_name: 'WeChatAgent-WeChat-Hook', app_version: '1', protocol_version: 'v11' };
      } else if (action === 'get_login_info') {
        data = { user_id: (await this.checkNative()).selfId, nickname: this.project.account.nicknames[0] };
      } else if (['get_friend_list', 'get_group_list'].includes(action)) {
        const kind = action === 'get_group_list' ? 'group' : 'private';
        const sessions = (await this.reader('/api/v1/sessions?limit=500')).sessions ?? [];
        data = sessions.filter(s => s.username && (s.username.includes('@chatroom') ? 'group' : 'private') === kind)
          .map(s => ({ id: conversationId(s.username, s.displayName), name: s.displayName ?? s.username }))
          .filter(s => this.allowed(kind, s.id)).map(s => kind === 'group' ? { group_id: s.id, group_name: s.name } : { user_id: s.id, nickname: s.name, remark: s.name });
      } else fail('ACTION_UNSUPPORTED');
      return { ...response, status: 'ok', retcode: 0, data };
    } catch (error) {
      const code = error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE';
      this.status.last_error = code;
      if (String(request?.action).startsWith('send_')) this.status.failed_sends++;
      return { ...response, retcode: code === 'ACTION_UNSUPPORTED' ? 1404 : 1407, message: code };
    } finally { this.activeActions--; }
  }
  incoming(payload) {
    this.reload();
    if (payload?.event !== 'message.new' || ![1,3,47,PAT_TYPE].includes(payload.type) || typeof payload.content !== 'string' || !payload.content.trim() || !payload.sessionId || !payload.talkerId || payload.isSend || payload.talkerId === this.ownWxid) return null;
    if ([3,47].includes(payload.type) && !/^[a-f0-9]{64}$/.test(payload.image?.id ?? '')) return null;
    if (payload.type === PAT_TYPE && (!this.ownWxid || payload.pat?.target !== cleanAccountId(this.ownWxid) || payload.pat?.actor !== payload.talkerId || payload.pat.actor === cleanAccountId(this.ownWxid))) return null;
    const group = payload.sessionId.includes('@chatroom'), kind = group ? 'group' : 'private';
    const target = conversationId(payload.sessionId, payload.groupName);
    if (!this.allowed(kind, target)) return null;
    const selfId = onebotId(this.ownWxid), userId = onebotId(group ? payload.talkerId : payload.sessionId);
    const segments = [{ type: 'text', data: { text: payload.content } }];
    if ([3,47].includes(payload.type)) segments.push({type:'image',data:{file:'wechatagent://image/'+payload.image.id,media_id:payload.image.id}});
    if (group && (payload.type === PAT_TYPE || this.project.account.nicknames.some(n => payload.content.includes('@' + n + '\u2005') || payload.content.endsWith('@' + n)))) segments.unshift({ type: 'at', data: { qq: String(selfId) } });
    return { time: payload.timestamp || Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'message',
      message_type: kind, sub_type: group ? 'normal' : 'friend', message_id: payload.rawid,
      user_id: userId, message: segments, raw_message: payload.content,
      sender: { user_id: userId, nickname: payload.sourceName || payload.senderName || String(userId) },
      ...(group ? { group_id: target, group_name: payload.groupName || String(target) } : {}) };
  }
  enqueue(payload) {
    const event = this.incoming(payload);
    if (!event || !event.message_id || this.seen.has(event.message_id)) return;
    if (this.pending.length >= 200) fail('EVENT_QUEUE_FULL');
    this.pending.push(event); this.seen.set(event.message_id, true);
    while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    this.status.received++; this.flush();
  }
  flush() {
    while (this.socket?.readyState === WebSocket.OPEN && this.pending.length) {
      const event = this.pending[0];
      // Recheck removed whitelist entries before forwarding buffered events.
      this.reload();
      if (this.allowed(event.message_type, event.message_type === 'group' ? event.group_id : event.user_id)) {
        try { this.socket.send(JSON.stringify(event)); } catch { return; }
      }
      this.pending.shift();
    }
  }
  async connectOneBot() {
    while (!this.stopped) {
      const socket = new WebSocket(this.api.onebot_ws_url);
      this.socket = socket;
      await new Promise(resolve => {
        const connectTimer = setTimeout(() => socket.close(), 8000);
        socket.addEventListener('open', () => {
          clearTimeout(connectTimer); this.status.ob_connected = true;
          socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: onebotId(this.ownWxid), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
          try { this.flush(); } catch { this.status.last_error = 'CONFIG_INVALID'; }
        });
        socket.addEventListener('message', async event => {
          let request;
          try { request = JSON.parse(String(event.data)); } catch { return; }
          if (!request || typeof request !== 'object' || Array.isArray(request)) return;
          const response = await this.action(request);
          if (socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify(response)); } catch {} }
        });
        socket.addEventListener('error', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
      });
      socket.close(); this.status.ob_connected = false;
      if (!this.stopped) await sleep(1500);
    }
  }
  async receiveSse() {
    while (!this.stopped) {
      const controller = new AbortController(); this.controllers.add(controller);
      let watchdog = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await this.fetch(this.api.reader_base_url + '/api/v1/push/messages', {
          headers: { Authorization: 'Bearer ' + this.api.reader_token }, signal: controller.signal, redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) fail('READER_STREAM_UNAVAILABLE');
        this.status.reader_connected = true;
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 35000);
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 256000) fail('READER_EVENT_TOO_LARGE');
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).trimEnd(); buffer = buffer.slice(at + 1);
            if (line.startsWith('data:')) this.enqueue(JSON.parse(line.slice(5)));
          }
          if (this.stopped) break;
        }
      } catch { if (!this.stopped) this.status.last_error = 'READER_STREAM_UNAVAILABLE'; }
      finally { clearTimeout(watchdog); controller.abort(); this.controllers.delete(controller); this.status.reader_connected = false; }
      if (!this.stopped) await sleep(1500);
    }
  }
  async start() {
    await this.checkNative();
    this.server = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(this.status));
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>WeChatAgent</title><h1>WeChatAgent · WeChat-Hook</h1><p>OneBot v11 · 后台文字发送</p><pre id="status">加载中</pre><script>async function update(){try{document.getElementById("status").textContent=JSON.stringify(await(await fetch("/status")).json(),null,2)}catch{document.getElementById("status").textContent="状态服务未连接"}}update();setInterval(update,2000)</script>');
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.project.ports.adapter, '127.0.0.1', resolve); });
    this.tasks = [this.connectOneBot(), this.receiveSse()];
    let checking = false;
    this.healthTimer = setInterval(async () => {
      if (checking || this.stopped) return;
      checking = true;
      try { await this.checkNative(); }
      catch (error) { this.status.last_error = error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE'; }
      finally { checking = false; }
    }, 5000);
    console.log('WeChat-Hook OneBot v11 adapter ready; native account/version verified.');
  }
  async stop() {
    this.stopped = true; for (const controller of this.controllers) controller.abort();
    clearInterval(this.healthTimer);
    this.socket?.close();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await Promise.allSettled(this.tasks ?? []);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adapter = new HookOneBot();
  try {
    if (process.argv.includes('--check')) {
      await adapter.checkNative(); console.log('WeChat-Hook: matching version and selected account database verified.');
    } else {
      await adapter.start();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await adapter.stop(); process.exit(0); });
    }
  } catch (error) { console.error('WeChat-Hook check failed: ' + (error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE')); process.exitCode = 1; }
}
