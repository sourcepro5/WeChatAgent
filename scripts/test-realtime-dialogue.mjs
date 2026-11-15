import test from 'node:test';
import assert from 'node:assert/strict';
import {dialogue, speak, transcribeRealtime, parseChoice, choiceInstructions, dialectInfo, transcriptSimilarity} from '../optional-extensions/speech-synthesis/lib/realtime.mjs';
import {pcmWav} from './decode-wechat-voice.mjs';
import {methodOf, servicesOf, activeOf} from '../optional-extensions/speech-synthesis/ui/providers.mjs';
import {endpointAdvice} from '../optional-extensions/speech-synthesis/ui/helpers.mjs';

const settings = (endpoint, extra = {}) => ({
  voiceMode: 'realtime', realtimeEndpoint: endpoint, apiKey: 'fixture-key', realtimeModel: 'fixture-model',
  voice: 'fixture-voice', timeoutMs: 5000, realtimeProtocol: 'auto', instructions: '', ...extra,
});
const openai = settings('wss://realtime.example.test/v1/realtime');
const stepfun = settings('wss://api.stepfun.com/v1/realtime');
const qwen = settings('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');
const glm = settings('wss://open.bigmodel.cn/api/paas/v4/realtime');
const wav = pcmWav(Buffer.alloc(3200));
const audio = bytes => Buffer.alloc(bytes, 1).toString('base64');

// A scripted provider: `reply(event, socket)` answers each client event.
function provider(reply) {
  const sent = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = String(url); this.options = options; this.listeners = {};
      FakeSocket.last = this;
      setImmediate(() => this.emit('open'));
    }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    emit(name, data) { for (const fn of this.listeners[name] ?? []) fn(data === undefined ? {} : {data: JSON.stringify(data)}); }
    send(raw) {
      const event = JSON.parse(raw);
      sent.push(event);
      setImmediate(() => reply(event, this, sent));
    }
    close() { this.closed = true; }
  }
  return {FakeSocket, sent};
}

// GA: text decision on the first response, audio on the second (per-response modalities).
function gaProvider({choice, audioDeltas = 2, audioStatus = 'completed', choiceStatus = 'completed', transcript} = {}) {
  let responses = 0;
  return provider((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') socket.emit('message', {type: 'input_audio_buffer.committed'});
    if (event.type !== 'response.create') return;
    const id = 'r' + ++responses;
    socket.emit('message', {type: 'response.created', response: {id}});
    if (event.response?.output_modalities?.[0] === 'text') {
      const raw = typeof choice === 'string' ? choice : JSON.stringify(choice);
      socket.emit('message', {type: 'response.output_text.delta', response_id: id, delta: raw.slice(0, 5)});
      socket.emit('message', {type: 'response.output_text.delta', response_id: id, delta: raw.slice(5)});
      socket.emit('message', {type: 'response.output_text.done', response_id: id, text: raw});
      socket.emit('message', {type: 'response.done', response: {id, status: choiceStatus}});
      return;
    }
    for (let index = 0; index < audioDeltas; index++) socket.emit('message', {type: 'response.output_audio.delta', response_id: id, delta: audio(2400)});
    socket.emit('message', {type: 'response.output_audio_transcript.done', response_id: id, transcript: transcript ?? choice.text});
    socket.emit('message', {type: 'response.done', response: {id, status: audioStatus}});
  });
}

test('GA: text input decides in text, then the chosen text is spoken out of band in the same session', async () => {
  const {FakeSocket, sent} = gaProvider({choice: {mode: 'voice', text: '好，我给你念一遍。'}});
  const reply = await dialogue(openai, {text: '用语音回答：你好吗？'}, {voiceAllowed: true, WebSocketImpl: FakeSocket});
  assert.equal(reply.mode, 'voice');
  assert.equal(reply.text, '好，我给你念一遍。');
  assert.equal(reply.verified, true);
  assert.equal(reply.pcm.length % 2, 0);
  assert(reply.durationMs > 0);
  assert.equal(FakeSocket.last.options.headers.Authorization, 'Bearer fixture-key');
  const types = sent.map(event => event.type);
  assert.deepEqual(types, ['session.update', 'conversation.item.create', 'response.create', 'response.create']);
  assert.deepEqual(sent[0].session.output_modalities, ['text']);
  assert.match(sent[0].session.instructions, /只输出一个 JSON 对象/);
  assert.equal(sent[1].item.content[0].type, 'input_text');
  assert.deepEqual(sent[2].response, {output_modalities: ['text']});
  assert.deepEqual(sent[3].response.output_modalities, ['audio']);
  assert.equal(sent[3].response.conversation, 'none');
  assert.match(sent[3].response.input[0].content[0].text, /好，我给你念一遍。/);
});

test('GA: voice input choosing text never requests audio', async () => {
  const {FakeSocket, sent} = gaProvider({choice: {mode: 'text', text: '命令是 ls -la'}});
  const reply = await dialogue(openai, {wav}, {voiceAllowed: true, WebSocketImpl: FakeSocket});
  assert.deepEqual([reply.mode, reply.text, reply.pcm], ['text', '命令是 ls -la', undefined]);
  assert.equal(sent.filter(event => event.type === 'response.create').length, 1);
  assert(sent.some(event => event.type === 'input_audio_buffer.append'));
});

test('DSH mode uses the input transcript from Qwen and never requests a reply', async () => {
  const {FakeSocket, sent} = provider((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') {
      socket.emit('message', {type: 'input_audio_buffer.committed', item_id: 'input'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', item_id: 'other', transcript: '另一段'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', item_id: 'input', transcript: '请用语音回我'});
    }
  });
  const text = await transcribeRealtime({...qwen, voiceMode: 'dsh-realtime', recognitionModel: 'fun-asr'}, wav, {WebSocketImpl: FakeSocket});
  assert.equal(text, '请用语音回我');
  assert.deepEqual(sent[0].session.input_audio_transcription, {model: 'fun-asr'});
  assert.equal(sent[0].session.turn_detection, null);
  assert.equal(sent.some(event => event.type === 'response.create'), false);
});

test('without voice this turn the prompt offers text only and a voice choice is sent as its text', async () => {
  const {FakeSocket, sent} = gaProvider({choice: {mode: 'voice', text: '好的'}});
  const reply = await dialogue(openai, {text: '你好'}, {voiceAllowed: false, WebSocketImpl: FakeSocket});
  assert.equal(reply.mode, 'text');
  assert.match(sent[0].session.instructions, /本轮只能回复文字/);
  assert.equal(sent.filter(event => event.type === 'response.create').length, 1);
  assert.match(choiceInstructions(true, false), /本轮只能回复语音/);
});

test('segmented audio is assembled; an interrupted or failed response is never treated as complete', async () => {
  const segmented = gaProvider({choice: {mode: 'voice', text: '分段音频测试'}, audioDeltas: 5});
  const reply = await dialogue(openai, {text: 'x'}, {WebSocketImpl: segmented.FakeSocket});
  assert.equal(reply.pcm.length, 5 * 2400 * 16000 / 24000);
  // A failed decision ends the turn.
  for (const [options, code] of [
    [{choice: {mode: 'text', text: '中断'}, choiceStatus: 'incomplete'}, 'VOICE_REALTIME_INCOMPLETE'],
    [{choice: 'not json'}, 'VOICE_REALTIME_CHOICE_INVALID'],
    [{choice: {mode: 'sing', text: 'x'}}, 'VOICE_REALTIME_CHOICE_INVALID'],
  ]) {
    const {FakeSocket} = gaProvider(options);
    await assert.rejects(dialogue(openai, {text: 'x'}, {WebSocketImpl: FakeSocket}), {message: code}, JSON.stringify(options));
  }
  // Failed speaking keeps the valid decision without audio, so the host can send its text once.
  for (const [options, code] of [
    [{choice: {mode: 'voice', text: '中断'}, audioStatus: 'incomplete'}, 'VOICE_REALTIME_AUDIO'],
    [{choice: {mode: 'voice', text: '中断'}, audioStatus: 'cancelled'}, 'VOICE_REALTIME_AUDIO'],
    [{choice: {mode: 'voice', text: '你好世界'}, transcript: '完全不同的一句话内容'}, 'VOICE_REALTIME_TRANSCRIPT_MISMATCH'],
  ]) {
    const {FakeSocket} = gaProvider(options);
    const failed = await dialogue(openai, {text: 'x'}, {WebSocketImpl: FakeSocket});
    assert.deepEqual([failed.mode, failed.text, failed.audioError, failed.pcm], ['voice', options.choice.text, code, undefined], JSON.stringify(options));
  }
});

test('a provider error, a closed socket or a timeout ends the turn without a reply', async () => {
  const failing = provider((event, socket) => { if (event.type === 'session.update') socket.emit('message', {type: 'error', error: {message: 'x'}}); });
  await assert.rejects(dialogue(openai, {text: 'x'}, {WebSocketImpl: failing.FakeSocket}), {message: 'VOICE_REALTIME_PROVIDER'});
  const closing = provider((event, socket) => { if (event.type === 'session.update') socket.emit('close'); });
  await assert.rejects(dialogue(openai, {text: 'x'}, {WebSocketImpl: closing.FakeSocket}), {message: 'VOICE_REALTIME_NETWORK'});
  const silent = provider(() => {});
  await assert.rejects(dialogue({...openai, timeoutMs: 1000}, {text: 'x'}, {WebSocketImpl: silent.FakeSocket}), {message: 'VOICE_REALTIME_TIMEOUT'});
});

// Beta dialects switch modalities with session.update (unverified with vendors).
function betaProvider({choice, transcript}) {
  let modalities;
  return provider((event, socket) => {
    if (event.type === 'session.update') { modalities = event.session.modalities; socket.emit('message', {type: 'session.updated'}); }
    if (event.type === 'input_audio_buffer.commit') socket.emit('message', {type: 'input_audio_buffer.committed'});
    if (event.type !== 'response.create') return;
    socket.emit('message', {type: 'response.created', response: {id: 'b'}});
    if (modalities.length === 1) {
      socket.emit('message', {type: 'response.text.delta', response_id: 'b', delta: JSON.stringify(choice)});
      socket.emit('message', {type: 'response.text.done', response_id: 'b', text: JSON.stringify(choice)});
    } else {
      socket.emit('message', {type: 'response.audio.delta', response_id: 'b', delta: audio(4800)});
      socket.emit('message', {type: 'response.audio_transcript.done', response_id: 'b', transcript: transcript ?? choice.text});
    }
    socket.emit('message', {type: 'response.done', response: {id: 'b', status: 'completed'}});
  });
}

test('beta dialects decide with a text-only session, then switch modalities and speak; marked unverified', async () => {
  const {FakeSocket, sent} = betaProvider({choice: {mode: 'voice', text: '阶跃语音'}});
  const reply = await dialogue(stepfun, {text: '你好'}, {WebSocketImpl: FakeSocket});
  assert.deepEqual([reply.mode, reply.verified], ['voice', false]);
  const updates = sent.filter(event => event.type === 'session.update');
  assert.deepEqual(updates.map(event => event.session.modalities), [['text'], ['text', 'audio']]);
  assert.match(updates[1].session.instructions, /逐字朗读/);
  assert.equal(sent.filter(event => event.type === 'conversation.item.create').length, 2);
  assert(sent.filter(event => event.type === 'response.create').every(event => event.response === undefined));
  const glmRun = betaProvider({choice: {mode: 'text', text: '智谱文字'}});
  assert.equal((await dialogue(glm, {text: '你好'}, {WebSocketImpl: glmRun.FakeSocket})).mode, 'text');
  assert.equal(glmRun.sent[0].session.beta_fields.chat_mode, 'audio');
});

// Qwen-Audio-Realtime as documented: the voice only in the first session.update,
// turn detection only before audio, invalid fields answered with an error event.
function qwenProvider({choice, voices = ['longanqian_v3.1']}) {
  let modalities, updates = 0, audioSent = false;
  const invalid = (socket, param) => socket.emit('message', {type: 'error', error: {type: 'invalid_request_error', code: 'invalid_value', message: 'free text', param}});
  return provider((event, socket) => {
    if (event.type === 'session.update') {
      const first = updates++ === 0, session = event.session;
      if (first && !voices.includes(session.voice)) return invalid(socket, 'session.voice');
      if (!first && 'voice' in session) return invalid(socket, 'session.voice');
      if (audioSent && 'turn_detection' in session) return invalid(socket, 'session.turn_detection');
      modalities = session.modalities;
      return socket.emit('message', {type: 'session.updated'});
    }
    if (event.type === 'input_audio_buffer.append') audioSent = true;
    if (event.type === 'input_audio_buffer.commit') socket.emit('message', {type: 'input_audio_buffer.committed'});
    if (event.type !== 'response.create') return;
    socket.emit('message', {type: 'response.created', response: {id: 'q'}});
    if (modalities.length === 1) {
      socket.emit('message', {type: 'response.text.delta', response_id: 'q', delta: JSON.stringify(choice)});
      socket.emit('message', {type: 'response.text.done', response_id: 'q', text: JSON.stringify(choice)});
    } else {
      socket.emit('message', {type: 'response.audio.delta', response_id: 'q', delta: audio(4800)});
      socket.emit('message', {type: 'response.audio_transcript.done', response_id: 'q', transcript: choice.text});
    }
    socket.emit('message', {type: 'response.done', response: {id: 'q', status: 'completed'}});
  });
}

test('Qwen accepts text and voice input; voice and turn detection are set only in the first update', async () => {
  const qwen31 = {...qwen, realtimeModel: 'qwen-audio-3.1-realtime-flash', voice: 'longanqian_v3.1'};
  assert.deepEqual(dialectInfo(qwen31), {dialect: 'qwen', textInput: true, verified: false});
  for (const input of [{text: '用语音回答：你好'}, {wav}]) {
    const {FakeSocket, sent} = qwenProvider({choice: {mode: 'voice', text: '千问语音'}});
    const reply = await dialogue(qwen31, input, {WebSocketImpl: FakeSocket});
    assert.deepEqual([reply.mode, reply.audioError], ['voice', undefined], JSON.stringify(input).slice(0, 20));
    assert(reply.pcm.length > 0);
    assert.equal(new URL(FakeSocket.last.url).searchParams.get('model'), 'qwen-audio-3.1-realtime-flash');
    const updates = sent.filter(event => event.type === 'session.update').map(event => event.session);
    assert.deepEqual(updates.map(session => [session.modalities, session.voice, 'turn_detection' in session]),
      [[['text'], 'longanqian_v3.1', true], [['text', 'audio'], undefined, false]]);
    const texts = sent.filter(event => event.type === 'conversation.item.create').map(event => event.item.content[0].text);
    assert.equal(texts.length, input.text ? 2 : 1);
    if (input.text) assert.equal(texts[0], '用语音回答：你好');
  }
  // speak() opens its own session, so its single update carries the voice.
  const spoken = qwenProvider({choice: {mode: 'voice', text: '朗读这段话'}});
  assert((await speak(qwen31, '朗读这段话', {WebSocketImpl: spoken.FakeSocket})).pcm.length > 0);
  assert.equal(spoken.sent.find(event => event.type === 'session.update').session.voice, 'longanqian_v3.1');
});

test('a provider error keeps its sanitized code and parameter, never its message', async () => {
  const wrongVoice = {...qwen, realtimeModel: 'qwen-audio-3.1-realtime-flash', voice: 'longanqian'};
  const {FakeSocket} = qwenProvider({choice: {mode: 'text', text: '不会到这里'}});
  await assert.rejects(dialogue(wrongVoice, {text: '你好'}, {WebSocketImpl: FakeSocket}), error =>
    error.message === 'VOICE_REALTIME_PROVIDER' && error.providerCode === 'invalid_value' && error.providerParam === 'session.voice' && !String(Object.values(error)).includes('free text'));
});

test('the Qwen preset pairs 3.1 models with 3.1 voices; saved Qwen addresses, models and voices are kept as configured', () => {
  const qwenPreset = methodOf('qwen', 'tts', 'realtime');
  assert.equal(qwenPreset.defaults.endpoint, 'https://maas.qianwenaiapi.com/api-ws/v1/realtime');
  assert.equal(qwenPreset.defaults.voice, 'longanqian_v3.1');
  assert(qwenPreset.models.every(model => model.startsWith('qwen-audio-3.1-realtime-')));
  assert(qwenPreset.voices.every(voice => voice.id.endsWith('_v3.1')));
  // A business-space address with a 3.0 model and its own voice stays as typed.
  const workspace = {voiceMode: 'realtime', endpoint: 'wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime', realtimeModel: 'qwen-audio-3.0-realtime-flash', voice: 'longanlufeng'};
  const tts = activeOf(servicesOf(workspace), 'tts');
  assert.deepEqual([tts.entry, tts.method], ['qwen', 'realtime']);
  assert.deepEqual([tts.profile.endpoint, tts.profile.model, tts.profile.voice], [workspace.endpoint, workspace.realtimeModel, workspace.voice]);
  assert.equal(endpointAdvice(workspace.endpoint, {providerId: 'qwen', websocket: true, expected: qwenPreset.defaults.endpoint}).state, 'ok');
  assert.equal(endpointAdvice('wss://attacker.example/api-ws/v1/realtime', {providerId: 'qwen', websocket: true}).state, 'error');
});

test('speak renders a given text with the dialogue voice in one response', async () => {
  const {FakeSocket, sent} = gaProvider({choice: {mode: 'voice', text: '朗读这段话'}});
  const result = await speak(openai, '朗读这段话', {WebSocketImpl: FakeSocket});
  assert(result.pcm.length > 0);
  assert.deepEqual(sent.map(event => event.type), ['response.create']);
});

test('choice validation keeps only the documented shape and the available forms', () => {
  assert.equal(parseChoice('{"mode":"voice","text":"' + '长'.repeat(401) + '"}', true).mode, 'text');
  assert.throws(() => parseChoice('{"mode":"text","text":"' + 'x'.repeat(601) + '"}', true), {message: 'VOICE_REALTIME_CHOICE_INVALID'});
  assert.throws(() => parseChoice('{"mode":"text","text":"SILENT"}', true), {message: 'VOICE_REALTIME_CHOICE_INVALID'});
  assert.throws(() => parseChoice('{"mode":"text","text":"a\\u0000b"}', true), {message: 'VOICE_REALTIME_CHOICE_INVALID'});
  assert.equal(parseChoice('{"mode":"text","text":"好"}', true, false).mode, 'voice');
  assert(transcriptSimilarity('你好，这是测试。', '你好这是测试') === 1);
});
