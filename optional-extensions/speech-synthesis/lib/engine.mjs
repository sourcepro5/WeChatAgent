// Runs a capability with its selected service: speech synthesis for DSH's
// reply text, and recognition of one WeChat voice by the selected method
// (realtime or single file). Every call resolves its own service, so each
// capability uses its own provider, address and credential.
import {resolveService} from './resolve.mjs';
import {speechModels, speechSynthesize, transcriptionsTranscribe} from './service.mjs';
import {cloudListable, cloudLists, cloudSynthesize, cloudTranscribe} from './cloud.mjs';
import {qwenSynthesize, qwenTranscribe} from './qwen.mjs';
import {openaiTranscribe, qwenAsrTranscribe, tencentTranscribe} from './asr-realtime.mjs';
import {speak, transcribeRealtime} from './realtime.mjs';
import {CAPABILITY_IDS, KEY_FIELDS, servicesOf} from '../ui/providers.mjs';

const fault = code => new Error(code);

// A provider needs its credential; a custom API whose saved key belongs to
// other addresses must not run without it.
export function ready(settings, capability) {
  const service = resolveService(settings, capability);
  if (!service.key) {
    if (service.entry !== 'custom') throw fault('VOICE_PROVIDER_CREDENTIAL');
    if (service.profile.auth !== 'none') {
      const services = service.services;
      const elsewhere = CAPABILITY_IDS.some(slot => services.owners[slot]?.entry === 'custom' && String(settings[KEY_FIELDS[slot]] ?? '').trim()) ||
        services.legacy?.entry === 'custom' && String(settings.apiKey ?? '').trim();
      if (elsewhere) throw fault('VOICE_KEY_ORIGIN');
    }
  }
  return service;
}

export async function synthesizeText(settings, text, options = {}) {
  const service = ready(settings, 'tts');
  switch (service.kind) {
    case 'openai-speech': return speechSynthesize(service, text, options);
    case 'realtime-speak': return speak(service.flat, text, options);
    case 'qwen-tts': return qwenSynthesize(service, text, options);
    default: return cloudSynthesize(service, service.flat, text, options);
  }
}

// The Realtime voice settings for direct dialogue (voice-dialogue-v1).
export function dialogueSettings(settings) {
  const service = ready(settings, 'tts');
  if (service.kind !== 'realtime-speak') throw fault('VOICE_REALTIME_CONFIG');
  return service.flat;
}

// method: 'realtime' or 'file'; defaults to the recognition method the user chose.
export async function transcribeVoice(settings, wav, {method, signal, onPartial, fetchImpl, WebSocketImpl} = {}) {
  const which = method ?? servicesOf(settings).recognition;
  if (which === 'off') throw fault('VOICE_RECOGNITION_OFF');
  const service = ready(settings, which === 'realtime' ? 'realtimeAsr' : 'fileAsr');
  const options = {signal, onPartial, WebSocketImpl, ...(fetchImpl ? {fetchImpl} : {})};
  switch (service.kind) {
    case 'realtime-session': return transcribeRealtime(service.flat, wav, options);
    case 'qwen-asr-realtime': return qwenAsrTranscribe(service, wav, options);
    case 'openai-transcription': return openaiTranscribe(service, wav, options);
    case 'tencent-asr-ws': return tencentTranscribe(service, wav, options);
    case 'openai-transcriptions': return transcriptionsTranscribe(service, wav, options);
    case 'qwen-chat-asr': return qwenTranscribe(service, wav, options);
    default: return cloudTranscribe(service, service.flat, wav, options);
  }
}

// Model (and voice) lists for the settings page, where the service offers them.
export async function listFor(settings, capability, options = {}) {
  const service = resolveService(settings, capability);
  if (service.entry !== 'custom' && !service.key) throw fault('VOICE_PROVIDER_CREDENTIAL');
  if (['openai-speech', 'openai-transcriptions', 'openai-transcription', 'realtime-speak'].includes(service.kind)) return speechModels(service, options);
  if (cloudListable(service.entry)) return cloudLists(service, service.flat, options);
  throw fault('VOICE_TTS_MODELS');
}
