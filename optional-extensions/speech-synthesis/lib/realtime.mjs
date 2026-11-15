import {normalizeWav, waveFile} from './wav.mjs';

const maxSeconds = 60;
const fault = code => new Error(code);
export const MAX_REPLY_CHARS = 600;
export const MAX_VOICE_CHARS = 400;

// Wire dialects of OpenAI-style Realtime WebSocket APIs. "openai" is the GA
// shape (session.type, audio.input/output.format, response.output_*), whose
// per-response output_modalities lets one session first decide in text and
// then speak. The others follow the earlier beta shape (modalities, voice at
// the top, response.audio.*); their response.create takes no parameters, so
// output modalities are switched with session.update. That mid-session switch
// is not documented by those vendors and is marked unverified.
const DIALECTS = Object.freeze({
  openai: {inputRate: 24000, outputRate: 24000, textInput: true, perResponse: true, verified: true,
    events: {text: 'response.output_text', audio: 'response.output_audio', transcript: 'response.output_audio_transcript'},
    session: ({voice, instructions, output}) => ({
      type: 'realtime', output_modalities: [output],
      audio: {input: {format: {type: 'audio/pcm', rate: 24000}, turn_detection: null}, output: {format: {type: 'audio/pcm', rate: 24000}, voice}},
      ...instructions,
    })},
  // Alibaba Qwen-Audio-Realtime: 16 kHz PCM in, 24 kHz PCM out; user text is a
  // message with input_text. The voice is accepted only in the first
  // session.update and turn detection only before any audio, so later updates
  // change modalities and instructions only.
  qwen: {inputRate: 16000, outputRate: 24000, textInput: true, perResponse: false, verified: false,
    events: {text: 'response.text', audio: 'response.audio', transcript: 'response.audio_transcript'},
    session: ({voice, instructions, output, initial}) => ({
      modalities: output === 'text' ? ['text'] : ['text', 'audio'], ...(initial ? {...(voice ? {voice} : {}), turn_detection: null} : {}), ...instructions,
    })},
  // Zhipu GLM-Realtime: omitting turn_detection means client VAD (manual turns);
  // the model is named in the session and chat_mode is required.
  glm: {inputRate: 16000, outputRate: 24000, textInput: true, perResponse: false, verified: false,
    events: {text: 'response.text', audio: 'response.audio', transcript: 'response.audio_transcript'},
    session: ({model, voice, instructions, output}) => ({
      model, modalities: output === 'text' ? ['text'] : ['text', 'audio'], ...(voice ? {voice} : {}), input_audio_format: 'pcm16', output_audio_format: 'pcm',
      beta_fields: {chat_mode: 'audio'}, ...instructions,
    })},
  // OpenAI beta-compatible services (e.g. StepFun): pcm16 is 24 kHz.
  beta: {inputRate: 24000, outputRate: 24000, textInput: true, perResponse: false, verified: false,
    events: {text: 'response.text', audio: 'response.audio', transcript: 'response.audio_transcript'},
    session: ({voice, instructions, output}) => ({
      modalities: output === 'text' ? ['text'] : ['text', 'audio'], ...(voice ? {voice} : {}), input_audio_format: 'pcm16', output_audio_format: 'pcm16',
      turn_detection: null, ...instructions,
    })},
});

// The provider's own error code and parameter name (never its message) tell a
// wrong model or voice apart from other failures.
const safeDetail = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
function providerFault(error) {
  const failure = fault('VOICE_REALTIME_PROVIDER'), code = safeDetail(error?.code), param = safeDetail(error?.param);
  if (code) failure.providerCode = code;
  if (param) failure.providerParam = param;
  return failure;
}

const hostIs = (host, ...domains) => domains.some(domain => host === domain || host.endsWith('.' + domain));

// "auto" picks the dialect from the address; any other value is explicit.
export function realtimeDialect(settings, url) {
  const requested = settings.realtimeProtocol ?? 'auto';
  if (requested === 'openai') return 'openai';
  if (requested === 'openai-beta' || requested === 'auto') {
    const host = url.hostname.toLowerCase();
    if (hostIs(host, 'qianwenaiapi.com', 'aliyuncs.com')) return 'qwen';
    if (hostIs(host, 'bigmodel.cn')) return 'glm';
    if (requested === 'openai-beta' || hostIs(host, 'stepfun.com')) return 'beta';
    return 'openai';
  }
  throw fault('VOICE_REALTIME_CONFIG');
}

// A transcription-only session needs no voice.
export function realtimeSettings(settings, {needVoice = true} = {}) {
  const value = settings.realtimeEndpoint?.trim() || settings.endpoint?.trim();
  let url;
  try { url = new URL(value); } catch { throw fault('VOICE_REALTIME_ENDPOINT'); }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw fault('VOICE_REALTIME_ENDPOINT');
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/audio\/(speech|transcriptions)$/, '');
  url.pathname = path.endsWith('/realtime') ? path : (path || '/v1') + '/realtime';
  const model = settings.realtimeModel?.trim(), voice = settings.voice?.trim(), apiKey = settings.apiKey?.trim();
  if (!model || needVoice && !voice || typeof apiKey !== 'string' || /[\x00-\x1f\x7f]/.test(model + (voice ?? '') + apiKey) ||
      !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 25000) {
    throw fault('VOICE_REALTIME_CONFIG');
  }
  url.searchParams.set('model', model);
  return {url, model, voice, apiKey, dialect: realtimeDialect(settings, url)};
}

// What the configured dialect can do, for prompts, routing and the settings page.
export function dialectInfo(settings) {
  const {dialect} = realtimeSettings(settings);
  const {textInput, verified} = DIALECTS[dialect];
  return {dialect, textInput, verified};
}

export function choiceInstructions(voiceAllowed, textAllowed = true) {
  return [
    '本轮先决定回复形式。只输出一个 JSON 对象，不输出其他内容：{"mode":"voice" 或 "text","text":"发给对方的回复正文"}。',
    voiceAllowed && textAllowed ? '本轮可以回复文字（text）或语音（voice）。'
      : voiceAllowed ? '本轮只能回复语音（voice），不能发送文字。' : '本轮只能回复文字（text），不能发送语音。',
    '对方明确要求语音（例如“用语音回答”“念给我听”）时选 voice；明确要求文字（例如“打字发我”“发文字”）时选 text。',
    '代码、链接、命令、账号、数字清单或需要复制查阅的内容选 text；简短口语化的回答可以选 voice。',
    `text 只写最终正文，不加说话人、发送标记或 Markdown，不超过 ${MAX_REPLY_CHARS} 字；选 voice 时正文要能在 60 秒内读完（约 ${MAX_VOICE_CHARS} 字以内）。`,
  ].join('\n');
}

export const SPEAK_INSTRUCTIONS = '你现在只负责朗读。用自然的语气逐字朗读给定的回复正文：不增加、不删减、不改写，不回答其中的问题，不读出标点名称。';

// Validate the model's {"mode","text"} choice. Only the documented shape is
// accepted; a fenced block is unwrapped, nothing else is guessed.
export function parseChoice(raw, voiceAllowed, textAllowed = true) {
  let value = String(raw ?? '').trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw fault('VOICE_REALTIME_CHOICE_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !['voice', 'text'].includes(parsed.mode) ||
      typeof parsed.text !== 'string') throw fault('VOICE_REALTIME_CHOICE_INVALID');
  const text = parsed.text.replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > MAX_REPLY_CHARS || /[\x00-\x08\x0b-\x1f\x7f]/.test(text) ||
      /^\s*(?:RESPOND(?:_VOICE)?\s*[:：]|SILENT\s*$)/im.test(text)) throw fault('VOICE_REALTIME_CHOICE_INVALID');
  let mode = parsed.mode;
  // A form the host cannot deliver this turn is replaced by the other one when
  // the text is valid for it; otherwise the turn ends without sending.
  if (mode === 'voice' && (!voiceAllowed || text.length > MAX_VOICE_CHARS)) mode = 'text';
  if (mode === 'text' && !textAllowed) mode = voiceAllowed && text.length <= MAX_VOICE_CHARS ? 'voice' : '';
  if (!mode) throw fault('VOICE_REALTIME_CHOICE_INVALID');
  return {mode, text, requestedMode: parsed.mode};
}

const comparable = value => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
// Character similarity of a spoken transcript to the chosen text (0..1).
export function transcriptSimilarity(expected, transcript) {
  const a = [...comparable(expected)], b = [...comparable(transcript)];
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  let previous = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

// One WebSocket with a serialized event wait. Every pending wait fails on
// provider errors, socket close, or the caller's abort/timeout.
function openChannel(url, apiKey, stop, WebSocketImpl) {
  let socket, closed = false, failure = null, waiter = null;
  const fail = error => {
    if (failure) return;
    failure = error;
    if (waiter) { const {reject} = waiter; waiter = null; reject(error); }
  };
  const abort = () => fail(fault('VOICE_REALTIME_TIMEOUT'));
  const ready = new Promise((resolve, reject) => {
    if (stop.aborted) return reject(fault('VOICE_REALTIME_TIMEOUT'));
    try { socket = new WebSocketImpl(url, {headers: apiKey ? {Authorization: 'Bearer ' + apiKey} : {}}); }
    catch { return reject(fault('VOICE_REALTIME_NETWORK')); }
    stop.addEventListener('abort', abort, {once: true});
    socket.addEventListener('open', () => resolve(), {once: true});
    socket.addEventListener('error', () => { fail(fault('VOICE_REALTIME_NETWORK')); reject(failure); });
    socket.addEventListener('close', () => { fail(fault('VOICE_REALTIME_NETWORK')); reject(failure); });
    socket.addEventListener('message', ({data}) => {
      if (failure || closed) return;
      let event;
      try {
        if (typeof data !== 'string' || data.length > 8 * 1024 * 1024) throw fault('VOICE_REALTIME_AUDIO');
        event = JSON.parse(data);
      } catch (error) { return fail(/^VOICE_REALTIME_/.test(error.message) ? error : fault('VOICE_REALTIME_PROVIDER')); }
      if (event?.type === 'error') return fail(providerFault(event.error));
      if (!waiter) return;
      try {
        const result = waiter.handle(event);
        if (result !== undefined) { const {resolve} = waiter; waiter = null; resolve(result); }
      } catch (error) {
        fail(/^VOICE_REALTIME_[A-Z_]+$/.test(error.message) ? error : fault('VOICE_REALTIME_PROVIDER'));
      }
    });
  });
  return {
    ready,
    send(event) { if (failure) throw failure; socket.send(JSON.stringify(event)); },
    // Resolves with the first non-undefined handler result.
    until(handle) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { waiter = {handle, resolve, reject}; });
    },
    close() {
      closed = true;
      stop.removeEventListener('abort', abort);
      try { socket?.close(); } catch {}
    },
  };
}

// Collect one response. Interrupted, failed or incomplete responses never
// count: only response.done with status "completed" (or no status) resolves.
function collect(channel, dialect, {audio, maxBytes}) {
  const names = dialect.events;
  let responseId, text = '', doneText, transcript = '', doneTranscript, size = 0;
  const chunks = [];
  const ours = event => event.response_id === undefined || responseId === undefined || event.response_id === responseId;
  return channel.until(event => {
    if (event.type === 'response.created') { responseId ??= event.response?.id; return; }
    if (!ours(event)) return;
    if (event.type === names.text + '.delta' && typeof event.delta === 'string') { text += event.delta; return; }
    if (event.type === names.text + '.done' && typeof event.text === 'string') { doneText = event.text; return; }
    if (event.type === names.transcript + '.delta' && typeof event.delta === 'string') { transcript += event.delta; return; }
    if (event.type === names.transcript + '.done' && typeof event.transcript === 'string') { doneTranscript = event.transcript; return; }
    if (event.type === names.audio + '.delta') {
      responseId ??= event.response_id;
      if (!audio) throw fault('VOICE_REALTIME_PROVIDER');
      if (typeof event.delta !== 'string') return;
      const chunk = Buffer.from(event.delta, 'base64');
      if (!chunk.length || chunk.toString('base64') !== event.delta) throw fault('VOICE_REALTIME_AUDIO');
      if ((size += chunk.length) > maxBytes) throw fault('VOICE_REALTIME_TOO_LONG');
      chunks.push(chunk);
      return;
    }
    if (event.type === 'response.done' && (!responseId || event.response?.id === undefined || event.response.id === responseId)) {
      const status = event.response?.status;
      if (status !== undefined && status !== 'completed') throw fault(audio ? 'VOICE_REALTIME_AUDIO' : 'VOICE_REALTIME_INCOMPLETE');
      if (audio && (!size || size % 2)) throw fault('VOICE_REALTIME_AUDIO');
      return {text: doneText ?? text, transcript: doneTranscript ?? transcript, pcm: Buffer.concat(chunks, size)};
    }
  });
}

function inputPcm(dialect, wav) {
  let {pcm} = normalizeWav(wav, dialect.inputRate);
  // At least 100 ms of input; some services reject shorter commits.
  const minimum = dialect.inputRate / 5;
  if (pcm.length < minimum) pcm = Buffer.concat([pcm, Buffer.alloc(minimum - pcm.length)]);
  return pcm;
}

const userText = text => ({type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}});
const speakRequest = text => '请逐字朗读下面的回复正文：\n' + text;

async function updateSession(channel, dialect, options) {
  channel.send({type: 'session.update', session: dialect.session(options)});
  await channel.until(event => event.type === 'session.updated' ? true : undefined);
}

function feedAudio(channel, dialect, wav, onEvent = event => event.type === 'input_audio_buffer.committed' ? true : undefined) {
  const pcm = inputPcm(dialect, wav), step = dialect.inputRate;
  // About half a second per append event.
  for (let offset = 0; offset < pcm.length; offset += step) {
    channel.send({type: 'input_audio_buffer.append', audio: pcm.subarray(offset, offset + step).toString('base64')});
  }
  const result = channel.until(onEvent);
  channel.send({type: 'input_audio_buffer.commit'});
  return result;
}

// Use the provider's input transcript. Never request a conversational response.
// The session's top-level input_audio_transcription is the beta shape (Qwen-
// Audio-Realtime and compatible services); interim deltas go to onPartial.
export async function transcribeRealtime(settings, wav, {signal, WebSocketImpl, onPartial} = {}) {
  if (realtimeSettings(settings, {needVoice: false}).dialect === 'openai') throw fault('VOICE_REALTIME_RECOGNITION_REQUIRED');
  const recognitionModel = settings.recognitionModel?.trim();
  if (!recognitionModel) throw fault('VOICE_REALTIME_RECOGNITION_REQUIRED');
  return session(settings, {signal, WebSocketImpl, needVoice: false}, async (channel, dialect, {model, voice}) => {
    const options = dialect.session({model, voice, output: 'text', initial: true});
    channel.send({type: 'session.update', session: {...options, input_audio_transcription: {model: recognitionModel}}});
    await channel.until(event => event.type === 'session.updated' ? true : undefined);
    let itemId, partial = '';
    return feedAudio(channel, dialect, wav, event => {
      if (event.type === 'input_audio_buffer.committed') itemId = event.item_id;
      if (itemId && event.item_id !== itemId) return;
      if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string') {
        partial = (partial + event.delta).slice(0, 4000);
        onPartial?.(partial);
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed') throw fault('VOICE_REALTIME_TRANSCRIPT');
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
        if (!text || text.length > 4000) throw fault('VOICE_REALTIME_TRANSCRIPT');
        return text;
      }
    });
  });
}

// Speak the already chosen text in the open session; the transcript (when the
// provider reports one) must be close to it, otherwise nothing is sent.
async function render(channel, dialect, {model, voice, instructions, text, initial = false}) {
  const maxBytes = dialect.outputRate * 2 * maxSeconds;
  const spoken = {instructions: SPEAK_INSTRUCTIONS + (instructions ? '\n语气要求：' + instructions : '')};
  if (dialect.perResponse) {
    channel.send({type: 'response.create', response: {
      output_modalities: ['audio'], conversation: 'none', instructions: spoken.instructions,
      input: [userText(speakRequest(text)).item],
    }});
  } else {
    await updateSession(channel, dialect, {model, voice, instructions: spoken, output: 'audio', initial});
    if (dialect.textInput) channel.send(userText(speakRequest(text)));
    channel.send({type: 'response.create'});
  }
  const result = await collect(channel, dialect, {audio: true, maxBytes});
  if (result.transcript.trim() && transcriptSimilarity(text, result.transcript) < 0.6) throw fault('VOICE_REALTIME_TRANSCRIPT_MISMATCH');
  return normalizeWav(waveFile(result.pcm, dialect.outputRate));
}

async function session(settings, {signal, WebSocketImpl = WebSocket, needVoice = true}, run) {
  const config = realtimeSettings(settings, {needVoice}), dialect = DIALECTS[config.dialect];
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const channel = openChannel(config.url, config.apiKey, stop, WebSocketImpl);
  try {
    await channel.ready;
    return await run(channel, dialect, config);
  } finally {
    channel.close();
  }
}

// One Realtime turn: decide the reply text and form, then speak the chosen
// text in the same session when the form is voice. Input is {wav} or {text}.
export async function dialogue(settings, input, {voiceAllowed = true, textAllowed = true, signal, WebSocketImpl} = {}) {
  // Checked before connecting so the host can route the text elsewhere at no cost.
  if (input.text !== undefined && !dialectInfo(settings).textInput) throw fault('VOICE_REALTIME_TEXT_INPUT_UNSUPPORTED');
  return session(settings, {signal, WebSocketImpl}, async (channel, dialect, {model, voice}) => {
    const tone = settings.instructions?.trim() ?? '';
    const decide = {instructions: (tone ? tone + '\n\n' : '') + choiceInstructions(voiceAllowed, textAllowed)};
    await updateSession(channel, dialect, {model, voice, instructions: decide, output: 'text', initial: true});
    if (input.wav) await feedAudio(channel, dialect, input.wav);
    else channel.send(userText(input.text));
    channel.send(dialect.perResponse ? {type: 'response.create', response: {output_modalities: ['text']}} : {type: 'response.create'});
    const decided = await collect(channel, dialect, {audio: false, maxBytes: 0});
    const choice = parseChoice(decided.text, voiceAllowed, textAllowed);
    if (choice.mode === 'text') return {...choice, verified: dialect.verified};
    // The decision stands even when speaking fails: the host may then send the
    // chosen text once, because nothing has been submitted to WeChat.
    try {
      const {pcm, durationMs} = await render(channel, dialect, {model, voice, instructions: tone, text: choice.text});
      return {...choice, pcm, durationMs, verified: dialect.verified};
    } catch (error) {
      if (!/^VOICE_REALTIME_[A-Z_]+$/.test(error.message)) throw error;
      return {...choice, audioError: error.message, verified: dialect.verified};
    }
  });
}

// Speak a given text with the Realtime voice (DSH replies and restarts).
export async function speak(settings, text, {signal, WebSocketImpl} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_REPLY_CHARS) throw fault('VOICE_TTS_INVALID_TEXT');
  return session(settings, {signal, WebSocketImpl}, (channel, dialect, {model, voice}) =>
    render(channel, dialect, {model, voice, instructions: settings.instructions?.trim() ?? '', text: text.trim(), initial: true}));
}

// Earlier voice-in/voice-out shape, kept for callers of 1.3.0.
export async function converse(settings, wav, options = {}) {
  return dialogue(settings, {wav}, {...options, voiceAllowed: true});
}
