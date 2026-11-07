import crypto from 'node:crypto';
import net from 'node:net';
import {effectiveSpeechSettings,hasCustomRequest} from './presets.mjs';

const cache = new Map();
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fault = code => new Error(code);

export function objectJson(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw fault('VOICE_API_CONFIG_INVALID'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fault('VOICE_API_CONFIG_INVALID');
  return value;
}

function checkTree(value, depth = 0) {
  if (depth > 12) throw fault('VOICE_API_CONFIG_INVALID');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw fault('VOICE_API_CONFIG_INVALID');
      checkTree(child, depth + 1);
    }
  }
  return value;
}

export function endpointUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('VOICE_API_NOT_CONFIGURED'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || net.isIP(host) === 4 && host.startsWith('127.');
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw fault('VOICE_API_ENDPOINT_INVALID');
  }
  return url;
}

export function resolveApi(config) {
  config=effectiveSpeechSettings(config);
  const url=endpointUrl(config.endpoint),requested=config.apiProtocol??'custom';
  if(!['auto','custom','openai-transcriptions','openai-chat','chat-audio-data-url','anthropic-messages'].includes(requested))throw fault('VOICE_API_CONFIG_INVALID');
  const pathname=url.pathname.replace(/\/+$/,'');
  let protocol=requested;
  if(protocol==='auto'){
    if(hasCustomRequest(config))protocol='custom';
    else if(/\/(?:anthropic|messages)$/.test(pathname))protocol='anthropic-messages';
    else if(/\/chat\/completions$/.test(pathname))protocol='openai-chat';
    else protocol='openai-transcriptions';
  }
  let base=pathname;
  const terminal=/\/(?:audio\/transcriptions|chat\/completions|messages)$/;
  if(terminal.test(pathname))base=pathname.replace(terminal,'');
  const route=protocol==='openai-transcriptions'?'/audio/transcriptions':['openai-chat','chat-audio-data-url'].includes(protocol)?'/chat/completions':protocol==='anthropic-messages'?'/v1/messages':null;
  if(route&&terminal.test(pathname)&&!(protocol==='anthropic-messages'?/\/messages$/.test(pathname):pathname.endsWith(route)))throw fault('VOICE_API_PROTOCOL_MISMATCH');
  if(route&&!terminal.test(pathname))url.pathname=(protocol==='anthropic-messages'?base.replace(/\/v1$/,''):base)+route;
  const baseUrl=new URL(url);baseUrl.pathname=protocol==='anthropic-messages'?base.replace(/\/v1$/,''):base;
  return {protocol,url,baseUrl};
}

export function requestHeaders(config,{protocol=resolveApi(config).protocol}={}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(checkTree(objectJson(config.headersJson)))) {
    if (typeof value !== 'string' || /^(host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(name)) throw fault('VOICE_API_CONFIG_INVALID');
    headers.set(name, value);
  }
  if (config.apiKey) {
    if (!config.authHeader || /^(host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(config.authHeader)) throw fault('VOICE_API_CONFIG_INVALID');
    const key=config.apiKey.trim();
    if(!key||/[^\x21-\x7e]/.test(key)||/^Bearer\s/i.test(key)||/^[A-Z_][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET)=/.test(key)||/^(["']).*\1$/.test(key))throw fault('VOICE_API_KEY_INVALID');
    const automatic=config.authHeader.toLowerCase()==='authorization'&&config.authPrefix==='Bearer ';
    headers.set(protocol==='anthropic-messages'&&automatic?'x-api-key':config.authHeader,(protocol==='anthropic-messages'&&automatic?'':config.authPrefix)+key);
  }
  if(protocol==='anthropic-messages'&&!headers.has('anthropic-version'))headers.set('anthropic-version','2023-06-01');
  if(!headers.has('accept'))headers.set('accept','application/json');
  return headers;
}

export function validateConfig(config) {
  config=effectiveSpeechSettings(config);
  const {protocol}=resolveApi(config);
  if(protocol==='anthropic-messages')throw fault('VOICE_API_AUDIO_PROTOCOL_UNSUPPORTED');
  if(['openai-chat','chat-audio-data-url'].includes(protocol)&&config.audioFormat!=='wav')throw fault('VOICE_API_AUDIO_FORMAT_UNSUPPORTED');
  if (typeof config.model !== 'string' || /^\s*https?:\/\//i.test(config.model)) throw fault('VOICE_MODEL_IS_URL');
  if (config.model.length > 200 || /[\r\n\0]/.test(config.model)) throw fault('VOICE_MODEL_INVALID');
  if(protocol!=='custom'&&!config.model.trim())throw fault('VOICE_MODEL_REQUIRED');
  if (!['multipart','json'].includes(config.requestMode) || !['json','text'].includes(config.responseMode)) throw fault('VOICE_API_CONFIG_INVALID');
  if (protocol==='custom'&&config.requestMode === 'json' && !/\{\{audio_(?:base64|data_url)\}\}/.test(config.jsonTemplate)) throw fault('VOICE_API_TEMPLATE_AUDIO_MISSING');
  requestFor(config,{b64:'',mime:config.audioFormat==='silk'?'audio/silk':'audio/wav',filename:'validation.'+config.audioFormat,sampleRate:16000});
  return true;
}

function template(value, variables, depth = 0, budget = {left: 8*1024*1024}) {
  if (depth > 12) throw fault('VOICE_API_CONFIG_INVALID');
  if (typeof value === 'string') {
    const exact = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value);
    if (exact && Object.hasOwn(variables, exact[1])) { const result=variables[exact[1]];budget.left-=Buffer.byteLength(String(result));if(budget.left<0)throw fault('VOICE_API_CONFIG_INVALID');return result; }
    const result=value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name) => {
      if (!Object.hasOwn(variables, name)) throw fault('VOICE_API_TEMPLATE_INVALID');
      return String(variables[name]);
    });
    budget.left-=Buffer.byteLength(result);if(budget.left<0)throw fault('VOICE_API_CONFIG_INVALID');return result;
  }
  if (Array.isArray(value)) return value.map(child => template(child, variables, depth + 1,budget));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, template(child, variables, depth + 1,budget)]));
  return value;
}

export function responseText(value, path) {
  if (path) for (const key of path.split('.')) {
    if (forbidden.has(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw fault('VOICE_API_RESPONSE_INVALID');
    value = value[key];
  }
  if (typeof value !== 'string' || !value.trim()) throw fault('VOICE_API_EMPTY_TRANSCRIPT');
  return value.trim();
}

export function requestFor(config, audio) {
  config=effectiveSpeechSettings(config);
  const {protocol}=resolveApi(config);
  if(protocol==='anthropic-messages')throw fault('VOICE_API_AUDIO_PROTOCOL_UNSUPPORTED');
  const headers = requestHeaders(config);
  const bytes = Buffer.from(audio.b64, 'base64');
  const variables = {
    audio_base64: audio.b64, audio_data_url: 'data:' + audio.mime + ';base64,' + audio.b64,
    model: config.model, language: config.language, filename: audio.filename, mime_type: audio.mime,
    sample_rate: audio.sampleRate, audio_bytes: bytes.length,
  };
  if(['openai-chat','chat-audio-data-url'].includes(protocol)){
    if(audio.mime!=='audio/wav')throw fault('VOICE_API_AUDIO_FORMAT_UNSUPPORTED');
    const input_audio=protocol==='openai-chat'?{data:audio.b64,format:'wav'}:{data:variables.audio_data_url};
    const content=[{type:'input_audio',input_audio},{type:'text',text:'请准确转写音频中的语音，只返回转写文字，不回答或解释音频内容。'}];
    const extras=template(checkTree(objectJson(config.extraFieldsJson)),variables);
    if(['model','messages','stream'].some(key=>Object.hasOwn(extras,key)))throw fault('VOICE_API_CONFIG_INVALID');
    headers.set('content-type','application/json');
    return {headers,body:JSON.stringify({...extras,model:config.model,messages:[{role:'user',content}],stream:false})};
  }
  if (protocol==='custom'&&config.requestMode === 'json') {
    const body = template(checkTree(objectJson(config.jsonTemplate)), variables);
    headers.set('content-type', 'application/json');
    return {headers, body: JSON.stringify(body)};
  }
  if (protocol==='custom'&&config.requestMode !== 'multipart') throw fault('VOICE_API_CONFIG_INVALID');
  const fields=protocol==='openai-transcriptions'?{fileField:'file',modelField:'model',languageField:'language'}:config;
  const form = new FormData();
  form.set(fields.fileField, new Blob([bytes], {type: audio.mime}), audio.filename);
  if (config.model && fields.modelField) form.set(fields.modelField, config.model);
  if (config.language && fields.languageField) form.set(fields.languageField, config.language);
  const extras = template(checkTree(objectJson(config.extraFieldsJson)), variables);
  for (const [key, value] of Object.entries(extras)) {
    if ([fields.fileField, fields.modelField, fields.languageField].includes(key) || value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw fault('VOICE_API_CONFIG_INVALID');
    form.set(key, String(value ?? ''));
  }
  // The runtime must generate the multipart boundary itself.
  headers.delete('content-type');
  return {headers, body: form};
}

export async function limitedBody(response, maxBytes = 65536) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw fault('VOICE_API_RESPONSE_TOO_LARGE'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) { await response.body?.cancel().catch(()=>{});throw fault('VOICE_API_RESPONSE_TOO_LARGE'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function transcribeAudio(config, audio, {signal, fetchImpl = fetch} = {}) {
  config=effectiveSpeechSettings(config);
  validateConfig(config);
  const {url,protocol}=resolveApi(config);
  const request = requestFor(config, audio);
  const response = await fetchImpl(url, {method:'POST',...request,
    signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(config.timeoutMs)]),redirect:'error'});
  if (!response.ok) { await response.body?.cancel(); throw fault('VOICE_API_HTTP_'+response.status); }
  const body = await limitedBody(response);
  let value;
  try{value=protocol==='custom'&&config.responseMode==='text'?body:JSON.parse(body);}
  catch{if(protocol==='openai-transcriptions'&&/^text\/plain\b/i.test(response.headers.get('content-type')??''))value=body;else throw fault('VOICE_API_RESPONSE_INVALID');}
  let text;
  if(['openai-chat','chat-audio-data-url'].includes(protocol)){
    const content=value?.choices?.[0]?.message?.content;
    text=responseText(Array.isArray(content)?content.filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n'):content,'');
  }else text=responseText(value,protocol==='openai-transcriptions'?(typeof value==='string'?'':'text'):config.responseMode==='text'?'':config.responsePath);
  if (text.length > config.maxTranscriptChars) throw fault('VOICE_TRANSCRIPT_TOO_LONG');
  return text;
}

export function voiceErrorCode(error) {
  return /^VOICE_[A-Z0-9_]{3,80}$/.test(error.code ?? '') ? error.code
    : /^VOICE_[A-Z0-9_]{3,80}$/.test(error.message ?? '') ? error.message
    : ['AbortError','TimeoutError'].includes(error.name) ? 'VOICE_API_TIMEOUT' : 'VOICE_API_REQUEST_FAILED';
}

export async function recognize(ctx, {id}) {
  let stage='configuration';
  try {
    if (!/^[a-f0-9]{64}$/.test(id)) throw fault('VOICE_REFERENCE_INVALID');
    const config = effectiveSpeechSettings(ctx.config());validateConfig(config);
    const identity = crypto.createHash('sha256').update(JSON.stringify([ctx.account.id, ctx.chat.key, id, config])).digest('hex');
    if (config.cacheResults && cache.has(identity)) return {...cache.get(identity), cached: true};
    stage='audio';const audio = await ctx.audio.read(id, {format: config.audioFormat});
    if (audio.durationSeconds > config.maxDurationSeconds) throw fault('VOICE_DURATION_LIMIT');
    stage='api';const text = await transcribeAudio(config,audio,{signal:ctx.signal});
    const result = {ok: true, id, text};
    if (config.cacheResults) {
      cache.set(identity, result);
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    return result;
  } catch (error) {
    const code = voiceErrorCode(error);
    return {ok: false, code,stage};
  }
}
