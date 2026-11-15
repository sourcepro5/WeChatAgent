import {featurePlugins} from '../packages/plugin-api/catalog.mjs';
import {PluginRuntime} from '../packages/plugin-api/index.mjs';
import {createAudioReader} from '../packages/plugin-api/audio.mjs';
import {voicePcm} from './decode-wechat-voice.mjs';

export const outputFeature = 'voice-output-v1';
export const dialogueFeature = 'voice-dialogue-v1';
const maximumBytes = 2 * 1024 * 1024;
const chunkBytes = 256 * 1024;
export const maxReplyChars = 600;
const fault = (code, status) => Object.assign(new Error(code), {code, status});

export class VoiceSynthesis {
  constructor(root, {fetchImpl = fetch} = {}) {
    this.root = root;
    this.readAudio = createAudioReader(root, {fetchImpl});
  }

  candidates(key, feature) {
    return featurePlugins(this.root, feature, key);
  }

  selected(key, feature = outputFeature) {
    const candidates = this.candidates(key, feature);
    if (!candidates.length) throw fault('VOICE_TTS_PLUGIN_DISABLED', 409);
    if (candidates.length > 1) throw fault('VOICE_TTS_PLUGIN_CONFLICT', 409);
    return candidates[0];
  }

  // voice-output-v1: {text} -> WAV. voice-dialogue-v1: one Realtime turn for a
  // voice reference or a text message; the plugin returns the chosen form and
  // text, with WAV only for a voice reply.
  async generate({account, key, text, voiceId, selected, feature = outputFeature, voiceAllowed = true, textAllowed = true}) {
    let runtime = this.runtime;
    if (!runtime || this.account !== account) {
      const previous = runtime;
      runtime = new PluginRuntime({
        root: this.root, accountScope: account, readAudio: this.readAudio, onlyFeatures: [outputFeature, dialogueFeature],
      });
      this.runtime = runtime;
      this.account = account;
      await previous?.dispose();
    }
    const allowed = () => {
      const candidates = featurePlugins(this.root, feature, key);
      return this.runtime === runtime && candidates.length === 1 && candidates[0].id === selected.id &&
        candidates[0].generation === selected.generation && runtime.isActive(selected.id, key);
    };
    const chunks = [];
    let size = 0;
    function writeVoice(base64) {
      if (!base64.length || base64.length > 4 * Math.ceil(chunkBytes / 3) || base64.length % 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fault('VOICE_TTS_INVALID_AUDIO', 502);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64 || bytes.length > chunkBytes ||
          size + bytes.length > maximumBytes || chunks.length >= 8) throw fault('VOICE_TTS_INVALID_AUDIO', 502);
      size += bytes.length;
      chunks.push(bytes);
    }
    let invocation;
    try {
      await runtime.sync();
      if (!allowed()) throw fault('VOICE_TTS_PLUGIN_UNAVAILABLE', 409);
      const turn = {conversationKey: key, writeVoice, ...(voiceId ? {voiceIds: [voiceId]} : {})};
      const args = feature === dialogueFeature ? {...(voiceId ? {id: voiceId} : {text}), voiceAllowed, textAllowed} : voiceId ? {id: voiceId} : {text};
      invocation = await runtime.invokeFeature(feature, args, turn, {timeoutMs: 35000});
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('VOICE_TTS_')) throw error;
      if (error.message === 'PLUGIN_TIMEOUT') throw fault('VOICE_TTS_TIMEOUT', 504);
      if (error.message === 'PLUGIN_FEATURE_CONFLICT') throw fault('VOICE_TTS_PLUGIN_CONFLICT', 409);
      if (error.message === 'PLUGIN_PERMISSION_DENIED') throw fault('VOICE_TTS_PERMISSION_CHANGED', 403);
      throw fault('VOICE_TTS_PLUGIN_UNAVAILABLE', 503);
    }
    if (!invocation.handled || invocation.plugin !== selected.id || invocation.generation !== selected.generation || !allowed()) {
      throw fault('VOICE_TTS_PERMISSION_CHANGED', 403);
    }
    if (invocation.result?.ok !== true) {
      const code = /^VOICE_(TTS|REALTIME)_[A-Z_]{1,40}$/.test(invocation.result?.code) ? invocation.result.code : 'VOICE_TTS_FAILED';
      throw fault(code, code.endsWith('_TIMEOUT') ? 504 : 502);
    }
    if (feature === dialogueFeature) {
      const {mode, text: reply} = invocation.result;
      if (!['voice', 'text'].includes(mode) || mode === 'voice' && !voiceAllowed || mode === 'text' && !textAllowed || typeof reply !== 'string' ||
          !reply.trim() || reply.length > maxReplyChars) throw fault('VOICE_REALTIME_CHOICE_INVALID', 502);
      if (mode === 'text') {
        if (size) throw fault('VOICE_REALTIME_CHOICE_INVALID', 502);
        return {mode, text: reply.trim(), allowed};
      }
      // Speaking failed after a valid decision; nothing was submitted.
      const audioError = invocation.result.audioError;
      if (audioError !== undefined) {
        if (size || !/^VOICE_REALTIME_[A-Z_]{1,40}$/.test(audioError)) throw fault('VOICE_REALTIME_CHOICE_INVALID', 502);
        return {mode, text: reply.trim(), audioError, allowed};
      }
      const wav = Buffer.concat(chunks, size);
      try { voicePcm(wav); } catch { throw fault('VOICE_REALTIME_AUDIO', 502); }
      return {mode, text: reply.trim(), wav, allowed};
    }
    const wav = Buffer.concat(chunks, size);
    try { voicePcm(wav); } catch { throw fault('VOICE_TTS_INVALID_AUDIO', 502); }
    return {wav, allowed};
  }

  async close() {
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }
}
