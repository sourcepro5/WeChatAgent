import fs from 'node:fs';
import {failureMessages} from './lib/service.mjs';
import {dialogue, dialectInfo} from './lib/realtime.mjs';
import {waveFile} from './lib/wav.mjs';
import {cloneVoice, maxCloneBase64, queryVoice} from './lib/voice-clone.mjs';
import {mergeDraft, resolveService} from './lib/resolve.mjs';
import {dialogueSettings, listFor, ready, synthesizeText, transcribeVoice} from './lib/engine.mjs';
import {CAPABILITY_IDS, activeOf, credentialOf, hostSettings, servicesOf} from './ui/providers.mjs';
import {googleAccount, tencentCredential} from './lib/cloud.mjs';

const {configSchema} = JSON.parse(fs.readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const draftSchema = {type: 'object', properties: configSchema, additionalProperties: false};
const withSettings = (extra = {}, required = []) => ({type: 'object', properties: {settings: draftSchema, ...extra},
  required: ['settings', ...required], additionalProperties: false});
const settingsParameters = withSettings();
const chunkBytes = 256 * 1024;
// Settings-page preview only: 8 kHz 8-bit keeps about 5 seconds within the
// 64 KiB action result limit. Real voice output still uses 16 kHz 16-bit.
const previewSeconds = 5;
const voiceParameters = {type: 'object', properties: {id: {type: 'string', minLength: 64, maxLength: 64}},
  required: ['id'], additionalProperties: false};
// One incoming WeChat message (voice reference or text) for a Realtime turn.
const dialogueParameters = {type: 'object', properties: {
  id: {type: 'string', minLength: 64, maxLength: 64}, text: {type: 'string', minLength: 1, maxLength: 4096},
  voiceAllowed: {type: 'boolean'}, textAllowed: {type: 'boolean'},
}, required: ['voiceAllowed'], additionalProperties: false};
// Built-in text sample for the settings page; asks for a voice answer on purpose.
const testRequest = '请用语音简单回答：你好吗？';
const testSentence = '你好，这是一段语音测试。';
function previewWave(pcm, sourceRate) {
  const step = sourceRate / 8000, frames = Math.min(Math.floor(pcm.length / 2 / step), 8000 * previewSeconds);
  const data = Buffer.alloc(frames);
  for (let i = 0; i < frames; i++) data[i] = (pcm.readInt16LE(Math.floor(i * step) * 2) >> 8) + 128;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(frames + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(frames, 40);
  return {wav: Buffer.concat([header, data]), clipped: frames < Math.floor(pcm.length / 2 / step)};
}
const testAudio = () => fs.readFileSync(new URL('./assets/sample.wav', import.meta.url));

// A settings-page draft over the saved settings; blank secrets keep the saved ones.
const merged = (ctx, draft) => mergeDraft(ctx.settings, draft);

function failure(error) {
  const code = Object.hasOwn(failureMessages, error.message) ? error.message : 'VOICE_TTS_FAILED';
  // A provider's own error code and parameter name, already sanitized.
  const provider = {...(error.providerCode ? {providerCode: error.providerCode} : {}), ...(error.providerParam ? {providerParam: error.providerParam} : {})};
  const detail = [provider.providerCode && '错误码 ' + provider.providerCode, provider.providerParam && '参数 ' + provider.providerParam].filter(Boolean).join('，');
  return {ok: false, code, message: (failureMessages[code] ?? '语音合成未完成。') + (detail ? '（平台返回：' + detail + '）' : ''), ...provider};
}

async function writeVoice(ctx, pcm) {
  const wav = waveFile(pcm);
  for (let offset = 0; offset < wav.length; offset += chunkBytes) {
    await ctx.audio.write(wav.subarray(offset, offset + chunkBytes).toString('base64'));
  }
  return {ok: true};
}

async function readVoice(ctx, id) {
  return Buffer.from((await ctx.audio.read(id, {format: 'wav'})).b64, 'base64');
}

// Credentials never appear in what a settings action returns.
const hidden = (text, keys) => keys.filter(Boolean).reduce((value, key) => value.replaceAll(key, '[已隐藏]'), text);
const keysOf = settings => ['apiKey', 'ttsKey', 'realtimeAsrKey', 'fileAsrKey'].map(field => String(settings[field] ?? '').trim()).filter(key => key.length >= 6);

// Everything the host needs to enable the plugin: each configured capability
// resolves with a credential, the chosen recognition method is configured,
// and the host-facing values match the services.
function validate(value) {
  const services = servicesOf(value);
  const configured = CAPABILITY_IDS.filter(capability => activeOf(services, capability).entry);
  if (!configured.length) throw new Error('VOICE_TTS_NOT_CONFIGURED');
  for (const capability of configured) {
    const service = ready(value, capability);
    if (service.entry === 'tencent') tencentCredential(service.key);
    if (service.entry === 'google') googleAccount(service.key);
  }
  if (services.recognition !== 'off' && !configured.includes(services.recognition === 'realtime' ? 'realtimeAsr' : 'fileAsr')) {
    throw new Error('VOICE_RECOGNITION_NOT_CONFIGURED');
  }
  if (services.reply === 'direct') dialogueSettings(value);
  if (value.services?.version === 2) {
    const host = hostSettings(services);
    if (value.voiceMode !== host.voiceMode || value.recognitionModel !== host.recognitionModel) throw new Error('VOICE_TTS_CONFIG');
  }
}

export function setup(api) {
  const cloneSettings = draftSchema;
  api.registerAction({
    id: 'clone-voice', description: '将选中的录音提交给当前语音合成服务，创建绑定其模型的音色。',
    parameters: {
      type: 'object', required: ['settings', 'prefix', 'format', 'base64'], additionalProperties: false,
      properties: {
        settings: cloneSettings,
        prefix: {type: 'string', minLength: 1, maxLength: 10},
        format: {type: 'string', enum: ['wav', 'mp3', 'm4a']},
        base64: {type: 'string', minLength: 16, maxLength: maxCloneBase64},
      },
    },
    async execute(ctx, {settings, ...recording}) {
      if (ctx.mode !== 'settings') throw Error('PLUGIN_ACTION_UNAVAILABLE');
      try { return {ok: true, ...await cloneVoice(resolveService(merged(ctx, settings), 'tts'), recording, {signal: ctx.signal})}; }
      catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'query-voice', description: '查询复刻音色的审核状态并核对绑定模型。',
    parameters: {
      type: 'object', required: ['settings', 'voiceId'], additionalProperties: false,
      properties: {settings: cloneSettings, voiceId: {type: 'string', minLength: 1, maxLength: 200}},
    },
    async execute(ctx, {settings, voiceId}) {
      if (ctx.mode !== 'settings') throw Error('PLUGIN_ACTION_UNAVAILABLE');
      try { return {ok: true, ...await queryVoice(resolveService(merged(ctx, settings), 'tts'), voiceId, {signal: ctx.signal})}; }
      catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'transcribe', description: '用当前选用的识别方式转写已授权聊天收到的微信语音。', parameters: voiceParameters,
    async execute(ctx, {id}) {
      try { return {ok: true, text: await transcribeVoice(ctx.settings, await readVoice(ctx, id), {signal: ctx.signal})}; }
      catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'converse', description: '把当前微信语音或文字交给 Realtime 模型，由模型决定回复文字还是语音。', parameters: dialogueParameters,
    async execute(ctx, {id, text, voiceAllowed, textAllowed = true}) {
      try {
        if ((id === undefined) === (text === undefined)) return failure(new Error('VOICE_REALTIME_INPUT_INVALID'));
        const input = id !== undefined ? {wav: await readVoice(ctx, id)} : {text};
        const reply = await dialogue(dialogueSettings(ctx.settings), input, {voiceAllowed, textAllowed, signal: ctx.signal});
        if (reply.mode === 'voice' && reply.audioError) return {ok: true, mode: 'voice', text: reply.text, audioError: reply.audioError};
        if (reply.mode === 'voice') await writeVoice(ctx, reply.pcm);
        return {ok: true, mode: reply.mode, text: reply.text, ...(reply.durationMs ? {durationMs: reply.durationMs} : {})};
      } catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'synthesize', description: '用选定的语音合成服务朗读 DSH 已生成的回复正文。',
    parameters: {type: 'object', properties: {text: {type: 'string', minLength: 1, maxLength: 4096}}, required: ['text'], additionalProperties: false},
    async execute(ctx, {text}) {
      try { return await writeVoice(ctx, (await synthesizeText(ctx.settings, text, {signal: ctx.signal})).pcm); }
      catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'models', description: '读取所选能力服务的模型和音色列表。',
    parameters: withSettings({capability: {type: 'string', enum: [...CAPABILITY_IDS]}}, ['capability']),
    async execute(ctx, {settings, capability}) {
      try { return {ok: true, ...await listFor(merged(ctx, settings), capability, {signal: ctx.signal})}; }
      catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'check-input', description: '用内置语音测试实时识别或单条识别，并返回中间结果。',
    parameters: withSettings({method: {type: 'string', enum: ['realtime', 'file']}}, ['method']),
    async execute(ctx, {settings, method}) {
      try {
        const value = merged(ctx, settings), partials = [];
        const onPartial = text => { if (text && text !== partials.at(-1)) partials.push(text); };
        const text = await transcribeVoice(value, testAudio(), {method, signal: ctx.signal, onPartial});
        const keys = keysOf(value);
        return {ok: true, method, text: hidden(text, keys), partials: partials.slice(-30).map(partial => hidden(partial, keys).slice(0, 400))};
      } catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'check', description: '用内置短句测试语音合成并提供试听。', parameters: settingsParameters,
    async execute(ctx, {settings}) {
      try {
        const value = merged(ctx, settings);
        if (servicesOf(value).reply === 'direct') {
          // Shows the form the model chose for the built-in sample; nothing is sent to WeChat.
          const realtime = dialogueSettings(value), {verified, textInput} = dialectInfo(realtime);
          const input = textInput ? {text: testRequest} : {wav: testAudio()};
          const reply = await dialogue(realtime, input, {voiceAllowed: true, signal: ctx.signal});
          if (reply.audioError) return failure(new Error(reply.audioError));
          const result = {ok: true, mode: reply.mode, text: reply.text, verified, sample: textInput ? 'text' : 'voice'};
          if (reply.mode !== 'voice') return result;
          const {wav, clipped} = previewWave(reply.pcm, 16000);
          return {...result, durationMs: reply.durationMs, clipped, preview: wav.toString('base64')};
        }
        const {pcm, durationMs} = await synthesizeText(value, testSentence, {signal: ctx.signal});
        const {wav, clipped} = previewWave(pcm, 16000);
        return {ok: true, durationMs, clipped, preview: wav.toString('base64')};
      } catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'credentials', description: '说明每项能力会使用哪份已保存的凭据（不返回凭据内容）。', parameters: settingsParameters,
    execute(ctx, {settings}) {
      try {
        const value = merged(ctx, settings), services = servicesOf(value);
        return {ok: true, sources: Object.fromEntries(CAPABILITY_IDS.map(capability =>
          [capability, activeOf(services, capability).entry ? credentialOf(value, capability, services).from || 'none' : '']))};
      } catch (error) { return failure(error); }
    },
  });
  api.registerAction({
    id: 'validate', description: '检查启用所需的设置。', parameters: settingsParameters,
    execute(ctx, {settings}) {
      try { validate(merged(ctx, settings)); return {ok: true}; }
      catch (error) { return failure(error); }
    },
  });
}
