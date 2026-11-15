// Pure helpers for the settings page (no DOM, no network); Node tests import
// them too. Provider presets live in providers.mjs.
import {PROVIDERS} from './providers.mjs';

const isLoopback = host => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
const hostMatches = (rule, host) => rule.startsWith('.') ? host === rule.slice(1) || host.endsWith(rule) : rule === host;
const providerForHost = host => host ? PROVIDERS.find(item => item.hosts?.some(rule => hostMatches(rule, host))) : undefined;

// Strips what people commonly paste around a key. Returns what was removed.
export function cleanApiKey(raw) {
  let value = String(raw ?? '');
  const removed = [], step = (pattern, label) => {
    const next = value.replace(pattern, '');
    if (next !== value) { value = next; if (!removed.includes(label)) removed.push(label); }
  };
  // Wrappers can nest in any order (e.g. Bearer "sk-…"), so repeat.
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

const OTHER_ROUTES = /\/(?:models|audio\/translations|embeddings|chat\/completions|completions|responses|images\/[a-z]+)\/?$/;

// Offline advice for an address field: {state, message, fix?, moveToKey?}.
// providerId names the selected provider, if any; websocket marks Realtime
// fields; expected is the method's official address (its path is checked).
export function endpointAdvice(raw, {providerId = '', websocket = false, expected = ''} = {}) {
  const original = String(raw ?? ''), value = original.trim().replace(/：/g, ':').replace(/／/g, '/').replace(/。/g, '.').replace(/[\s:.,，;；、]+$/, '');
  if (!value) return {state: '', message: ''};
  if (/^(?:sk-|sk_|Bearer\s)/i.test(value) || !/[./:]/.test(value) && value.length >= 20) return {state: 'error', message: '这里填的像是 API 密钥，请粘贴到密钥栏。', moveToKey: true, fix: '', fixLabel: '移到密钥栏'};
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(value)) return {state: 'error', message: '地址缺少开头的 https://。', fix: (/^(?:localhost|127\.)/i.test(value) ? 'http://' : websocket ? 'wss://' : 'https://') + value, fixLabel: '补上开头'};
    return {state: 'error', message: '地址格式不正确，应该以 https:// 开头，请从文档复制完整地址。'};
  }
  let url;
  try { url = new URL(value); } catch { return {state: 'error', message: '地址格式不正确，请从文档原样复制。'}; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), secure = websocket ? 'wss:' : 'https:', plain = websocket ? 'ws:' : 'http:';
  if (value !== original) return {state: 'warning', message: '地址中有多余的空格或全角符号。', fix: value, fixLabel: '自动修正'};
  if (url.username || url.password) return {state: 'error', message: '地址里不要包含账号密码，密钥请填到密钥栏。'};
  const allowed = websocket ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
  if (!allowed.includes(url.protocol)) return {state: 'error', message: `只支持 ${secure}// 地址。`};
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !isLoopback(host)) return {state: 'error', message: `网络服务需要使用 ${secure}// 地址；只有本机服务可以用 ${plain}//。`, fix: value.replace(/^(?:http|ws):/i, url.protocol === 'ws:' ? 'wss:' : 'https:'), fixLabel: `改成 ${secure}//`};
  const consoleProvider = PROVIDERS.find(entry => entry.consoleHosts?.includes(host));
  if (consoleProvider) return {state: 'error', message: `这是${consoleProvider.name}的网页地址，不是 API 地址。`, ...(expected && consoleProvider.id === providerId ? {fix: expected, fixLabel: '改成 API 地址'} : {})};
  const known = providerForHost(host), selected = PROVIDERS.find(item => item.id === providerId);
  if (selected && !known) return {state: 'error', message: `这个地址不属于${selected.name}，凭据不会发往这里。其他服务请改用“自定义模型 API”。`};
  // A provider address keeps the pasted host (e.g. an Alibaba workspace
  // domain) and only corrects the path.
  const path = expected && known && known.id === providerId ? new URL(expected).pathname.replace(/\/+$/, '') : '';
  if (path && !url.pathname.replace(/\/+$/, '').startsWith(path)) {
    const fix = url.protocol + '//' + url.host + path;
    return {state: 'warning', message: `${known.name}的地址应为 …${path}。`, fix, fixLabel: '改成正确地址'};
  }
  if (!websocket && OTHER_ROUTES.test(url.pathname)) {
    const fixed = new URL(url); fixed.pathname = url.pathname.replace(OTHER_ROUTES, '');
    return {state: 'warning', message: '这是其他接口的地址，请填写 API 基础地址或语音接口的完整地址。', fix: fixed.href.replace(/\/$/, ''), fixLabel: '改成基础地址'};
  }
  if (!websocket && (url.pathname === '/' || url.pathname === '')) return {state: 'warning', message: '地址只有域名，大多数接口的基础地址以 /v1 结尾。若接口文档不是这样，可忽略此提示。', fix: url.origin + '/v1', fixLabel: '末尾加上 /v1'};
  return {state: 'ok', message: ''};
}

const SPEECH_NAME = /tts|speech|cosyvoice|voice|audio|realtime|sovits|fish|kokoro|index-?tts|moss|eleven|scribe|asr|whisper|transcribe/i;
// Display order only: preset models and speech-looking names first.
export function rankModels(models = [], preferred = []) {
  const score = id => preferred.includes(id) ? 2 - preferred.indexOf(id) / 100 : SPEECH_NAME.test(id) ? 1 : 0;
  const sorted = [...models].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return {recommended: sorted.filter(id => score(id) > 0), others: sorted.filter(id => score(id) === 0)};
}

// Which field a service failure points at, so the page can mark it.
export const FAILURE_FIELDS = Object.freeze({
  VOICE_TTS_ENDPOINT: 'endpoint', VOICE_TTS_AUTH: 'key', VOICE_TTS_MODEL: 'model', VOICE_TTS_INVALID_AUDIO: 'model',
  VOICE_TTS_NETWORK: 'endpoint', VOICE_TTS_MODELS: 'model', VOICE_REALTIME_ENDPOINT: 'realtimeEndpoint',
  VOICE_REALTIME_CONFIG: 'realtimeModel', VOICE_REALTIME_NETWORK: 'realtimeEndpoint', VOICE_PROVIDER_CREDENTIAL: 'key',
  VOICE_TENCENT_KEY: 'key', VOICE_GOOGLE_KEY: 'key', VOICE_KEY_ORIGIN: 'key', VOICE_PROVIDER_HOST: 'endpoint',
  VOICE_PROVIDER_REGION: 'region', VOICE_AUTH_HEADER: 'authHeader', VOICE_TENCENT_APPID: 'appId', VOICE_AUTH_HEADER_REALTIME: 'auth',
  VOICE_TTS_STREAM_INCOMPLETE: 'voice', VOICE_CLONE_MODEL: 'voice',
});
