// Streaming recognition of one recorded WeChat voice: the audio is submitted
// in segments over the provider's realtime WebSocket protocol, interim text is
// reported through onPartial, and only the final transcript is returned (the
// host passes it to DSH once). Protocols:
// - openai-transcription: OpenAI Realtime transcription session (GA shape);
// - qwen-asr-realtime: Qwen-ASR-Realtime (qwen3-asr-flash-realtime);
// - tencent-asr-ws: Tencent Cloud realtime ASR v2 with an HMAC-SHA1 signed URL.
import crypto from 'node:crypto';
import {normalizeWav} from './wav.mjs';
import {tencentCredential} from './cloud.mjs';

const fault = (code, providerCode) => Object.assign(new Error(code), safe(providerCode) ? {providerCode: safe(providerCode)} : {});
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
const COMPLETED = 'conversation.item.input_audio_transcription.completed';
// The host waits 33 seconds for a transcription.
const BUDGET_MS = 31000;
// Tencent accepts at most 3 seconds of audio per second; 200 ms every 80 ms.
export const TENCENT_FRAME_MS = 200, TENCENT_INTERVAL_MS = 80;

function finalText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 4000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw fault('VOICE_REALTIME_TRANSCRIPT');
  return text;
}

// wss address ending in /realtime from a base or full address.
export function realtimeUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw fault('VOICE_REALTIME_ENDPOINT'); }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) throw fault('VOICE_REALTIME_ENDPOINT');
  url.protocol = {'https:': 'wss:', 'http:': 'ws:'}[url.protocol] ?? url.protocol;
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/realtime') ? path : (path || '/v1') + '/realtime';
  return url;
}

const chunks = (pcm, bytes) => Array.from({length: Math.ceil(pcm.length / bytes)}, (_, index) => pcm.subarray(index * bytes, (index + 1) * bytes));

// One WebSocket exchange. flow.start(send) runs on open; flow.receive(event,
// send, done) handles each JSON message and calls done(text) when complete.
function exchange({url, headers, signal, timeoutMs, WebSocketImpl = WebSocket, flow}) {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let socket, settled = false, opened = false, received = 0;
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', aborted);
      try { socket?.close(); } catch {}
      error ? reject(error) : resolve(text);
    };
    const aborted = () => finish(fault(timeout.aborted ? 'VOICE_REALTIME_TIMEOUT' : 'VOICE_REALTIME_CANCELLED'));
    if (stop.aborted) return aborted();
    stop.addEventListener('abort', aborted, {once: true});
    const send = value => { if (!settled) socket.send(Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
    try { socket = new WebSocketImpl(url, {headers}); } catch { return finish(fault('VOICE_REALTIME_NETWORK')); }
    socket.addEventListener('open', () => {
      opened = true;
      try { flow.start?.(send, stop); } catch (error) { finish(error); }
    });
    socket.addEventListener('message', ({data}) => {
      if (settled) return;
      try {
        if (typeof data !== 'string' || data.length > 256 * 1024 || (received += data.length) > 4 * 1024 * 1024) throw fault('VOICE_REALTIME_PROVIDER');
        let event;
        try { event = JSON.parse(data); } catch { throw fault('VOICE_REALTIME_PROVIDER'); }
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw fault('VOICE_REALTIME_PROVIDER');
        flow.receive(event, send, text => finish(null, text), stop);
      } catch (error) { finish(/^VOICE_[A-Z_]+$/.test(error.message) ? error : fault('VOICE_REALTIME_PROVIDER')); }
    });
    socket.addEventListener('error', () => finish(fault('VOICE_REALTIME_NETWORK')));
    socket.addEventListener('close', () => finish(fault(opened ? 'VOICE_REALTIME_INCOMPLETE' : 'VOICE_REALTIME_NETWORK')));
  });
}

const errorOf = event => fault('VOICE_REALTIME_PROVIDER', event.error?.code ?? event.code);
const bearer = service => service.key ? {Authorization: 'Bearer ' + service.key} : {};
const budget = (settings, extraMs = 0) => Math.min(BUDGET_MS, settings.timeoutMs + extraMs);

// OpenAI Realtime transcription session: 24 kHz PCM, no turn detection, one commit.
export function openaiTranscribe(service, wav, {signal, WebSocketImpl, onPartial} = {}) {
  const settings = service.flat, model = settings.model.trim(), language = String(settings.language ?? '').trim();
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(model) || language && !/^[a-z]{2,3}$/.test(language)) throw fault('VOICE_REALTIME_CONFIG');
  const url = realtimeUrl(settings.endpoint);
  url.searchParams.delete('model');
  url.searchParams.set('intent', 'transcription');
  const {pcm} = normalizeWav(wav, 24000);
  let sent = false, partial = '';
  return exchange({url, headers: bearer(service), signal, timeoutMs: budget(settings), WebSocketImpl, flow: {
    start(send) {
      send({type: 'session.update', session: {type: 'transcription', audio: {input: {format: {type: 'audio/pcm', rate: 24000},
        transcription: {model, ...(language ? {language} : {})}, turn_detection: null}}}});
    },
    receive(event, send, done) {
      if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') throw errorOf(event);
      if (event.type === 'session.updated' && !sent) {
        sent = true;
        for (const chunk of chunks(pcm, 24000)) send({type: 'input_audio_buffer.append', audio: chunk.toString('base64')});
        send({type: 'input_audio_buffer.commit'});
      } else if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string') {
        partial = (partial + event.delta).slice(0, 4000);
        onPartial?.(partial);
      } else if (sent && event.type === COMPLETED) done(finalText(event.transcript));
    },
  }});
}

// Qwen-ASR-Realtime: 16 kHz PCM, manual commit, then session.finish; interim
// text is the confirmed prefix plus the still-changing stash.
export function qwenAsrTranscribe(service, wav, {signal, WebSocketImpl, onPartial} = {}) {
  const settings = service.flat, model = settings.model.trim(), language = String(settings.language ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model) || language && !/^[a-z]{2,3}$/.test(language)) throw fault('VOICE_REALTIME_CONFIG');
  const url = realtimeUrl(settings.endpoint);
  url.searchParams.set('model', model);
  const {pcm} = normalizeWav(wav, 16000);
  let sent = false;
  const finals = [];
  return exchange({url, headers: bearer(service), signal, timeoutMs: budget(settings), WebSocketImpl, flow: {
    start(send) {
      send({type: 'session.update', session: {modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
        input_audio_transcription: language ? {language} : {}, turn_detection: null}});
    },
    receive(event, send, done) {
      if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') throw errorOf(event);
      if (event.type === 'session.updated' && !sent) {
        sent = true;
        for (const chunk of chunks(pcm, 16000)) send({type: 'input_audio_buffer.append', audio: chunk.toString('base64')});
        send({type: 'input_audio_buffer.commit'});
        send({type: 'session.finish'});
      } else if (event.type === 'conversation.item.input_audio_transcription.text') {
        onPartial?.((finals.join('') + String(event.text ?? '') + String(event.stash ?? '')).slice(0, 4000));
      } else if (event.type === COMPLETED && typeof event.transcript === 'string') {
        finals.push(event.transcript);
        onPartial?.(finals.join('').slice(0, 4000));
      } else if (event.type === 'session.finished') done(finalText(finals.join('')));
    },
  }});
}

// Tencent realtime ASR v2. The signature is HMAC-SHA1 over the URL without
// the scheme, parameters sorted by name, then Base64 and URL-encoded.
export function tencentAsrUrl({appId, secretId, secretKey, engine, voiceId, timestamp, nonce}) {
  const params = {engine_model_type: engine, expired: timestamp + 86400, nonce, secretid: secretId, timestamp, voice_format: 1, voice_id: voiceId};
  const query = Object.keys(params).sort().map(key => key + '=' + params[key]).join('&');
  const source = `asr.cloud.tencent.com/asr/v2/${appId}?${query}`;
  const signature = crypto.createHmac('sha1', secretKey).update(source).digest('base64');
  return {url: `wss://${source}&signature=${encodeURIComponent(signature)}`, source, signature};
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', cancel, {once: true});
});

export function tencentTranscribe(service, wav, {signal, WebSocketImpl, onPartial, now = Date.now, intervalMs = TENCENT_INTERVAL_MS} = {}) {
  const settings = service.flat, engine = settings.model.trim(), appId = String(service.profile.appId ?? '').trim();
  if (!/^\d{5,20}$/.test(appId)) throw fault('VOICE_TENCENT_APPID');
  if (!/^(?:8k|16k)_[A-Za-z_-]{2,24}$/.test(engine)) throw fault('VOICE_REALTIME_CONFIG');
  const {secretId, secretKey} = tencentCredential(service.key);
  const {pcm} = normalizeWav(wav, 16000);
  const frames = chunks(pcm, 16000 * 2 * TENCENT_FRAME_MS / 1000);
  const sendMs = frames.length * intervalMs;
  if (sendMs + 3000 > BUDGET_MS) throw fault('VOICE_REALTIME_ASR_TOO_LONG');
  const {url} = tencentAsrUrl({appId, secretId, secretKey, engine, voiceId: crypto.randomUUID(), timestamp: Math.floor(now() / 1000),
    nonce: crypto.randomInt(1, 2 ** 31 - 1)});
  const stable = new Map(), current = new Map();
  let started = false;
  const text = () => [...new Set([...stable.keys(), ...current.keys()])].sort((a, b) => a - b).map(index => stable.get(index) ?? current.get(index)).join('');
  return exchange({url, headers: {}, signal, timeoutMs: budget(settings, sendMs), WebSocketImpl, flow: {
    receive(event, send, done, stop) {
      if (event.code !== 0) {
        const code = String(event.code ?? '');
        throw fault(code === '4002' ? 'VOICE_TTS_AUTH' : 'VOICE_REALTIME_PROVIDER', code);
      }
      if (!started) {
        // The first message acknowledges the signed handshake.
        started = true;
        (async () => {
          for (const frame of frames) { send(frame); await sleep(intervalMs, stop); }
          send({type: 'end'});
        })().catch(() => {});
        return;
      }
      const result = event.result;
      if (result && Number.isSafeInteger(result.index) && typeof result.voice_text_str === 'string') {
        if (result.slice_type === 2) { stable.set(result.index, result.voice_text_str); current.delete(result.index); }
        else current.set(result.index, result.voice_text_str);
        onPartial?.(text().slice(0, 4000));
      }
      if (event.final === 1) done(finalText([...stable.keys()].sort((a, b) => a - b).map(index => stable.get(index)).join('')));
    },
  }});
}
