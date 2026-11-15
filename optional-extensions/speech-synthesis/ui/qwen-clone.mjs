import {activeOf} from './providers.mjs';

export const cloneAudioLimit = 7 * 1024 * 1024;
const CLONE_MODEL = /^qwen-audio-3\.[01]-(?:realtime|tts)-(?:flash|plus)$/;

// Where a cloned voice for the active TTS method is created, and the model it
// binds to: a Qwen Realtime or dedicated TTS model on an official Qwen or
// Bailian address. null when the active method cannot clone.
export function cloneTarget(services) {
  const tts = activeOf(services, 'tts');
  const model = String(tts.profile.model ?? '').trim();
  if (tts.entry !== 'qwen' || !tts.definition?.clone || !CLONE_MODEL.test(model)) return null;
  let url;
  try { url = new URL(String(tts.profile.endpoint ?? '').trim()); }
  catch { return null; }
  const hosts = ['maas.qianwenaiapi.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'];
  const workspace = /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/;
  if (!['https:', 'wss:'].includes(url.protocol) || url.port || url.username || url.password || url.hash ||
      !(hosts.includes(url.hostname) || workspace.test(url.hostname))) return null;
  return {endpoint: 'https://' + url.hostname + '/api/v1/services/audio/tts/customization', model, method: tts.method};
}
