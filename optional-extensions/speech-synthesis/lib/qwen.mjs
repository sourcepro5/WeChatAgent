// Qwen / Alibaba Cloud Bailian HTTP adapters:
// - Qwen-Audio-TTS through the official SpeechSynthesizer endpoint, streamed
//   as SSE so the audio arrives in the response (no download from another host);
// - Qwen3-ASR-Flash through the OpenAI-compatible /chat/completions route with
//   the recording as a Base64 data URL.
import {normalizeWav, waveFile} from './wav.mjs';
import {responseBytes} from './service.mjs';
import {authHeaders} from './resolve.mjs';

const fault = (code, providerCode) => Object.assign(new Error(code), safe(providerCode) ? {providerCode: safe(providerCode)} : {});
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
const outputRate = 16000, maxSeconds = 60;
const SYNTHESIZER = '/services/audio/tts/SpeechSynthesizer';

function timed(settings, signal) {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function httpsUrl(value, code) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw fault(code); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fault(code);
  return url;
}

// https://<host>/api/v1 (or a full …/SpeechSynthesizer address).
export function synthesizerUrl(value) {
  const url = httpsUrl(value, 'VOICE_TTS_ENDPOINT'), path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(SYNTHESIZER) ? path : (path.endsWith('/api/v1') ? path : path + '/api/v1') + SYNTHESIZER;
  return url;
}

// https://<host>/compatible-mode/v1 (or a full …/chat/completions address).
export function chatUrl(value) {
  const url = httpsUrl(value, 'VOICE_TTS_ENDPOINT'), path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
  return url;
}

async function send(url, init, {signal, fetchImpl = fetch, settings, limit}) {
  const requestSignal = timed(settings, signal);
  let response, bytes;
  try {
    response = await fetchImpl(url, {...init, redirect: 'error', signal: requestSignal});
    bytes = await responseBytes(response, limit);
  } catch (error) {
    if (requestSignal.aborted) throw fault('VOICE_TTS_TIMEOUT');
    throw error.message === 'VOICE_TTS_TOO_LARGE' ? error : fault('VOICE_TTS_NETWORK');
  }
  return {response, bytes};
}
const statusCode = (status, fallback) => [401, 403].includes(status) ? 'VOICE_TTS_AUTH' : status === 404 ? 'VOICE_TTS_MODEL' : fallback;
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// Server-sent events: one JSON object per "data:" line.
export function sseEvents(text) {
  return String(text).split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => parse(line.slice(5).trim())).filter(Boolean);
}

export async function qwenSynthesize(service, input, {signal, fetchImpl} = {}) {
  const settings = service.flat, text = String(input ?? '').trim();
  if (!text || text.length > 2000) throw fault('VOICE_TTS_INVALID_TEXT');
  if (!service.key) throw fault('VOICE_PROVIDER_CREDENTIAL');
  const model = settings.model.trim(), voice = settings.voice.trim(), speed = settings.speed ?? 1;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model) || !/^[A-Za-z0-9._:-]{1,200}$/.test(voice) || !(speed >= 0.5 && speed <= 2)) throw fault('VOICE_TTS_CONFIG');
  const instruction = settings.instructions?.trim();
  const body = JSON.stringify({model, input: {text, voice, format: 'pcm', sample_rate: outputRate,
    ...(speed !== 1 ? {rate: speed} : {}), ...(instruction ? {instruction} : {})}});
  const {response, bytes} = await send(synthesizerUrl(settings.endpoint), {method: 'POST', body,
    headers: {...authHeaders(service), 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-DashScope-SSE': 'enable'}},
  {signal, fetchImpl, settings, limit: 8 * 1024 * 1024});
  const raw = bytes.toString('utf8');
  if (!response.ok) {
    const error = parse(raw) ?? sseEvents(raw)[0];
    throw fault(statusCode(response.status, 'VOICE_TTS_HTTP'), error?.code);
  }
  const chunks = [];
  let size = 0, finished = false;
  for (const event of sseEvents(raw)) {
    if (event.code && !event.output) throw fault('VOICE_TTS_HTTP', event.code);
    const data = event.output?.audio?.data;
    if (typeof data === 'string' && data) {
      const chunk = Buffer.from(data, 'base64');
      if ((size += chunk.length) > outputRate * 2 * maxSeconds) throw fault('VOICE_TTS_TOO_LONG');
      chunks.push(chunk);
    }
    if (event.output?.finish_reason === 'stop') finished = true;
  }
  // PCM output is 16-bit mono at the requested rate.
  if (!finished || !size || size % 2) throw fault('VOICE_TTS_STREAM_INCOMPLETE');
  return normalizeWav(waveFile(Buffer.concat(chunks, size), outputRate));
}

export async function qwenTranscribe(service, wav, {signal, fetchImpl} = {}) {
  const settings = service.flat, model = settings.model.trim(), language = String(settings.language ?? '').trim();
  if (!service.key) throw fault('VOICE_PROVIDER_CREDENTIAL');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model) || language && !/^[a-z]{2,3}$/.test(language)) throw fault('VOICE_TTS_CONFIG');
  const audio = waveFile(normalizeWav(wav).pcm);
  if (Math.ceil(audio.length / 3) * 4 > 10 * 1024 * 1024) throw fault('VOICE_TTS_TOO_LONG');
  const body = JSON.stringify({model, stream: false,
    messages: [{role: 'user', content: [{type: 'input_audio', input_audio: {data: 'data:audio/wav;base64,' + audio.toString('base64')}}]}],
    asr_options: {enable_itn: false, ...(language ? {language} : {})}});
  const {response, bytes} = await send(chatUrl(settings.endpoint), {method: 'POST', body,
    headers: {...authHeaders(service), 'Content-Type': 'application/json', Accept: 'application/json'}}, {signal, fetchImpl, settings, limit: 256 * 1024});
  const json = parse(bytes.toString('utf8'));
  if (!response.ok) throw fault(statusCode(response.status, 'VOICE_TTS_HTTP'), json?.error?.code ?? json?.code);
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
  if (!text.trim() || text.length > 4000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw fault('VOICE_TTS_TRANSCRIPT');
  return text.trim();
}
