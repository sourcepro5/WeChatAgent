import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import { encodeVoice, validateSilk, voicePcm } from './decode-wechat-voice.mjs';
import {VoiceSynthesis,outputFeature} from './voice-synthesis.mjs';

const route = '/api/voice/send';
const textRoute = '/api/voice/send-text';
const maxWavBytes = 2 * 1024 * 1024;
const maxRequestBytes = 4 * Math.ceil(maxWavBytes / 3) + 1024;
const deliveryPattern = /^[A-Za-z0-9_-]{1,80}$/;
// Host-owned deliveries (Realtime turns, DSH voice replies) cannot be claimed by API callers.
const dialogueId = /^(?:realtime|dsh)-[a-f0-9]{64}$/;
const chatPattern = /^wechat:(private|group):([1-9][0-9]{0,15})$/;
const operationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const nativeReceiptRoute = '/WeChatAgent/voice-deliveries/';
const bad = (code, status) => Object.assign(new Error(code), { code, status });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const localId = value => Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/.test(String(value));
const serverId = value => /^[1-9][0-9]{0,31}$/.test(String(value));
const fingerprintWindowMs = 60000;

function applyHelperMapping(job, mapping) {
  if (mapping?.operationId !== job.operationId || mapping.state !== 'accepted') return false;
  const exactTarget = mapping.target === job.wxid;
  if (!exactTarget && !(mapping.target === undefined && job.wxid === 'filehelper')) return false;
  const messageId = exactTarget && localId(mapping.localId) ? String(mapping.localId) : undefined;
  const changed = !job.submitted || Boolean(messageId && !job.localId);
  job.submitted = true;
  if (messageId && !job.localId) job.localId = messageId;
  return changed;
}

function applyNativeMapping(job, mapping) {
  if (!job.receiptAccount || mapping?.operationId !== job.operationId || mapping.target !== job.wxid) return false;
  if (mapping.state === 'accepted' && mapping.ret === 0 && !job.submitted) {
    job.submitted = true;
    return true;
  }
  if (mapping.state === 'rejected' && mapping.ret === 1 && !job.submitted && !job.rejected) {
    job.rejected = true;
    return true;
  }
  return false;
}

function replaceFile(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, value, { flag: 'wx', flush: true, mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(JSON.stringify(body));
}

async function readUpload(req, textOnly) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw bad('VOICE_JSON_REQUIRED', 415);
  }
  const limit = textOnly ? 32 * 1024 : maxRequestBytes;
  if (Number(req.headers['content-length']) > limit) throw bad('VOICE_TOO_LARGE', 413);
  const timer = setTimeout(() => req.destroy(), 10000);
  timer.unref();
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) throw bad('VOICE_TOO_LARGE', 413);
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad('VOICE_INVALID_REQUEST', 400); }
  const { conversationKey, deliveryId, wavBase64, text } = data ?? {};
  const chat = typeof conversationKey === 'string' && chatPattern.exec(conversationKey);
  if (!chat || !Number.isSafeInteger(Number(chat[2])) || typeof deliveryId !== 'string' || !deliveryPattern.test(deliveryId) ||
      dialogueId.test(deliveryId)) {
    throw bad('VOICE_INVALID_REQUEST', 400);
  }
  if (textOnly) {
    if (wavBase64 !== undefined || typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw bad('VOICE_TTS_INVALID_TEXT', 400);
    }
    return {deliveryId, kind: chat[1], target: chat[2], text: text.trim()};
  }
  if (text !== undefined || typeof wavBase64 !== 'string' || !wavBase64.length || wavBase64.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(wavBase64)) throw bad('VOICE_INVALID_REQUEST', 400);
  const wav = Buffer.from(wavBase64, 'base64');
  if (wav.length > maxWavBytes) throw bad('VOICE_TOO_LARGE', 413);
  if (wav.toString('base64') !== wavBase64) throw bad('VOICE_INVALID_REQUEST', 400);
  return { deliveryId, kind: chat[1], target: chat[2], wav };
}

export class VoiceSend {
  constructor(adapter) {
    this.adapter = adapter;
    this.tokenFile = path.join(adapter.directory, 'state', 'voice-send.token');
    this.directory = path.join(adapter.directory, 'state', 'voice-deliveries');
    this.synthesis = new VoiceSynthesis(adapter.directory, {fetchImpl: adapter.fetch});
    this.active = new Set();
    this.receiptPolls = new Set();
    this.requests = 0;
  }

  handle(req, res) {
    if (req.url !== route && req.url !== textRoute && !req.url?.startsWith(route + '/')) return false;
    void this.request(req, res).catch(error => {
      const status = error.status ?? (error.message === 'TARGET_MAPPING_AMBIGUOUS_OR_MISSING' ? 409 : 503);
      const code = typeof error.code === 'string' && error.code.startsWith('VOICE_') ? error.code : 'VOICE_BACKEND_UNAVAILABLE';
      json(res, status, { error: code });
    });
    return true;
  }

  authorized(header) {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1];
    if (!supplied) return false;
    let token;
    try { token = fs.readFileSync(this.tokenFile, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return /^[a-f0-9]{64}$/.test(token) &&
      crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(supplied, 'hex'));
  }

  async request(req, res) {
    if (!this.authorized(req.headers.authorization)) throw bad('VOICE_UNAUTHORIZED', 401);
    const textOnly = req.url === textRoute;
    const id = req.url === route || textOnly ? null : req.url.slice(route.length + 1);
    if (id !== null && !deliveryPattern.test(id)) throw bad('VOICE_INVALID_REQUEST', 400);
    if (req.method !== (id === null ? 'POST' : 'GET')) throw bad('VOICE_METHOD_NOT_ALLOWED', 405);
    if (this.requests >= 4) throw bad('VOICE_SENDER_BUSY', 429);
    this.requests++;
    try {
      const upload = id === null ? await readUpload(req, textOnly) : null;
      const deliveryId = id ?? upload.deliveryId;
      if (this.active.has(deliveryId)) throw bad('VOICE_SENDER_BUSY', 429);
      this.active.add(deliveryId);
      try {
        const job = this.load(deliveryId);
        if (!job && !upload) throw bad('VOICE_DELIVERY_NOT_FOUND', 404);
        const result = job ? await this.status(job, upload) : textOnly ? await this.sendText(upload) : await this.send(upload);
        json(res, result.status === 'pending' ? 202 : 200, result);
      } finally {
        this.active.delete(deliveryId);
      }
    } finally {
      this.requests--;
    }
  }

  file(deliveryId) {
    return path.join(this.directory, sha256(deliveryId) + '.json');
  }

  load(deliveryId) {
    try {
      const job = JSON.parse(fs.readFileSync(this.file(deliveryId), 'utf8'));
      if (job.deliveryId !== deliveryId || job.version !== 1 || !operationPattern.test(job.operationId) ||
          !chatPattern.test('wechat:' + job.kind + ':' + job.target) || !Array.isArray(job.baseline) ||
          !Number.isSafeInteger(job.startedAt) || !Number.isSafeInteger(job.deadline) ||
          (job.localId !== undefined && !localId(job.localId)) ||
          (job.silkSha256 !== undefined && !/^[a-f0-9]{64}$/.test(job.silkSha256))) throw bad('VOICE_STATE_INVALID', 503);
      return job;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(job, create = false) {
    fs.mkdirSync(this.directory, { recursive: true });
    const dest = this.file(job.deliveryId);
    if (create) {
      try { fs.writeFileSync(dest, JSON.stringify(job), { flag: 'wx', flush: true, mode: 0o600 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw bad('VOICE_SENDER_BUSY', 429);
        throw error;
      }
      return;
    }
    replaceFile(dest, JSON.stringify(job));
  }

  fingerprintFile(job) {
    return path.join(this.directory, 'content-claims', sha256(JSON.stringify([job.receiptAccount ?? job.senderAccount, job.wxid, job.silkSha256])));
  }

  reserveFingerprint(job) {
    const file = this.fingerprintFile(job);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const options = { flag: 'wx', flush: true, mode: 0o600 };
    try { fs.writeFileSync(file, job.deliveryId, options); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = this.load(fs.readFileSync(file, 'utf8'));
      if (previous && this.fingerprintFile(previous) === file && this.ownsUniqueFingerprint(previous) &&
          (previous.rejected || previous.confirmed && job.baseline.includes(previous.localId))) {
        replaceFile(file, job.deliveryId);
        return;
      }
      // An unresolved earlier send makes these bytes ambiguous for both deliveries.
      try { fs.writeFileSync(file + '.multiple', '', options); }
      catch (markerError) { if (markerError.code !== 'EEXIST') throw markerError; }
    }
  }

  ownsUniqueFingerprint(job) {
    if (!job.silkSha256) return false;
    const file = this.fingerprintFile(job);
    try { if (fs.readFileSync(file, 'utf8') !== job.deliveryId) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try { fs.statSync(file + '.multiple'); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }

  checkAllowed(kind, target) {
    this.adapter.reload();
    if (this.adapter.stopped) throw bad('VOICE_BACKEND_UNAVAILABLE', 503);
    if (!this.adapter.allowed(kind, target)) throw bad('VOICE_CONVERSATION_NOT_ALLOWED', 403);
  }

  async identity(kind, target, job) {
    this.checkAllowed(kind, target);
    const { account, senderAccount, receiptAccount, voiceSenderWxid, voiceSend, voiceTransport, voiceTargets } = await this.adapter.checkNative();
    const wxid = await this.adapter.resolveTarget(kind, target);
    this.checkAllowed(kind, target);
    if (job && (job.account !== account || job.wxid !== wxid || job.senderAccount && job.senderAccount !== senderAccount ||
        job.receiptAccount && job.receiptAccount !== receiptAccount)) {
      throw bad('VOICE_ACCOUNT_OR_TARGET_CHANGED', 409);
    }
    if (voiceTargets && !voiceTargets.includes(wxid)) {
      throw bad(voiceTransport === 'helper' ? 'VOICE_HELPER_TARGET_NOT_ALLOWED' : 'VOICE_HOOK_TARGET_NOT_ALLOWED', 403);
    }
    return { account, senderAccount, receiptAccount, voiceSenderWxid, wxid, voiceSend, voiceTransport: voiceTransport ?? 'native' };
  }

  async sendText({deliveryId, kind, target, text}) {
    return this.generateAndSend({deliveryId, kind, target, text});
  }

  // Whether this chat can receive a synthesized voice reply right now.
  async capability(kind, target) {
    let identity;
    try { identity = await this.identity(kind, target); } catch { return {voice: false}; }
    if (!identity.voiceSend || identity.voiceTransport === 'desktop' && identity.wxid !== 'filehelper') return {voice: false};
    return {voice: this.synthesis.candidates('wechat:' + kind + ':' + target, outputFeature).length === 1};
  }

  // A DSH reply chosen as voice. The bridge's 64-hex delivery ID names one
  // logical reply; retries query the same delivery. fallback is true only when
  // nothing was submitted, so the caller may send the same text once instead.
  async speakReply({kind, target, text, deliveryId}) {
    const id = 'dsh-' + deliveryId;
    if (!dialogueId.test(id) || typeof text !== 'string' || !text.trim() || text.length > 4096) throw bad('VOICE_INVALID_REQUEST', 400);
    if (this.active.has(id)) return {deliveryId: id, status: 'pending'};
    this.active.add(id);
    const submitted = () => {
      const job = this.load(id);
      return !!job && !!(job.submitted || job.localId || job.confirmed || job.synthesisState === 'ready' && !job.rejected);
    };
    try {
      const job = this.load(id);
      let result;
      if (job) {
        if (job.kind !== kind || job.target !== target || job.textSha256 !== sha256(text.trim())) throw bad('VOICE_DELIVERY_ID_CONFLICT', 409);
        result = await this.status(job, null);
      } else {
        try { result = await this.generateAndSend({deliveryId: id, kind, target, text: text.trim()}); }
        catch (error) {
          const code = typeof error.code === 'string' && error.code.startsWith('VOICE_') ? error.code : 'VOICE_BACKEND_UNAVAILABLE';
          return {deliveryId: id, status: 'rejected', error: code, fallback: !submitted()};
        }
        if (result.status === 'pending') this.followReceipt(id);
      }
      return {...result, fallback: result.status === 'rejected' && !submitted()};
    } finally {
      this.active.delete(id);
    }
  }

  followReceipt(deliveryId) {
    if (this.adapter.stopped || this.receiptPolls.size >= 8) return;
    const controller = new AbortController();
    this.adapter.controllers.add(controller);
    const task = this.pollReceipt(deliveryId, controller.signal).catch(() => {}).finally(() => {
      this.adapter.controllers.delete(controller);
      this.receiptPolls.delete(task);
    });
    this.receiptPolls.add(task);
  }

  async pollReceipt(deliveryId, signal) {
    const initial = this.load(deliveryId);
    while (initial && !signal.aborted && Date.now() < initial.deadline) {
      await sleep(800, undefined, {signal});
      if (signal.aborted || this.active.has(deliveryId)) continue;
      this.active.add(deliveryId);
      try {
        const job = this.load(deliveryId);
        if (!job || (await this.status(job, null)).status !== 'pending') return;
      } catch (error) {
        if (signal.aborted || [403, 409].includes(error.status)) return;
      } finally {
        this.active.delete(deliveryId);
      }
    }
  }

  async close() {
    await this.synthesis.close();
    await Promise.allSettled(this.receiptPolls);
  }

  // Text-to-voice through the chat's voice-output-v1 plugin, then the native send.
  async generateAndSend({deliveryId, kind, target, text}, permitted = () => true) {
    const identity = await this.identity(kind, target);
    if (!identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
    if (identity.voiceTransport === 'desktop' && identity.wxid !== 'filehelper') throw bad('VOICE_FILEHELPER_ONLY', 403);
    if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    const key = 'wechat:' + kind + ':' + target;
    const selected = this.synthesis.selected(key, outputFeature);
    const startedAt = Date.now();
    const job = {
      version: 1, deliveryId, kind, target, account: identity.account, wxid: identity.wxid,
      senderAccount: identity.senderAccount, receiptAccount: identity.receiptAccount,
      transport: identity.voiceTransport, operationId: crypto.randomUUID(),
      ...(text === undefined ? {} : {textSha256: sha256(text)}),
      synthesisState: 'synthesizing', durationMs: 0, startedAt, deadline: startedAt + 35000, baseline: [],
    };
    this.save(job, true);
    try {
      const {wav, allowed} = await this.synthesis.generate({account: identity.account, key, text, selected, feature: outputFeature});
      return await this.send({deliveryId, kind, target, wav}, job, () => allowed() && permitted());
    } catch (error) {
      if (job.synthesisState === 'synthesizing') {
        job.synthesisState = 'failed';
        job.synthesisError = /^VOICE_[A-Z_]{1,55}$/.test(error.code) ? error.code : 'VOICE_TTS_FAILED';
        this.save(job);
      }
      throw error;
    }
  }

  async send({ deliveryId, kind, target, wav }, prepared, authorized = () => true) {
    const adapter = this.adapter;
    const identity = await this.identity(kind, target, prepared);
    if (!identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
    if (prepared && prepared.transport !== identity.voiceTransport) throw bad('VOICE_BACKEND_CHANGED', 409);
    const desktop = identity.voiceTransport === 'desktop';
    const helper = identity.voiceTransport === 'helper';
    if (desktop && identity.wxid !== 'filehelper') throw bad('VOICE_FILEHELPER_ONLY', 403);
    const pcm = desktop ? voicePcm(wav) : null;
    if (pcm && pcm.length > 59 * 32000) throw bad('VOICE_DESKTOP_DURATION_LIMIT', 400);
    const encoded = desktop ? null : await encodeVoice(wav);
    const audio = desktop ? { pcmBase64: pcm.toString('base64'), durationMs: Math.ceil(pcm.length / 32) }
      : { silkBase64: encoded.silk.toString('base64'), durationMs: encoded.durationMs };
    const key = kind + ':' + target;
    if (adapter.targetsSending.has(key) || adapter.targetsSending.size >= (adapter.hook.maxConcurrentSends ?? 4)) {
      throw bad('VOICE_SENDER_BUSY', 429);
    }
    adapter.targetsSending.add(key);
    try {
      const rows = await adapter.messages(identity.wxid);
      const current = await this.identity(kind, target, identity);
      if (!current.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
      if (current.voiceTransport !== identity.voiceTransport) throw bad('VOICE_BACKEND_CHANGED', 409);
      if (!authorized()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
      const startedAt = Date.now();
      const job = {
        ...prepared,
        version: 1, deliveryId, kind, target, account: current.account, wxid: current.wxid,
        operationId: prepared?.operationId ?? crypto.randomUUID(), sha256: sha256(wav), durationMs: audio.durationMs, startedAt,
        transport: current.voiceTransport,
        senderAccount: current.senderAccount, receiptAccount: current.receiptAccount,
        deadline: startedAt + (desktop ? 75000 : (adapter.receiptOverride ?? adapter.hook.receiptTimeoutMs ?? 18000)),
        baseline: rows.map(row => row.localId).filter(localId).map(String),
      };
      if (prepared) job.synthesisState = 'ready';
      if (helper || job.receiptAccount) {
        const { start, end } = validateSilk(encoded.silk);
        job.silkSha256 = sha256(encoded.silk.subarray(start, end));
        job.baselineServerIds = rows.map(row => String(row.serverId)).filter(serverId);
      }
      this.save(job, !prepared);
      if (prepared) prepared.synthesisState = 'ready';
      if (job.silkSha256) this.reserveFingerprint(job);
      let result;
      try {
        result = await adapter.native('/SendVoiceMsg', {
          wxidorgid: job.wxid, operationId: job.operationId, ...audio,
          ...(current.voiceSenderWxid ? {accountWxid: current.voiceSenderWxid} : {}),
        }, job.senderAccount ?? job.account);
      } catch (error) {
        if (/^API_HTTP_(400|401|403|409|413|429)$/.test(error.message)) job.rejected = true;
      }
      if (job.receiptAccount) applyNativeMapping(job, result);
      else {
        if (Number.isInteger(result?.ret) && result.ret !== 0) job.rejected = true;
        if (helper) applyHelperMapping(job, result);
        else if (result?.ret === 0 && localId(result.localId)) job.localId = String(result.localId);
      }
      if (desktop) job.deadline = Date.now();
      if (job.rejected || job.localId || job.submitted || desktop) this.save(job);
      return this.response(job);
    } finally {
      adapter.targetsSending.delete(key);
    }
  }

  async status(job, upload) {
    const identity = await this.identity(job.kind, job.target, job);
    const sameInput = !upload || (upload.text === undefined
      ? !job.textSha256 && sha256(upload.wav) === job.sha256
      : sha256(upload.text) === job.textSha256);
    if (upload && (upload.kind !== job.kind || upload.target !== job.target || !sameInput)) {
      throw bad('VOICE_DELIVERY_ID_CONFLICT', 409);
    }
    if (job.rejected || job.confirmed || ['synthesizing', 'failed'].includes(job.synthesisState)) return this.response(job);
    const transport = job.transport ?? 'native';
    const needsMapping = !job.localId && (transport === 'native' || transport === 'helper');
    if (needsMapping && identity.voiceSend && identity.voiceTransport === transport) {
      // A lost submit response is recovered by reading the backend's operation mapping.
      const mapping = await this.adapter.native(nativeReceiptRoute + job.operationId, undefined, job.senderAccount ?? job.account).catch(() => null);
      if (mapping?.operationId === job.operationId) {
        if (transport === 'helper') {
          if (applyHelperMapping(job, mapping)) this.save(job);
        } else if (job.receiptAccount) {
          if (applyNativeMapping(job, mapping)) this.save(job);
        } else if (localId(mapping.localId)) {
          job.localId = String(mapping.localId);
          this.save(job);
        }
      }
    }
    if (!job.localId) {
      if (!job.rejected && job.submitted && job.silkSha256) await this.checkContentReceipt(job);
      return this.response(job);
    }
    if (job.baseline.includes(job.localId)) return this.response(job);
    const rows = await this.adapter.messages(job.wxid);
    const matching = rows.filter(row => (row.isSend === 1 || row.isSend === true) && row.localType === 34 &&
      String(row.localId) === job.localId && Number(row.createTime) >= Math.floor(job.startedAt / 1000));
    if (matching.length === 1 && serverId(matching[0].serverId) &&
        !job.baselineServerIds?.includes(String(matching[0].serverId))) {
      await this.identity(job.kind, job.target, job);
      this.confirm(job);
    }
    return this.response(job);
  }

  async checkContentReceipt(job) {
    if (!this.ownsUniqueFingerprint(job)) return;
    const after = Math.floor(job.startedAt / 1000);
    const before = Math.floor(Math.min(job.deadline, job.startedAt + fingerprintWindowMs) / 1000);
    const query = new URLSearchParams({
      talker: job.wxid, account: job.receiptAccount ?? job.senderAccount, digest: job.silkSha256,
      after: String(after), before: String(before), baseline: job.baseline.join(','),
    });
    const result = await this.adapter.reader('/api/v1/outgoing-voice-receipt?' + query).catch(() => null);
    const match = result?.match;
    if (!match || !localId(match.localId) || job.baseline.includes(String(match.localId)) ||
        !serverId(match.serverId) || job.baselineServerIds?.includes(String(match.serverId)) ||
        !Number.isSafeInteger(match.createTime) ||
        match.createTime < after || match.createTime > before) return;
    await this.identity(job.kind, job.target, job);
    if (!this.ownsUniqueFingerprint(job)) return;
    job.localId = String(match.localId);
    job.serverMessageId = String(match.serverId);
    this.confirm(job);
  }

  confirm(job) {
    job.confirmed = true;
    this.save(job);
    this.adapter.status.confirmed_sends++;
  }

  response(job) {
    const result = { deliveryId: job.deliveryId, durationMs: job.durationMs };
    if (job.synthesisState === 'failed') return {...result, status: 'rejected', error: job.synthesisError};
    if (job.rejected) return { ...result, status: 'rejected', error: 'VOICE_NATIVE_REJECTED' };
    if (job.confirmed) return {
      ...result, status: 'confirmed', messageId: job.localId, receipt: 'wechat-server-id',
      ...(job.serverMessageId ? { serverMessageId: job.serverMessageId, receiptSource: 'silk-sha256' } : {}),
    };
    return { ...result, ...(job.submitted ? { submitted: true } : {}), status: Date.now() < job.deadline ? 'pending' : 'unconfirmed' };
  }
}
