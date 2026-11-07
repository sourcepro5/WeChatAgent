// Protocol choices shared by the plugin and compatible configuration pages.
// Model IDs are opaque upstream identifiers; never use them to select a route.
export const SPEECH_SERVICES = Object.freeze({
  auto: '自动识别地址（默认文件转写，推荐）',
  transcriptions: 'OpenAI 兼容 · 文件转写',
  'chat-audio': 'OpenAI 兼容 · Chat 音频（Base64）',
  'chat-audio-data-url': 'Chat 音频（Data URL 扩展）',
  advanced: '保留已有协议 / 自定义请求',
});

export function hasCustomRequest(settings) {
  return settings.requestMode === 'json'
    || settings.responseMode && settings.responseMode !== 'json'
    || settings.fileField && settings.fileField !== 'file'
    || settings.modelField && settings.modelField !== 'model'
    || settings.languageField && settings.languageField !== 'language'
    || settings.responsePath !== undefined && settings.responsePath !== 'text';
}

export function inferSpeechService(settings) {
  if (settings.apiProtocol === 'openai-transcriptions') return 'transcriptions';
  if (settings.apiProtocol === 'openai-chat') return 'chat-audio';
  if (settings.apiProtocol === 'chat-audio-data-url') return 'chat-audio-data-url';
  if (settings.apiProtocol && settings.apiProtocol !== 'auto' || hasCustomRequest(settings)) return 'advanced';
  return 'auto';
}

const fail = (message, field, code) => { throw Object.assign(Error(message), {field, code}); };

export function prepareSpeechSettings(settings, service = 'auto', {forModels = false} = {}) {
  if (!Object.hasOwn(SPEECH_SERVICES, service)) {
    fail('请按平台文档选择文件转写或 Chat 音频协议。', 'service', 'VOICE_API_CONFIG_INVALID');
  }
  if (service === 'advanced') return {...settings};
  const result = {...settings, endpoint: String(settings.endpoint ?? '').trim(), model: String(settings.model ?? '').trim()};
  if (forModels && !result.endpoint) return result;
  let url;
  try { url = new URL(result.endpoint); } catch { fail('请粘贴平台提供的 API 基础地址。', 'endpoint', 'VOICE_API_NOT_CONFIGURED'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && (host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)))) {
    fail('请使用 HTTPS 地址；本机服务可用 HTTP。不要在地址中填写账号密码。', 'endpoint', 'VOICE_API_ENDPOINT_INVALID');
  }
  if (/^https?:\/\//i.test(result.model)) fail('模型栏填写模型 ID，不要填写网址。', 'model', 'VOICE_MODEL_IS_URL');
  if (!forModels && !result.model) fail('请选择或粘贴平台提供的模型 ID。', 'model', 'VOICE_MODEL_REQUIRED');
  // Auto retains saved custom requests and explicit protocol choices. Choosing a
  // protocol below is the only operation that replaces the request defaults.
  if (service === 'auto') return result;
  const apiProtocol = {
    transcriptions: 'openai-transcriptions',
    'chat-audio': 'openai-chat',
    'chat-audio-data-url': 'chat-audio-data-url',
  }[service];
  return {...result, apiProtocol, requestMode: service === 'transcriptions' ? 'multipart' : 'json',
    audioFormat: 'wav', responseMode: 'json', responsePath: 'text'};
}

export function speechSetupHint(_settings, service) {
  return ({
    auto: '填写基础地址、密钥和模型 ID 即可。基础地址默认使用文件转写；完整 /chat/completions 地址使用 Chat 音频。模型名字不会改变协议。',
    transcriptions: '平台文档提供 /audio/transcriptions 时选此项。自动上传 WAV 文件并读取文字，支持任意模型 ID 或别名。',
    'chat-audio': '平台文档提供 /chat/completions 和 input_audio 时选此项。音频以 Base64 发送，模型必须支持音频输入。',
    'chat-audio-data-url': '仅在平台文档要求 input_audio.data 使用 data:audio/... 时选择；这是兼容扩展。',
    advanced: '保留已保存的协议、请求模板和字段映射。只有平台使用私有接口时才需编写模板。',
  })[service] ?? '请按平台文档选择接口协议。';
}

export function speechFailureHelp(code) {
  return ({
    VOICE_API_HTTP_404: '平台没有找到这个语音接口。请核对协议与基础地址（包括 /v1 和网关前缀）；模型能列出不代表平台开放了语音入口。',
    VOICE_API_HTTP_401: '密钥没有通过验证。请复制该平台的原始 API Key，不要带 Bearer、引号或环境变量名。',
    VOICE_API_HTTP_403: '密钥没有这个语音模型的使用权限，请在服务平台检查授权。',
    VOICE_API_HTTP_400: '平台拒绝了语音请求。请按平台文档核对协议，并确认模型支持音频输入。',
    VOICE_API_HTTP_429: '服务额度不足或请求过于频繁，请检查额度后稍后重试。',
    VOICE_API_TIMEOUT: '语音服务响应超时。请稍后重试，或在高级设置中调整等待时间。',
    VOICE_DECODER_MISSING: '本机语音转换组件未就绪，请检查宿主的 WAV 转换能力，或在平台支持时使用原始 SILK。',
  })[code];
}

export function effectiveSpeechSettings(settings) {
  // Keep the public helper for older host imports. No model/provider overrides.
  const result = {...settings};
  for (const key of ['endpoint', 'model']) {
    if (typeof result[key] === 'string') result[key] = result[key].trim();
  }
  return result;
}

// Deprecated exports retained because existing host pages import them by name.
// Neither participates in protocol selection or changes saved configurations.
export function modelService() { return ''; }
export const QWEN_AUDIO_TEMPLATE = JSON.stringify({model:'{{model}}',input:{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'{{audio_data_url}}'}}]}]},parameters:{format:'wav',sample_rate:'16000'}});
