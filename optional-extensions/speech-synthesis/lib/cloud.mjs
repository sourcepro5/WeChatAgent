// Speech adapters for providers with their own APIs: Tencent Cloud (TC3-HMAC-
// SHA256), ElevenLabs, Azure AI Speech and Google Cloud (service account). Each
// returns normalized 16 kHz mono PCM for synthesis and plain text for
// recognition; errors carry a service code and, when known, the provider's own
// sanitized error code (never its message).
import crypto from 'node:crypto';
import {normalizeWav, waveFile} from './wav.mjs';
import {responseBytes} from './service.mjs';

const fault = (code, providerCode) => Object.assign(new Error(code), safe(providerCode) ? {providerCode: safe(providerCode)} : {});
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const maxSeconds = 60, targetRate = 16000;
const jsonLimit = 4 * 1024 * 1024;

function timed(settings, signal) {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

// Network and HTTP failures map to the shared service codes.
async function call(url, init, {signal, fetchImpl = fetch, settings, limit = jsonLimit, auth = [401, 403]}) {
  const requestSignal = timed(settings, signal);
  let response;
  try { response = await fetchImpl(url, {...init, redirect: 'error', signal: requestSignal}); }
  catch (error) {
    if (requestSignal.aborted) throw fault('VOICE_TTS_TIMEOUT');
    throw fault('VOICE_TTS_NETWORK');
  }
  let bytes;
  try { bytes = await responseBytes(response, limit); }
  catch (error) {
    if (requestSignal.aborted) throw fault('VOICE_TTS_TIMEOUT');
    throw error.message === 'VOICE_TTS_TOO_LARGE' ? error : fault('VOICE_TTS_NETWORK');
  }
  return {response, bytes, failed: code => auth.includes(response.status) ? 'VOICE_TTS_AUTH' : response.status === 404 ? 'VOICE_TTS_MODEL' : code};
}
const parse = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; } };
const transcriptOf = text => {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length > 4000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw fault('VOICE_TTS_TRANSCRIPT');
  return value;
};
// Recognition input: 16 kHz mono 16-bit PCM, at most 60 seconds.
const inputPcm = wav => normalizeWav(wav, targetRate).pcm;
function joinPcm(parts) {
  const pcm = Buffer.concat(parts);
  if (pcm.length > targetRate * 2 * maxSeconds) throw fault('VOICE_TTS_TOO_LONG');
  if (!pcm.length) throw fault('VOICE_TTS_INVALID_AUDIO');
  return {pcm, durationMs: Math.ceil(pcm.length / 2 * 1000 / targetRate)};
}
const text = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw fault('VOICE_TTS_INVALID_TEXT');
  return value.trim();
};

// ---- Tencent Cloud API 3.0 ----

export const TENCENT = Object.freeze({
  tts: {host: 'tts.tencentcloudapi.com', service: 'tts', version: '2019-08-23', action: 'TextToVoice'},
  asr: {host: 'asr.tencentcloudapi.com', service: 'asr', version: '2019-06-14', action: 'SentenceRecognition'},
});
const TENCENT_REGION = /^[a-z]{2}-[a-z]+(?:-[0-9]+)?$/;

// Signature v3 as documented by Tencent Cloud: POST, URI "/", empty query,
// signed headers content-type;host;x-tc-action, UTC date of the timestamp.
export function tc3Authorization({secretId, secretKey, service, host, action, timestamp, payload}) {
  const contentType = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256(canonicalRequest)].join('\n');
  const signing = hmac(hmac(hmac('TC3' + secretKey, date), service), 'tc3_request');
  const signature = crypto.createHmac('sha256', signing).update(stringToSign).digest('hex');
  return {contentType, canonicalRequest, stringToSign,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`};
}

// The secret setting holds "SecretId:SecretKey".
export function tencentCredential(key) {
  const index = String(key ?? '').indexOf(':');
  const secretId = index > 0 ? key.slice(0, index).trim() : '', secretKey = index > 0 ? key.slice(index + 1).trim() : '';
  if (!/^[A-Za-z0-9]{8,128}$/.test(secretId) || !/^[A-Za-z0-9+/=_-]{8,256}$/.test(secretKey)) throw fault('VOICE_TENCENT_KEY');
  return {secretId, secretKey};
}

async function tencent(api, body, service, settings, {signal, fetchImpl, now = Date.now} = {}) {
  const {secretId, secretKey} = tencentCredential(service.key);
  const region = String(service.profile.region ?? '').trim();
  if (region && !TENCENT_REGION.test(region)) throw fault('VOICE_PROVIDER_REGION');
  const payload = JSON.stringify(body), timestamp = Math.floor(now() / 1000);
  const {authorization, contentType} = tc3Authorization({secretId, secretKey, service: api.service, host: api.host, action: api.action, timestamp, payload});
  const headers = {Authorization: authorization, 'Content-Type': contentType, 'X-TC-Action': api.action,
    'X-TC-Timestamp': String(timestamp), 'X-TC-Version': api.version,
    // SentenceRecognition takes no region; TextToVoice accepts an optional one.
    ...(region && api === TENCENT.tts ? {'X-TC-Region': region} : {})};
  const {response, bytes, failed} = await call('https://' + api.host + '/', {method: 'POST', headers, body: payload}, {signal, fetchImpl, settings});
  const json = parse(bytes);
  const error = json?.Response?.Error;
  if (error) throw fault(/^AuthFailure/.test(error.Code ?? '') ? 'VOICE_TTS_AUTH' : 'VOICE_TTS_HTTP', error.Code);
  if (!response.ok || !json?.Response) throw fault(failed('VOICE_TTS_HTTP'));
  return json.Response;
}

// TextToVoice takes at most 150 Chinese characters; longer replies are split
// at sentence punctuation and the WAV parts joined.
export function splitText(value, limit = 150) {
  const parts = [];
  let rest = value.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const marks of [/[。！？!?\n]/g, /[；;]/g, /[，,、：:]/g, /\s/g]) {
      for (const match of window.matchAll(marks)) cut = match.index + 1;
      if (cut > limit / 3) break;
      cut = -1;
    }
    if (cut < 1) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// Tencent's Speed is a scale: -2 0.6x, -1 0.8x, 0 1.0x, 1 1.2x, 2 1.5x, 6 2.5x.
const SPEED_POINTS = [[0.6, -2], [0.8, -1], [1, 0], [1.2, 1], [1.5, 2], [2.5, 6]];
export function tencentSpeed(multiplier) {
  const value = Math.min(2.5, Math.max(0.6, multiplier));
  for (let i = 1; i < SPEED_POINTS.length; i++) {
    const [x1, y1] = SPEED_POINTS[i - 1], [x2, y2] = SPEED_POINTS[i];
    if (value <= x2) return Math.round((y1 + (value - x1) * (y2 - y1) / (x2 - x1)) * 100) / 100;
  }
  return 6;
}

async function tencentSynthesize(service, settings, input, options) {
  const voice = String(settings.voice ?? '').trim();
  if (!/^\d{1,12}$/.test(voice)) throw fault('VOICE_TTS_CONFIG');
  const speed = settings.speed ?? 1, parts = [];
  for (const segment of splitText(text(input))) {
    const result = await tencent(TENCENT.tts, {
      Text: segment, SessionId: crypto.randomUUID(), VoiceType: Number(voice), Codec: 'wav', SampleRate: targetRate,
      ...(speed !== 1 ? {Speed: tencentSpeed(speed)} : {}),
    }, service, settings, options);
    if (typeof result.Audio !== 'string' || !result.Audio) throw fault('VOICE_TTS_INVALID_AUDIO');
    parts.push(normalizeWav(Buffer.from(result.Audio, 'base64')).pcm);
  }
  return joinPcm(parts);
}

async function tencentTranscribe(service, settings, wav, options) {
  const engine = String(settings.recognitionModel ?? '').trim();
  if (!/^(?:8k|16k)_[A-Za-z_-]{2,24}$/.test(engine)) throw fault('VOICE_TTS_CONFIG');
  const data = waveFile(inputPcm(wav));
  if (Math.ceil(data.length / 3) * 4 > 3 * 1024 * 1024) throw fault('VOICE_TTS_TOO_LONG');
  const result = await tencent(TENCENT.asr, {EngSerViceType: engine, SourceType: 1, VoiceFormat: 'wav', Data: data.toString('base64'), DataLen: data.length},
    service, settings, options);
  return transcriptOf(result.Result);
}

// ---- ElevenLabs ----

const ELEVEN = 'https://api.elevenlabs.io';
const elevenId = value => /^[A-Za-z0-9_-]{1,64}$/.test(value ?? '') ? value : null;
const elevenError = (json, failed) => fault(failed('VOICE_TTS_HTTP'), json?.detail?.status ?? json?.detail?.code);

async function elevenSynthesize(service, settings, input, options) {
  const voice = elevenId(String(settings.voice ?? '').trim()), model = String(settings.model ?? '').trim() || 'eleven_multilingual_v2';
  if (!voice || !elevenId(model)) throw fault('VOICE_TTS_CONFIG');
  const speed = settings.speed ?? 1;
  const {response, bytes, failed} = await call(`${ELEVEN}/v1/text-to-speech/${voice}?output_format=wav_16000`, {
    method: 'POST', headers: {'xi-api-key': service.key, 'Content-Type': 'application/json', Accept: 'audio/wav'},
    body: JSON.stringify({text: text(input), model_id: model, ...(speed !== 1 ? {voice_settings: {speed: Math.min(1.2, Math.max(0.7, speed))}} : {})}),
  }, {...options, settings, limit: 12 * 1024 * 1024});
  if (!response.ok) throw elevenError(parse(bytes), failed);
  return normalizeWav(bytes);
}

async function elevenTranscribe(service, settings, wav, options) {
  const model = String(settings.recognitionModel ?? '').trim();
  if (!elevenId(model)) throw fault('VOICE_TTS_CONFIG');
  const body = new FormData();
  body.append('model_id', model);
  body.append('tag_audio_events', 'false');
  body.append('file', new Blob([waveFile(inputPcm(wav))], {type: 'audio/wav'}), 'voice.wav');
  const {response, bytes, failed} = await call(`${ELEVEN}/v1/speech-to-text`, {method: 'POST', headers: {'xi-api-key': service.key}, body},
    {...options, settings});
  const json = parse(bytes);
  if (!response.ok) throw elevenError(json, failed);
  return transcriptOf(json?.text);
}

async function elevenLists(service, settings, options) {
  const headers = {'xi-api-key': service.key, Accept: 'application/json'};
  const voiceList = await call(`${ELEVEN}/v1/voices`, {method: 'GET', headers}, {...options, settings});
  if (!voiceList.response.ok) throw elevenError(parse(voiceList.bytes), voiceList.failed);
  const modelList = await call(`${ELEVEN}/v1/models`, {method: 'GET', headers}, {...options, settings});
  if (!modelList.response.ok) throw elevenError(parse(modelList.bytes), modelList.failed);
  const voices = parse(voiceList.bytes)?.voices, models = parse(modelList.bytes);
  return {
    voices: (Array.isArray(voices) ? voices : []).filter(row => elevenId(row?.voice_id)).map(row => ({id: row.voice_id, label: String(row.name ?? row.voice_id).slice(0, 80)})),
    models: (Array.isArray(models) ? models : []).filter(row => row?.can_do_text_to_speech !== false && elevenId(row?.model_id)).map(row => row.model_id),
  };
}

// ---- Azure AI Speech (regional REST endpoints) ----

const AZURE_REGION = /^[a-z0-9]{2,40}$/;
function azureRegion(service) {
  const region = String(service.profile.region ?? '').trim();
  if (!AZURE_REGION.test(region)) throw fault('VOICE_PROVIDER_REGION');
  return region;
}
const escapeXml = value => value.replace(/[<>&'"]/g, char => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[char]);

async function azureSynthesize(service, settings, input, options) {
  const voice = String(settings.voice ?? '').trim();
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z0-9]+){1,3}$/.test(voice)) throw fault('VOICE_TTS_CONFIG');
  const lang = voice.split('-').slice(0, 2).join('-'), speed = settings.speed ?? 1;
  const body = `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>` +
    (speed !== 1 ? `<prosody rate='${speed > 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%'>${escapeXml(text(input))}</prosody>` : escapeXml(text(input))) +
    '</voice></speak>';
  const {response, bytes, failed} = await call(`https://${azureRegion(service)}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST', body,
    headers: {'Ocp-Apim-Subscription-Key': service.key, 'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'WeChatAgent'},
  }, {...options, settings, limit: 12 * 1024 * 1024});
  if (!response.ok) throw fault(failed('VOICE_TTS_HTTP'));
  return normalizeWav(bytes);
}

async function azureTranscribe(service, settings, wav, options) {
  const language = String(settings.recognitionModel ?? '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){1,2}$/.test(language)) throw fault('VOICE_TTS_CONFIG');
  const url = new URL(`https://${azureRegion(service)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`);
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'simple');
  const {response, bytes, failed} = await call(url, {
    method: 'POST', body: waveFile(inputPcm(wav)),
    headers: {'Ocp-Apim-Subscription-Key': service.key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', Accept: 'application/json'},
  }, {...options, settings});
  const json = parse(bytes);
  if (!response.ok) throw fault(failed('VOICE_TTS_HTTP'));
  if (json?.RecognitionStatus !== 'Success') throw fault('VOICE_TTS_TRANSCRIPT', json?.RecognitionStatus);
  return transcriptOf(json.DisplayText);
}

async function azureLists(service, settings, options) {
  const {response, bytes, failed} = await call(`https://${azureRegion(service)}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    {method: 'GET', headers: {'Ocp-Apim-Subscription-Key': service.key, Accept: 'application/json'}}, {...options, settings});
  if (!response.ok) throw fault(failed('VOICE_TTS_HTTP'));
  const list = parse(bytes);
  return {voices: (Array.isArray(list) ? list : []).filter(row => typeof row?.ShortName === 'string' && /^[A-Za-z0-9-]{3,100}$/.test(row.ShortName))
    .map(row => ({id: row.ShortName, label: `${String(row.LocalName ?? row.ShortName).slice(0, 40)}（${row.Locale ?? ''}）`})).slice(0, 600)};
}

// ---- Google Cloud (service account → OAuth access token) ----

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const tokens = new Map();
const base64url = value => Buffer.from(value).toString('base64url');

export function googleAccount(key) {
  let account;
  try { account = JSON.parse(String(key ?? '')); } catch { throw fault('VOICE_GOOGLE_KEY'); }
  if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || !/^[^@\s]{1,200}@[^@\s]{1,200}$/.test(account.client_email) ||
      typeof account.private_key !== 'string' || !account.private_key.includes('PRIVATE KEY') ||
      account.token_uri !== undefined && account.token_uri !== GOOGLE_TOKEN) throw fault('VOICE_GOOGLE_KEY');
  return account;
}

async function googleToken(service, settings, {signal, fetchImpl, now = Date.now} = {}) {
  const account = googleAccount(service.key);
  const cacheKey = sha256(account.client_email + '\0' + account.private_key), cached = tokens.get(cacheKey);
  if (cached && cached.expires > now() + 60000) return cached.token;
  const iat = Math.floor(now() / 1000);
  const unsigned = base64url(JSON.stringify({alg: 'RS256', typ: 'JWT'})) + '.' +
    base64url(JSON.stringify({iss: account.client_email, scope: GOOGLE_SCOPE, aud: GOOGLE_TOKEN, iat, exp: iat + 3600}));
  let signature;
  try { signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url'); }
  catch { throw fault('VOICE_GOOGLE_KEY'); }
  const body = new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature});
  const {response, bytes, failed} = await call(GOOGLE_TOKEN, {method: 'POST', body, headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'}},
    {signal, fetchImpl, settings, auth: [400, 401, 403]});
  const json = parse(bytes);
  if (!response.ok || typeof json?.access_token !== 'string' || !json.access_token) throw fault(failed('VOICE_TTS_HTTP'), json?.error);
  tokens.set(cacheKey, {token: json.access_token, expires: now() + Math.min(3600, Number(json.expires_in) || 3600) * 1000});
  return json.access_token;
}
const googleError = (json, failed) => fault(failed('VOICE_TTS_HTTP'), json?.error?.status);

async function googleSynthesize(service, settings, input, options) {
  const voice = String(settings.voice ?? '').trim();
  if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(voice)) throw fault('VOICE_TTS_CONFIG');
  const token = await googleToken(service, settings, options), speed = settings.speed ?? 1;
  const {response, bytes, failed} = await call('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({input: {text: text(input)}, voice: {languageCode: voice.split('-').slice(0, 2).join('-'), name: voice},
      audioConfig: {audioEncoding: 'LINEAR16', sampleRateHertz: targetRate, ...(speed !== 1 ? {speakingRate: Math.min(2, Math.max(0.25, speed))} : {})}}),
  }, {...options, settings, limit: 16 * 1024 * 1024});
  const json = parse(bytes);
  if (!response.ok) throw googleError(json, failed);
  if (typeof json?.audioContent !== 'string' || !json.audioContent) throw fault('VOICE_TTS_INVALID_AUDIO');
  // LINEAR16 audio content includes a WAV header.
  return normalizeWav(Buffer.from(json.audioContent, 'base64'));
}

async function googleTranscribe(service, settings, wav, options) {
  const language = String(settings.recognitionModel ?? '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){1,2}$/.test(language)) throw fault('VOICE_TTS_CONFIG');
  const token = await googleToken(service, settings, options);
  const {response, bytes, failed} = await call('https://speech.googleapis.com/v1/speech:recognize', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({config: {encoding: 'LINEAR16', sampleRateHertz: targetRate, languageCode: language}, audio: {content: inputPcm(wav).toString('base64')}}),
  }, {...options, settings});
  const json = parse(bytes);
  if (!response.ok) throw googleError(json, failed);
  return transcriptOf((json?.results ?? []).map(row => row?.alternatives?.[0]?.transcript ?? '').join(''));
}

async function googleLists(service, settings, options) {
  const token = await googleToken(service, settings, options);
  const {response, bytes, failed} = await call('https://texttospeech.googleapis.com/v1/voices?languageCode=cmn-CN',
    {method: 'GET', headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'}}, {...options, settings});
  const json = parse(bytes);
  if (!response.ok) throw googleError(json, failed);
  return {voices: (json?.voices ?? []).filter(row => typeof row?.name === 'string' && /^[A-Za-z0-9-]{3,100}$/.test(row.name))
    .map(row => ({id: row.name, label: `${row.name}（${String(row.ssmlGender ?? '').toLowerCase() === 'female' ? '女' : String(row.ssmlGender ?? '').toLowerCase() === 'male' ? '男' : ''}）`}))};
}

const ADAPTERS = {
  tencent: {synthesize: tencentSynthesize, transcribe: tencentTranscribe},
  elevenlabs: {synthesize: elevenSynthesize, transcribe: elevenTranscribe, lists: elevenLists},
  azure: {synthesize: azureSynthesize, transcribe: azureTranscribe, lists: azureLists},
  google: {synthesize: googleSynthesize, transcribe: googleTranscribe, lists: googleLists},
};
const adapter = (service, name) => {
  // Adapters are per provider; the method kind only chooses TTS or recognition.
  const run = ADAPTERS[service.entry]?.[name];
  if (!run) throw fault('VOICE_PROVIDER_UNSUPPORTED');
  if (!service.key) throw fault('VOICE_PROVIDER_CREDENTIAL');
  return run;
};
export const cloudSynthesize = (service, settings, input, options = {}) => adapter(service, 'synthesize')(service, settings, input, options);
export const cloudTranscribe = (service, settings, wav, options = {}) => adapter(service, 'transcribe')(service, settings, wav, options);
export const cloudLists = (service, settings, options = {}) => adapter(service, 'lists')(service, settings, options);
export const cloudListable = entry => !!ADAPTERS[entry]?.lists;
// Tests clear the token cache between fixtures.
export const resetCloudTokens = () => tokens.clear();
