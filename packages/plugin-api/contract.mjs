// Pure shared data: installer, runtime, worker, DSH health and console UI use it.
export const API_VERSION = 2;
export const HOST_RUNTIME = 'isolated-v2';
export const CONTRACT_REVISION = 'wechatagent-plugin-v2.2';
export const PERMISSION_LABELS = Object.freeze({
  storage: '保存插件数据',
  history_read: '读取当前聊天历史',
  web_fetch: '访问公开网页',
  reply: '申请发送当前聊天回复',
  documents: '保存日记等独立文档',
  persona_read: '读取当前聊天人格',
  model_generate: '独立调用当前模型（会产生消耗）',
  schedule: '按设置的每日时间执行',
  audio_read: '读取当前微信语音（语音识别插件会上传至所配置的 API）',
});
export const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_LABELS));
export const FEATURE_LABELS = Object.freeze({
  'actions-v1': '宿主动作',
  'documents-v1': '独立文档',
  'persona-read-v1': '当前人设读取',
  'model-utility-v1': '独立模型生成',
  'daily-schedule-v1': '每日计划',
  'voice-input-v1': '微信语音输入',
  'diary-question-v1': '微信日记询问',
});
export const HOST_FEATURES = Object.freeze(Object.keys(FEATURE_LABELS));
export const PERMISSION_FEATURES = Object.freeze({
  documents: 'documents-v1', persona_read: 'persona-read-v1',
  model_generate: 'model-utility-v1', schedule: 'daily-schedule-v1', audio_read: 'voice-input-v1',
});
export const HOOKS = Object.freeze(['before-context', 'after-response']);
// Host features that hand one kind of incoming chat event to one plugin action.
// A plugin opts in by declaring the feature (or the permission that implies it)
// and registering the action; the host never routes these by plugin id.
export const FEATURE_ENTRIES = Object.freeze({
  'voice-input-v1': Object.freeze({action: 'transcribe', permission: 'audio_read'}),
  'diary-question-v1': Object.freeze({action: 'ask', permission: 'reply'}),
});

export function requiredHostFeatures(item) {
  return [...new Set([...(item.requiresHostFeatures ?? []), ...(item.permissions ?? []).map(name => PERMISSION_FEATURES[name]).filter(Boolean), ...(item.schedule ? ['daily-schedule-v1'] : [])])];
}

export function hostContract() {
  return {apiVersion: API_VERSION, runtime: HOST_RUNTIME, revision: CONTRACT_REVISION, permissions: [...PERMISSIONS], features: [...HOST_FEATURES]};
}

export function contractFingerprint(contract = hostContract()) {
  return JSON.stringify([contract.apiVersion, contract.runtime, contract.revision, [...(contract.permissions ?? [])].sort(), [...(contract.features ?? [])].sort()]);
}

export function hostCompatibility(item, live) {
  const required = requiredHostFeatures(item);
  if (!live) return {compatible: false, reason: 'DSH 插件宿主未连接，请连接后再启用。', missingFeatures: required, missingPermissions: []};
  const version = live.apiVersion ?? live.pluginApiVersion ?? live.extensionApiVersion;
  const runtime = live.runtime ?? live.pluginRuntime;
  const rawFeatures = live.features ?? live.pluginHostFeatures;
  const features = Array.isArray(rawFeatures) ? rawFeatures.filter(name=>typeof name==='string') : [];
  const permissions = live.permissions ?? live.pluginPermissions;
  const missingFeatures = required.filter(name => !features.includes(name));
  const missingPermissions = Array.isArray(permissions) ? (item.permissions ?? []).filter(name => !permissions.includes(name)) : [];
  if (version !== API_VERSION || runtime !== HOST_RUNTIME) return {compatible: false, reason: 'DSH 插件宿主版本不兼容，请准备配置并完整重开 DSH。', missingFeatures, missingPermissions};
  const missing = [...missingFeatures.map(name => FEATURE_LABELS[name] ?? name), ...missingPermissions.map(name => PERMISSION_LABELS[name] ?? name)];
  return {compatible: !missing.length, missingFeatures, missingPermissions, reason: missing.length ? '当前 DSH 宿主缺少：'+[...new Set(missing)].join('、')+'。请更新宿主、准备配置并完整重开 DSH。' : ''};
}

// Kept in one place so prepare/build checks cannot omit a new runtime module.
export const PLUGIN_HOST_FILES = Object.freeze([
  'packages/plugin-api/contract.mjs', 'packages/plugin-api/catalog.mjs',
  'packages/plugin-api/index.mjs', 'packages/plugin-api/process.mjs',
  'packages/plugin-api/worker.mjs', 'packages/plugin-api/installer.mjs',
  'packages/plugin-api/zip.mjs', 'packages/plugin-api/documents.mjs',
  'packages/plugin-api/model-utility.mjs', 'packages/plugin-api/audio.mjs',
  'packages/plugin-api/voice-status.mjs',
]);
export const VOICE_CODEC_FILES = Object.freeze([
  'scripts/decode-wechat-voice.py', 'scripts/decode-wechat-voice.mjs',
  'packages/voice-codec/silk-wasm/package.json', 'packages/voice-codec/silk-wasm/LICENSE',
  'packages/voice-codec/silk-wasm/PROVENANCE.json', 'packages/voice-codec/silk-wasm/lib/index.mjs', 'packages/voice-codec/silk-wasm/lib/silk.wasm',
]);
export const VOICE_HOST_FILES = Object.freeze([
  ...VOICE_CODEC_FILES, 'scripts/wechat_voice_input.py', 'scripts/voice-requirements.txt',
  'scripts/reader-api.py', 'scripts/hook-onebot.mjs', 'scripts/reader-account-state.mjs',
  'components/qq-bridge/src/core/voice-ingress.js', 'components/qq-bridge/src/onebot/normalize.js',
  'components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js',
  'components/qq-bridge/src/social-bridge.js', 'components/qq-bridge/src/dsh/plugin-client.js',
]);
