// Pure helpers for the settings page (no DOM, no network). The page imports
// this file from ui/; Node tests import it too. Platforms are an explicit user
// choice that only pre-fills fields; model names never select a platform.

const ALIYUN_TEMPLATE = JSON.stringify({model: '{{model}}', messages: [{role: 'user', content: [{type: 'input_audio', input_audio: {data: '{{audio_data_url}}'}}]}], stream: false});

export const PLATFORMS = Object.freeze([
  {
    id: 'siliconflow', name: '硅基流动 SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1', apiProtocol: 'openai-transcriptions',
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'], keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    hosts: ['api.siliconflow.cn', 'api.siliconflow.com'], consoleHosts: ['cloud.siliconflow.cn', 'siliconflow.cn', 'www.siliconflow.cn', 'docs.siliconflow.cn', 'cloud.siliconflow.com', 'www.siliconflow.com'],
    tip: '国内可直接访问。SenseVoiceSmall 支持普通话、粤语、英语、日语和韩语。',
  },
  {
    id: 'aliyun', name: '阿里云百炼（千问 ASR）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiProtocol: 'custom',
    request: {requestMode: 'json', jsonTemplate: ALIYUN_TEMPLATE, responseMode: 'json', responsePath: 'choices.0.message.content'},
    models: ['qwen3-asr-flash'], keyUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    hosts: ['dashscope.aliyuncs.com', /\.cn-beijing\.maas\.aliyuncs\.com$/], consoleHosts: ['bailian.console.aliyun.com', 'dashscope.console.aliyun.com', 'help.aliyun.com', 'www.aliyun.com'],
    tip: '使用华北 2（北京）地域的 API Key。业务空间专属地址 https://<业务空间ID>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions 也可以直接粘贴。',
  },
  {
    id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', apiProtocol: 'openai-transcriptions',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], keyUrl: 'https://platform.openai.com/api-keys',
    hosts: ['api.openai.com'], consoleHosts: ['platform.openai.com', 'openai.com', 'www.openai.com', 'chatgpt.com'],
    tip: '国内网络通常无法直接访问。',
  },
  {
    id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', apiProtocol: 'openai-transcriptions',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'], keyUrl: 'https://console.groq.com/keys',
    hosts: ['api.groq.com'], consoleHosts: ['console.groq.com', 'groq.com', 'www.groq.com'],
    tip: '国内网络通常无法直接访问。',
  },
  {
    id: 'local', name: '本机语音服务（Whisper 等）', endpoint: 'http://127.0.0.1:8000/v1', apiProtocol: 'openai-transcriptions', models: [],
    tip: '适用于在本机运行、提供 OpenAI 兼容 /v1/audio/transcriptions 接口的服务。端口按你的服务修改，通常不需要密钥。',
  },
  {
    id: 'compatible', name: '其他 OpenAI 兼容平台', endpoint: '', apiProtocol: 'auto', models: [],
    tip: '粘贴平台文档里的 API 基础地址（通常以 /v1 结尾）。测试时会自动尝试文件转写和 Chat 音频两种方式。',
  },
  {
    id: 'custom', name: '自定义请求（私有接口）', apiProtocol: 'custom', models: [],
    tip: '在下方“高级设置”中按平台文档填写服务地址、请求模板和结果路径。',
  },
]);

export const platformById = id => PLATFORMS.find(item => item.id === id);
// Request defaults a standard (non-template) protocol expects.
export const STANDARD_REQUEST = Object.freeze({requestMode: 'multipart', audioFormat: 'wav', responseMode: 'json', responsePath: 'text', fileField: 'file', modelField: 'model', languageField: 'language', extraFieldsJson: '{}', authHeader: 'Authorization', authPrefix: 'Bearer '});

const isLoopback = host => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
const hostOf = value => { try { return new URL(String(value ?? '').trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
const matches = (rule, host) => typeof rule === 'string' ? rule === host : rule.test(host);
const platformForHost = host => host ? PLATFORMS.find(item => item.hosts?.some(rule => matches(rule, host))) : undefined;
const allPresetModels = new Set(PLATFORMS.flatMap(item => item.models));

// Which platform the saved settings belong to; never rewrites anything.
export function detectPlatform(values = {}) {
  const host = hostOf(values.endpoint), custom = values.apiProtocol === 'custom';
  if (!host) return custom ? 'custom' : '';
  const match = platformForHost(host);
  if (match) {
    if (match.apiProtocol === 'custom') return custom && values.requestMode === 'json' ? match.id : custom ? 'custom' : 'compatible';
    return custom ? 'custom' : match.id;
  }
  if (isLoopback(host)) return custom ? 'custom' : 'local';
  return custom ? 'custom' : 'compatible';
}

// Field values to apply when the user actively picks a platform.
export function platformPatch(id, current = {}) {
  const item = platformById(id);
  if (!item) return {};
  if (item.id === 'custom') return {apiProtocol: 'custom'};
  const patch = {...STANDARD_REQUEST, apiProtocol: item.apiProtocol, ...(item.request ?? {})};
  const currentHost = hostOf(current.endpoint), currentPlatform = platformForHost(currentHost);
  if (item.endpoint && !(currentPlatform === item || item.id === 'local' && isLoopback(currentHost))) patch.endpoint = item.endpoint;
  if (!item.endpoint && (currentPlatform || isLoopback(currentHost))) patch.endpoint = '';
  const model = String(current.model ?? '').trim();
  if (item.models.length && (!model || allPresetModels.has(model) && !item.models.includes(model))) patch.model = item.models[0];
  if (!item.models.length && allPresetModels.has(model)) patch.model = '';
  return patch;
}

// Strips what people commonly paste around a key. Returns what was removed.
export function cleanApiKey(raw) {
  let value = String(raw ?? '');
  const removed = [], step = (pattern, label, replace = '') => {
    const next = value.replace(pattern, replace);
    if (next !== value) { value = next; if (!removed.includes(label)) removed.push(label); }
  };
  // Wrappers can nest in any order (e.g. Bearer "sk-…", "Bearer sk-…"), so
  // repeat until nothing more comes off.
  for (let pass = 0, before; pass < 4 && before !== value; pass++) {
    before = value;
    step(/^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu, '首尾的空格或换行');
    step(/^Authorization\s*:\s*/i, '“Authorization:”');
    step(/^(?:export\s+|set\s+)?[A-Z][A-Z0-9_]*\s*=\s*/, '变量名（如 API_KEY=）');
    step(/^(?:export\s+|set\s+)?["']?[A-Za-z_]*(?:key|Key|KEY|token|Token|TOKEN|secret|Secret|SECRET)[A-Za-z0-9_]*["']?\s*[=:]\s*/, '变量名（如 API_KEY=）');
    step(/[,;]+$/, '末尾的逗号或分号');
    if (/^["'`“‘]/.test(value) && /["'`”’]$/.test(value) && value.length > 1) { value = value.slice(1, -1); if (!removed.includes('引号')) removed.push('引号'); }
    step(/^Bearer\s+/i, '“Bearer ”前缀');
  }
  step(/[\s\p{Cf}]+/gu, '中间的空格或换行');
  return {value, removed};
}

const OTHER_ROUTES = /\/(?:models|audio\/speech|audio\/translations|embeddings|completions|responses|images\/[a-z]+)\/?$/;

// Offline advice for the endpoint field: {state, message, fix?, moveToKey?}.
export function endpointAdvice(raw, platformId = '') {
  const original = String(raw ?? ''), value = original.trim().replace(/：/g, ':').replace(/／/g, '/').replace(/。/g, '.').replace(/[\s:.,，;；、]+$/, '');
  if (!value) return {state: '', message: ''};
  const item = platformById(platformId);
  if (/^(?:sk-|sk_|gsk_|Bearer\s)/i.test(value) || !/[./:]/.test(value) && value.length >= 20) return {state: 'error', message: '这里填的像是 API 密钥，请粘贴到下面的“API 密钥”栏。', moveToKey: true, fix: item?.endpoint || undefined, fixLabel: item?.endpoint ? '移到密钥栏并填入平台地址' : '移到密钥栏'};
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(value)) return {state: 'error', message: '地址缺少开头的 https://。', fix: (/^(?:localhost|127\.)/i.test(value) ? 'http://' : 'https://') + value, fixLabel: '补上开头'};
    return {state: 'error', message: '地址格式不正确，应该以 https:// 开头，从平台文档复制完整地址。'};
  }
  let url;
  try { url = new URL(value); } catch { return {state: 'error', message: '地址格式不正确，请从平台文档原样复制。'}; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (value !== original) return {state: 'warning', message: '地址中有多余的空格或全角符号。', fix: value, fixLabel: '自动修正'};
  if (url.username || url.password) return {state: 'error', message: '地址里不要包含账号密码，密钥请填到“API 密钥”栏。'};
  if (url.protocol === 'http:' && !isLoopback(host)) return {state: 'error', message: '网络服务需要使用 https:// 地址；只有本机服务可以用 http://。', fix: 'https://' + value.slice('http://'.length), fixLabel: '改成 https://'};
  if (!['http:', 'https:'].includes(url.protocol)) return {state: 'error', message: '只支持 https:// 地址。'};
  const consolePlatform = PLATFORMS.find(entry => entry.consoleHosts?.includes(host));
  if (consolePlatform) return {state: 'error', message: `这是${consolePlatform.name}的网页地址，不是 API 地址。`, fix: consolePlatform.endpoint, fixLabel: '改成 API 地址'};
  const known = platformForHost(host);
  if (known?.endpoint) {
    const expected = new URL(known.endpoint), base = known.id === 'aliyun' ? '/compatible-mode/v1' : expected.pathname;
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith(base)) return {state: 'warning', message: `${known.name}的 API 地址应为 ${known.endpoint}。`, fix: known.id === 'aliyun' ? url.origin + expected.pathname : known.endpoint, fixLabel: '改成正确地址'};
    if (known.id === 'aliyun' && platformId === 'aliyun' && path !== base + '/chat/completions') return {state: 'warning', message: '千问 ASR 需要完整的 /compatible-mode/v1/chat/completions 地址。', fix: url.origin + base + '/chat/completions', fixLabel: '补全地址'};
  }
  if (OTHER_ROUTES.test(url.pathname) && !/\/chat\/completions\/?$/.test(url.pathname)) {
    const fixed = new URL(url); fixed.pathname = url.pathname.replace(OTHER_ROUTES, '');
    return {state: 'warning', message: '这是平台的其他接口地址，语音识别需要 API 基础地址。', fix: fixed.href.replace(/\/$/, ''), fixLabel: '改成基础地址'};
  }
  if (url.pathname === '/' || url.pathname === '') return {state: 'warning', message: '地址只有域名，大多数平台的 API 地址以 /v1 结尾。若平台文档不是这样，可忽略此提示。', fix: url.origin + '/v1', fixLabel: '末尾加上 /v1'};
  return {state: 'ok', message: ''};
}

const SPEECH_NAME = /whisper|asr|sensevoice|speech|transcri|paraformer|telespeech|stt|audio|voice/i;
// Display order only: platform-recommended and speech-looking names first.
export function rankModels(models = [], platformId = '') {
  const preferred = platformById(platformId)?.models ?? [];
  const score = model => preferred.includes(model.id) ? 2 - preferred.indexOf(model.id) / 100 : SPEECH_NAME.test(model.id) || model.audioDeclared === true ? 1 : 0;
  const sorted = [...models].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  return {recommended: sorted.filter(model => score(model) > 0), others: sorted.filter(model => score(model) === 0)};
}

export const PROTOCOL_NAMES = Object.freeze({
  auto: '自动', 'openai-transcriptions': '文件转写', 'openai-chat': 'Chat 音频（Base64）',
  'chat-audio-data-url': 'Chat 音频（Data URL）', 'anthropic-messages': 'Anthropic Messages', custom: '自定义请求',
});
