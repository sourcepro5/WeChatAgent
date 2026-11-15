import {cloneAudioLimit, cloneTarget} from '../ui/qwen-clone.mjs';
import {responseBytes} from './service.mjs';

const fault = code => new Error(code);
const audioTypes = {wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4'};
const voiceIdPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
export const maxCloneBase64 = 4 * Math.ceil(cloneAudioLimit / 3);

function audioData(format, base64) {
  if (!Object.hasOwn(audioTypes, format) || typeof base64 !== 'string' || !base64.length ||
      base64.length > maxCloneBase64 || base64.length % 4) throw fault('VOICE_CLONE_AUDIO');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 12 || bytes.length > cloneAudioLimit || bytes.toString('base64') !== base64) throw fault('VOICE_CLONE_AUDIO');
  const signature = format === 'wav' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    : format === 'm4a' ? bytes.toString('ascii', 4, 8) === 'ftyp'
    : bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224;
  if (!signature) throw fault('VOICE_CLONE_AUDIO');
  return 'data:' + audioTypes[format] + ';base64,' + base64;
}

// service: the resolved TTS service (lib/resolve.mjs); the voice is created on
// the same account and address the TTS method uses.
async function request(service, input, {signal, fetchImpl = fetch} = {}) {
  const target = cloneTarget(service.services), settings = service.flat, key = service.key;
  if (!target || !key || /[\x00-\x1f\x7f]/.test(key) ||
      !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 25000) throw fault('VOICE_CLONE_CONFIG');
  const endpoint = target.endpoint;
  const creating = input.action === 'create_voice';
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({model: 'voice-enrollment', input}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw fault('VOICE_TTS_AUTH');
      throw fault(creating && response.status >= 500 ? 'VOICE_CLONE_UNCERTAIN' : 'VOICE_CLONE_HTTP');
    }
    try {
      const {output} = JSON.parse(await responseBytes(response, 64 * 1024));
      if (!output || typeof output !== 'object') throw fault('VOICE_CLONE_RESPONSE');
      return output;
    } catch {
      throw fault(creating ? 'VOICE_CLONE_UNCERTAIN' : 'VOICE_CLONE_RESPONSE');
    }
  } catch (error) {
    if (/^VOICE_(?:CLONE|TTS)_[A-Z_]+$/.test(error.message)) throw error;
    throw fault(creating ? 'VOICE_CLONE_UNCERTAIN' : requestSignal.aborted ? 'VOICE_TTS_TIMEOUT' : 'VOICE_TTS_NETWORK');
  }
}

export async function cloneVoice(service, {prefix, format, base64}, options) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(prefix)) throw fault('VOICE_CLONE_PREFIX');
  const target_model = cloneTarget(service.services)?.model;
  const audio = audioData(format, base64);
  const output = await request(service, {action: 'create_voice', target_model, prefix, audio}, options);
  if (typeof output.voice_id !== 'string' || !voiceIdPattern.test(output.voice_id)) throw fault('VOICE_CLONE_UNCERTAIN');
  return {voiceId: output.voice_id};
}

// A voice is usable only for the model it was created for, and only once ready.
export async function queryVoice(service, voiceId, options) {
  if (typeof voiceId !== 'string' || !voiceIdPattern.test(voiceId)) throw fault('VOICE_CLONE_ID');
  const output = await request(service, {action: 'query_voice', voice_id: voiceId}, options);
  if (!['OK', 'DEPLOYING', 'UNDEPLOYED'].includes(output.status) || typeof output.target_model !== 'string') throw fault('VOICE_CLONE_RESPONSE');
  if (output.target_model !== cloneTarget(service.services)?.model) throw fault('VOICE_CLONE_MODEL');
  return {voiceId, status: output.status, targetModel: output.target_model};
}
