import {maximumWavBytes, normalizeWav} from './wav.mjs';
import {authHeaders} from './resolve.mjs';

const speechPath = '/audio/speech';
const recognitionPath = '/audio/transcriptions';
const codeError = code => new Error(code);
// Settings saved before 1.2.0 have no speed; 1 means the provider default.
const speedOf = settings => settings.speed ?? 1;
const shortString = (value, length) => typeof value === 'string' && !!value.trim() &&
  value.length <= length && !/[\x00-\x1f\x7f]/.test(value);

export const failureMessages = {
  VOICE_TTS_CONFIG: '请检查服务地址、语音模型、音色和语速是否已填写。',
  VOICE_TTS_ENDPOINT: '请填写 HTTP 或 HTTPS API 基础地址，或完整 /audio/speech 地址。',
  VOICE_TTS_AUTH: 'API 密钥没有通过验证，请重新复制平台的密钥；也可能是该密钥没有这个模型的使用权限。',
  VOICE_TTS_MODEL: '平台找不到这个模型或语音接口，请核对服务地址和语音模型。',
  VOICE_TTS_HTTP: '平台拒绝了这次请求，常见原因是音色和模型不匹配、语速超出范围或额度不足。',
  VOICE_TTS_NETWORK: '连不上语音服务，请核对服务地址和网络（部分海外平台国内无法直接访问）。',
  VOICE_TTS_TIMEOUT: '语音服务响应超时。',
  VOICE_TTS_INVALID_AUDIO: '这个模型没有返回可用的 WAV 音频，请换一个语音模型或平台。',
  VOICE_TTS_TOO_LONG: '生成的音频超过 60 秒，请缩短文字。',
  VOICE_TTS_TOO_LARGE: '服务返回的数据超过大小上限。',
  VOICE_TTS_MODELS: '服务没有返回可用的模型列表，可以手动填写模型 ID。',
  VOICE_TTS_TRANSCRIPT: '服务未返回可用的转写文本。',
  VOICE_REALTIME_ENDPOINT: '请填写有效的 Realtime WebSocket 地址或 API 基础地址。',
  VOICE_REALTIME_CONFIG: '请填写 Realtime 模型和音色 ID。',
  VOICE_REALTIME_TIMEOUT: '实时语音服务响应超时。',
  VOICE_REALTIME_NETWORK: '无法连接实时语音服务，请核对地址、密钥和模型权限。',
  VOICE_REALTIME_PROVIDER: '实时语音服务未完成回复，请检查模型和音色配置。',
  VOICE_REALTIME_AUDIO: '实时语音服务没有返回完整的 PCM 音频。',
  VOICE_REALTIME_TOO_LONG: '实时回复超过 60 秒，请缩短回复要求。',
  VOICE_REALTIME_INCOMPLETE: '实时对话模型没有完整给出回复，本轮未发送。',
  VOICE_REALTIME_CHOICE_INVALID: '实时对话模型没有按要求给出回复形式和正文，本轮未发送。',
  VOICE_REALTIME_TRANSCRIPT_MISMATCH: '模型朗读的内容与选定的正文不一致，本轮未发送语音。',
  VOICE_REALTIME_TRANSCRIPT: '语音服务未返回有效的转写结果。',
  VOICE_REALTIME_RECOGNITION_REQUIRED: '请为此平台填写兼容的识别模型和识别地址。',
  VOICE_REALTIME_TEXT_INPUT_UNSUPPORTED: '该实时对话服务不接受文字输入，文字消息改由原有链路处理。',
  VOICE_REALTIME_INPUT_INVALID: '实时对话请求缺少语音或文字输入。',
  VOICE_TTS_INVALID_TEXT: '要朗读的文字为空或过长。',
  VOICE_CLONE_CONFIG: '当前语音合成方式不支持声音复刻，或服务地址、模型、凭据不完整。',
  VOICE_CLONE_PREFIX: '音色名称前缀需要 1–10 个英文字母或数字。',
  VOICE_CLONE_AUDIO: '请选择有效的 WAV、MP3 或 M4A 录音，大小不超过 7 MiB。',
  VOICE_CLONE_ID: '请填写有效的复刻音色 ID。',
  VOICE_CLONE_MODEL: '这个音色绑定了其他模型，请切换到创建音色时使用的模型。',
  VOICE_CLONE_RESPONSE: '语音服务没有返回可识别的音色结果，请在服务控制台核对音色记录。',
  VOICE_CLONE_HTTP: '语音服务拒绝了请求，请核对模型权限、录音要求或音色 ID。',
  VOICE_CLONE_UNCERTAIN: '提交结果未确认。请先在语音服务控制台查询是否已创建音色，再尝试重新提交。',
  VOICE_PROVIDER_CREDENTIAL: '请先填写所选服务的凭据。',
  VOICE_PROVIDER_HOST: '服务地址不属于所选提供商，已停止发送凭据。请恢复该提供商的官方地址，或改用“自定义模型 API”。',
  VOICE_KEY_ORIGIN: '自定义接口的地址已变化。为避免把已保存的密钥发往新地址，请重新填写密钥后再测试或保存。',
  VOICE_PROVIDER_UNSUPPORTED: '所选服务没有接通这项能力。',
  VOICE_PROVIDER_REGION: '请选择或填写有效的区域。',
  VOICE_TENCENT_KEY: '请同时填写腾讯云 SecretId 和 SecretKey。',
  VOICE_GOOGLE_KEY: '请选择有效的 Google Cloud 服务账号 JSON（type 为 service_account，包含 client_email 和 private_key）。',
  VOICE_AUTH_HEADER: '请填写有效的鉴权请求头名称（字母、数字和短横线）。',
  VOICE_AUTH_HEADER_REALTIME: 'Realtime WebSocket 只支持 Bearer 鉴权或无需鉴权。',
  VOICE_TTS_NOT_CONFIGURED: '尚未配置语音合成服务。',
  VOICE_RECOGNITION_NOT_CONFIGURED: '尚未配置所选的识别方式。',
  VOICE_RECOGNITION_OFF: '当前设置为不识别微信语音。',
  VOICE_REALTIME_ASR_TOO_LONG: '这条语音较长，实时识别无法在等待时间内完成。可以改用单条语音识别。',
  VOICE_TENCENT_APPID: '请填写腾讯云账号的 APPID（纯数字）。',
  VOICE_TTS_STREAM_INCOMPLETE: '语音合成服务没有返回完整的音频。',
  VOICE_CLONE_TARGET: '当前语音合成方式不支持复刻音色。',
};

function endpoint(value, models) {
  let url;
  try { url = new URL(value.trim()); }
  catch { throw codeError('VOICE_TTS_ENDPOINT'); }
  if (models && url.protocol === 'wss:') url.protocol = 'https:';
  if (models && url.protocol === 'ws:') url.protocol = 'http:';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw codeError('VOICE_TTS_ENDPOINT');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (models) {
    const base = pathname.replace(/\/(audio\/(speech|transcriptions)|realtime)$/, '');
    if (pathname.endsWith('/realtime')) url.searchParams.delete('model');
    url.pathname = (base || (pathname ? '' : '/v1')) + '/models';
  }
  else url.pathname = pathname.endsWith(speechPath) ? pathname : (pathname || '/v1') + speechPath;
  return url;
}

export function validateSettings(settings, models = false) {
  const url = endpoint(settings.endpoint, models);
  if (typeof settings.apiKey !== 'string' || /[\r\n\0]/.test(settings.apiKey) ||
      !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 25000 ||
      !models && (!shortString(settings.model, 200) || !shortString(settings.voice, 200) ||
        typeof settings.instructions !== 'string' || settings.instructions.length > 4096 || !Number.isFinite(speedOf(settings)) ||
        speedOf(settings) < 0.25 || speedOf(settings) > 4)) {
    throw codeError('VOICE_TTS_CONFIG');
  }
  return url;
}

export async function responseBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw codeError('VOICE_TTS_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw codeError('VOICE_TTS_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

// OpenAI-compatible HTTP routes. service is a resolved capability service
// (lib/resolve.mjs): service.flat holds the request values, service.key the
// credential that may go to this address.
async function request(service, {text, signal, fetchImpl = fetch}) {
  const settings = service.flat, models = text === undefined;
  const url = validateSettings(settings, models);
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const headers = {...authHeaders(service), Accept: models ? 'application/json' : 'audio/wav, application/octet-stream'};
  const body = models ? undefined : JSON.stringify({
    model: settings.model.trim(), input: text, voice: settings.voice.trim(), response_format: 'wav',
    ...(speedOf(settings) !== 1 ? {speed: speedOf(settings)} : {}),
    ...(settings.instructions.trim() ? {instructions: settings.instructions.trim()} : {}),
  });
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetchImpl(url, {method: models ? 'GET' : 'POST', headers, body, redirect: 'error', signal: requestSignal});
    if (!response.ok) {
      await response.body?.cancel();
      // A missing /models route only means the list is unavailable; IDs can be typed.
      throw codeError([401, 403].includes(response.status) ? 'VOICE_TTS_AUTH'
        : response.status === 404 ? models ? 'VOICE_TTS_MODELS' : 'VOICE_TTS_MODEL' : 'VOICE_TTS_HTTP');
    }
    return await responseBytes(response, models ? 512 * 1024 : maximumWavBytes);
  } catch (error) {
    if (requestSignal.aborted) throw codeError('VOICE_TTS_TIMEOUT');
    if (Object.hasOwn(failureMessages, error.message)) throw error;
    throw codeError('VOICE_TTS_NETWORK');
  }
}

export async function speechSynthesize(service, text, options = {}) {
  return normalizeWav(await request(service, {text, ...options}));
}

// Model IDs for the settings page; any audio route or /realtime maps to /models.
export async function speechModels(service, options = {}) {
  const bytes = await request({...service, flat: {...service.flat, model: '', voice: ''}}, options);
  let data;
  try { data = JSON.parse(bytes).data; } catch {}
  if (!Array.isArray(data)) throw codeError('VOICE_TTS_MODELS');
  const key = service.key;
  return {models: [...new Set(data.map(row => row?.id)
    .filter(id => shortString(id, 200) && (!key || !id.includes(key))))].slice(0, 200)};
}

// A base address gets /audio/transcriptions; a full route (speech or
// transcriptions, with any query) keeps its prefix and query.
export function transcriptionUrl(value) {
  const url = endpoint(String(value ?? ''), false);
  const normalized = url.pathname.slice(0, -speechPath.length);
  url.pathname = normalized.endsWith(recognitionPath) ? normalized : normalized + recognitionPath;
  return url;
}

export async function transcriptionsTranscribe(service, wav, {signal, fetchImpl = fetch} = {}) {
  const settings = service.flat;
  if (!shortString(settings.model, 200)) throw codeError('VOICE_TTS_CONFIG');
  const url = transcriptionUrl(settings.endpoint);
  if (/[\r\n\0]/.test(service.key)) throw codeError('VOICE_TTS_CONFIG');
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const body = new FormData();
  body.append('file', new Blob([wav], {type: 'audio/wav'}), 'voice.wav');
  body.append('model', settings.model.trim());
  try {
    const response = await fetchImpl(url, {method: 'POST', headers: authHeaders(service), body, redirect: 'error', signal: requestSignal});
    if (!response.ok) {
      await response.body?.cancel();
      throw codeError([401, 403].includes(response.status) ? 'VOICE_TTS_AUTH' : response.status === 404 ? 'VOICE_TTS_MODEL' : 'VOICE_TTS_HTTP');
    }
    const {text} = JSON.parse(await responseBytes(response, 128 * 1024));
    if (!shortString(typeof text === 'string' ? text.trim().replace(/[\r\n\t]/g, ' ') : text, 4000)) {
      throw codeError('VOICE_TTS_TRANSCRIPT');
    }
    return text.trim();
  } catch (error) {
    if (requestSignal.aborted) throw codeError('VOICE_TTS_TIMEOUT');
    if (Object.hasOwn(failureMessages, error.message)) throw error;
    if (error instanceof SyntaxError) throw codeError('VOICE_TTS_TRANSCRIPT');
    throw codeError('VOICE_TTS_NETWORK');
  }
}
