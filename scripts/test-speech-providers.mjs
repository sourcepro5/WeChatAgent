import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {servicesOf, migrateServices, normalizeServices, hostSettings, credentialOf, activeOf, PROVIDERS, CUSTOM, CAPABILITY_IDS, providersFor}
  from '../optional-extensions/speech-synthesis/ui/providers.mjs';
import {resolveService, mergeDraft} from '../optional-extensions/speech-synthesis/lib/resolve.mjs';
import {synthesizeText, transcribeVoice, listFor} from '../optional-extensions/speech-synthesis/lib/engine.mjs';
import {tc3Authorization, splitText, tencentSpeed, resetCloudTokens} from '../optional-extensions/speech-synthesis/lib/cloud.mjs';
import {tencentAsrUrl, tencentTranscribe, TENCENT_FRAME_MS, TENCENT_INTERVAL_MS} from '../optional-extensions/speech-synthesis/lib/asr-realtime.mjs';
import {synthesizerUrl} from '../optional-extensions/speech-synthesis/lib/qwen.mjs';
import {waveFile, normalizeWav} from '../optional-extensions/speech-synthesis/lib/wav.mjs';
import {setup} from '../optional-extensions/speech-synthesis/index.mjs';
import {VoiceIngress} from '../components/qq-bridge/src/core/voice-ingress.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const wav16 = (ms = 500, rate = 16000) => waveFile(Buffer.alloc(Math.round(rate * ms / 1000) * 2, 3), rate);
// The configuration 1.5.0 saved on this machine (clone voice kept, key replaced).
const CLONE = 'qwen-audio-3.1-realtime-flash-dafeiyu-99205bfc63b44b3fbfc8521b4ce08363';
const QWEN_WS = 'https://maas.qianwenaiapi.com/api-ws/v1/realtime';
const SAVED_150 = {voiceMode: 'dsh-realtime', endpoint: QWEN_WS, apiKey: 'legacy-qwen-key', model: '', voice: CLONE, speed: 1, recognitionModel: 'fun-asr',
  recognitionEndpoint: '', realtimeModel: 'qwen-audio-3.1-realtime-flash', realtimeEndpoint: '', realtimeProtocol: 'auto', instructions: '', timeoutMs: 5000,
  services: {version: 1, source: 'provider', provider: 'qwen', legacyKey: 'qwen', keys: {}, keyOrigins: {}, profiles: {qwen: {endpoint: QWEN_WS, model: '', voice: CLONE,
    speed: 1, recognitionModel: 'fun-asr', recognitionEndpoint: '', realtimeModel: 'qwen-audio-3.1-realtime-flash', realtimeEndpoint: '', realtimeProtocol: 'auto'}}}};
const BASE = {instructions: '', timeoutMs: 5000, apiKey: '', ttsKey: '', realtimeAsrKey: '', fileAsrKey: ''};
const slot = (spec) => spec ? {entry: spec[0], method: spec[1], profiles: {[spec[0] + '/' + spec[1]]: spec[2] ?? {}}} : undefined;
// Settings in the 1.6.0 shape: {tts: [entry, method, profile], ...}.
function configured({tts, realtimeAsr, fileAsr, recognition = 'off', reply = 'dsh', owners = {}, legacy = null, keys = {}, apiKey = ''}) {
  const services = normalizeServices({recognition, reply, tts: slot(tts), realtimeAsr: slot(realtimeAsr), fileAsr: slot(fileAsr), owners, legacy});
  return {...BASE, ...hostSettings(services), services, apiKey, ttsKey: keys.tts ?? '', realtimeAsrKey: keys.realtimeAsr ?? '', fileAsrKey: keys.fileAsr ?? ''};
}
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body};
    calls.push(call);
    return reply(call);
  };
  return {calls, fetchImpl};
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
// A scripted WebSocket: reply(event, socket) answers each client message; onOpen runs after open.
function sockets(reply, onOpen) {
  const created = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = String(url); this.options = options; this.listeners = {}; this.sent = [];
      created.push(this);
      setImmediate(() => { this.emit('open'); onOpen?.(this); });
    }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    emit(name, data) { for (const fn of this.listeners[name] ?? []) fn(data === undefined ? {} : {data: typeof data === 'string' ? data : JSON.stringify(data)}); }
    send(raw) {
      const event = Buffer.isBuffer(raw) ? {binary: raw} : JSON.parse(raw);
      this.sent.push(event);
      setImmediate(() => reply(event, this));
    }
    close() { this.closed = true; }
  }
  return {FakeSocket, created};
}

// ---- capabilities, migration and host values ----

test('the saved 1.5.0 Qwen configuration becomes Realtime speaking plus Realtime recognition, keeping the clone voice and key', () => {
  const services = servicesOf(SAVED_150);
  const tts = activeOf(services, 'tts'), asr = activeOf(services, 'realtimeAsr');
  assert.deepEqual([tts.entry, tts.method, tts.profile.model, tts.profile.voice, tts.profile.endpoint], ['qwen', 'realtime', 'qwen-audio-3.1-realtime-flash', CLONE, QWEN_WS]);
  assert.deepEqual([asr.entry, asr.method, asr.profile.model, asr.profile.sessionModel], ['qwen', 'session', 'fun-asr', 'qwen-audio-3.1-realtime-flash']);
  assert.deepEqual([services.recognition, services.reply, services.legacy], ['realtime', 'dsh', {entry: 'qwen'}]);
  assert.equal(activeOf(services, 'fileAsr').entry, '');
  // The values the host reads are unchanged, so the current chat keeps its voice features.
  assert.deepEqual(hostSettings(services), {voiceMode: SAVED_150.voiceMode, recognitionModel: SAVED_150.recognitionModel});
  for (const capability of ['tts', 'realtimeAsr']) assert.deepEqual(credentialOf(SAVED_150, capability), {key: 'legacy-qwen-key', from: 'legacy'});
  // Migrating again, or reading the saved result, gives the same services.
  assert.deepEqual(migrateServices(structuredClone(SAVED_150)), services);
  assert.deepEqual(servicesOf({...SAVED_150, services}), services);
  const resolved = resolveService(SAVED_150, 'realtimeAsr');
  assert.deepEqual([resolved.flat.realtimeModel, resolved.flat.recognitionModel, resolved.flat.apiKey], ['qwen-audio-3.1-realtime-flash', 'fun-asr', 'legacy-qwen-key']);
});

test('older flat settings map to capabilities; mixed or unknown addresses become custom APIs bound to their origins', () => {
  const sf = servicesOf({...BASE, endpoint: 'https://api.siliconflow.cn/v1', model: 'm', voice: 'v', recognitionModel: 'asr'});
  assert.deepEqual([activeOf(sf, 'tts').entry, activeOf(sf, 'tts').method, activeOf(sf, 'fileAsr').method, sf.recognition], ['siliconflow', 'speech', 'transcriptions', 'file']);
  const local = servicesOf({...BASE, endpoint: 'http://127.0.0.1:8000/v1', model: 'm', voice: 'v'});
  assert.deepEqual([activeOf(local, 'tts').entry, local.legacy], ['custom', {entry: 'custom', origins: ['http://127.0.0.1:8000']}]);
  const direct = servicesOf({...BASE, voiceMode: 'realtime', realtimeEndpoint: 'wss://gw.example.org/v1/realtime', realtimeModel: 'rt', voice: 'v'});
  assert.deepEqual([activeOf(direct, 'tts').entry, activeOf(direct, 'tts').method, direct.reply, hostSettings(direct).voiceMode], ['custom', 'realtime', 'direct', 'realtime']);
  const split = servicesOf({...BASE, voiceMode: 'dsh-realtime', endpoint: QWEN_WS, realtimeModel: 'qwen-audio-3.1-realtime-flash', voice: 'v', recognitionModel: 'asr', recognitionEndpoint: 'https://asr.example.org/v1'});
  assert.deepEqual([activeOf(split, 'tts').entry, activeOf(split, 'fileAsr').entry, split.legacy.entry], ['custom', 'custom', 'custom']);
  assert.equal(servicesOf({...BASE}).tts.entry, '');
});

test('every provider lists its capabilities honestly; only verified paths are marked tested', () => {
  const tested = [];
  for (const item of PROVIDERS) for (const capability of CAPABILITY_IDS) for (const [method, definition] of Object.entries(item[capability] ?? {})) {
    assert(['tested', 'pending'].includes(definition.status), item.id + '/' + method);
    if (definition.status === 'tested') tested.push(`${item.id}:${capability}:${method}`);
  }
  // Qwen Realtime speaking reached WeChat; fun-asr session recognition transcribed a real voice.
  assert.deepEqual(tested, ['qwen:tts:realtime', 'qwen:realtimeAsr:session']);
  assert.deepEqual(providersFor('realtimeAsr').map(item => item.id), ['qwen', 'tencent', 'openai']);
  for (const priority of ['qwen', 'tencent', 'openai', 'siliconflow']) assert(providersFor('tts').some(item => item.id === priority));
  assert.deepEqual(Object.keys(CUSTOM.tts), ['speech', 'realtime']);
  assert.deepEqual(Object.keys(CUSTOM.fileAsr), ['transcriptions']);
});

// ---- credentials stay with their owners ----

test('different providers per capability each use their own credential; same-provider keys are shared, others never', () => {
  const settings = configured({tts: ['qwen', 'speech'], realtimeAsr: ['qwen', 'asr'], fileAsr: ['tencent', 'sentence'], recognition: 'file',
    owners: {tts: {entry: 'qwen'}, fileAsr: {entry: 'tencent'}}, keys: {tts: 'qwen-key', fileAsr: 'AKIDtest0001:secretKey0001'}});
  assert.deepEqual(credentialOf(settings, 'tts'), {key: 'qwen-key', from: 'tts'});
  assert.deepEqual(credentialOf(settings, 'realtimeAsr'), {key: 'qwen-key', from: 'tts'});
  assert.deepEqual(credentialOf(settings, 'fileAsr'), {key: 'AKIDtest0001:secretKey0001', from: 'fileAsr'});
  // A Tencent key is never offered to OpenAI, and the legacy key stays with its owner.
  const openai = configured({tts: ['openai', 'speech'], owners: {fileAsr: {entry: 'tencent'}}, keys: {fileAsr: 'AKID:x'}, legacy: {entry: 'qwen'}, apiKey: 'legacy'});
  assert.deepEqual(credentialOf(openai, 'tts'), {key: '', from: ''});
  assert.throws(() => resolveService(configured({tts: ['qwen', 'speech', {endpoint: 'https://maas.qianwenaiapi.com.attacker.example/api/v1'}]}), 'tts'), {message: 'VOICE_PROVIDER_HOST'});
});

test('a saved custom key only reaches the origins it was saved for; a typed key binds the new address', async () => {
  const saved = configured({tts: ['custom', 'speech', {endpoint: 'https://a.example/v1', model: 'm', voice: 'v'}], owners: {tts: {entry: 'custom', origins: ['https://a.example']}}, keys: {tts: 'custom-key'}});
  assert.equal(resolveService(saved, 'tts').key, 'custom-key');
  const moved = structuredClone(saved);
  moved.services.tts.profiles['custom/speech'].endpoint = 'https://b.example/v1';
  moved.ttsKey = '';
  const merged = mergeDraft(saved, moved);
  assert.deepEqual(merged.services.owners.tts, {entry: 'custom', origins: ['https://a.example']});
  const spy = recorder(() => assert.fail('no request may leave'));
  await assert.rejects(synthesizeText(merged, '你好', {fetchImpl: spy.fetchImpl}), {message: 'VOICE_KEY_ORIGIN'});
  const retyped = mergeDraft(saved, {...moved, ttsKey: 'new-key'});
  assert.deepEqual(retyped.services.owners.tts, {entry: 'custom', origins: ['https://b.example']});
  assert.equal(resolveService(retyped, 'tts').key, 'new-key');
  // The legacy key's owner cannot be moved by a draft.
  const redirected = mergeDraft(SAVED_150, {...SAVED_150, apiKey: '', services: {...servicesOf(SAVED_150), legacy: {entry: 'custom', origins: ['https://attacker.example']}}});
  assert.deepEqual(redirected.services.legacy, {entry: 'qwen'});
});

// ---- Qwen ----

test('Qwen dedicated TTS: SpeechSynthesizer over SSE with the TTS model, voice, rate and 16 kHz PCM', async () => {
  const settings = configured({tts: ['qwen', 'speech', {voice: 'longanhuan_v3.1', speed: 1.2}], owners: {tts: {entry: 'qwen'}}, keys: {tts: 'qwen-key'}});
  const half = Buffer.alloc(8000 * 2, 7).toString('base64');
  const sse = [{output: {finish_reason: 'null', type: 'sentence-begin', audio: {data: ''}}}, {output: {type: 'sentence-synthesis', audio: {data: half}}},
    {output: {type: 'sentence-synthesis', audio: {data: half}}}, {output: {finish_reason: 'stop', audio: {data: '', url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.pcm'}}}]
    .map((event, index) => `id:${index}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify(event)}\n\n`).join('');
  const server = recorder(call => {
    assert.equal(call.url, 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
    assert.deepEqual([call.headers.Authorization, call.headers['X-DashScope-SSE']], ['Bearer qwen-key', 'enable']);
    assert.deepEqual(JSON.parse(call.body), {model: 'qwen-audio-3.1-tts-flash', input: {text: '你好', voice: 'longanhuan_v3.1', format: 'pcm', sample_rate: 16000, rate: 1.2}});
    return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
  });
  const {pcm, durationMs} = await synthesizeText(settings, '你好', {fetchImpl: server.fetchImpl});
  assert.deepEqual([pcm.length, durationMs, server.calls.length], [32000, 1000, 1]);
  assert.equal(synthesizerUrl('https://ws1.cn-beijing.maas.aliyuncs.com/api/v1').href, 'https://ws1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  const failed = recorder(() => new Response('data:' + JSON.stringify({code: 'InvalidParameter', message: 'voice'}) + '\n\n', {status: 400}));
  await assert.rejects(synthesizeText(settings, '你好', {fetchImpl: failed.fetchImpl}), error => error.message === 'VOICE_TTS_HTTP' && error.providerCode === 'InvalidParameter');
  const cut = recorder(() => new Response('data:' + JSON.stringify({output: {type: 'sentence-synthesis', audio: {data: half}}}) + '\n\n'));
  await assert.rejects(synthesizeText(settings, '你好', {fetchImpl: cut.fetchImpl}), {message: 'VOICE_TTS_STREAM_INCOMPLETE'});
});

test('Qwen single-file recognition posts the voice as a data URL to /chat/completions', async () => {
  const settings = configured({fileAsr: ['qwen', 'chat'], recognition: 'file', owners: {fileAsr: {entry: 'qwen'}}, keys: {fileAsr: 'qwen-key'}});
  const server = recorder(call => {
    assert.equal(call.url, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(call.body);
    assert.deepEqual([body.model, body.stream, body.asr_options], ['qwen3-asr-flash', false, {enable_itn: false}]);
    assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,UklGR/);
    return json({choices: [{message: {role: 'assistant', content: '欢迎使用千问。'}}]});
  });
  assert.equal(await transcribeVoice(settings, wav16(), {fetchImpl: server.fetchImpl}), '欢迎使用千问。');
});

test('Qwen-ASR-Realtime streams segments, reports text plus stash as interim results, and returns one final transcript', async () => {
  const settings = configured({realtimeAsr: ['qwen', 'asr'], recognition: 'realtime', owners: {realtimeAsr: {entry: 'qwen'}}, keys: {realtimeAsr: 'qwen-key'}});
  const {FakeSocket, created} = sockets((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'session.finish') {
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.text', text: '', stash: '北京'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.text', text: '北京的', stash: '天气'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', transcript: '北京的天气。'});
      socket.emit('message', {type: 'session.finished'});
    }
  });
  const partials = [];
  const text = await transcribeVoice(settings, wav16(1200), {WebSocketImpl: FakeSocket, onPartial: value => partials.push(value)});
  assert.equal(text, '北京的天气。');
  assert.deepEqual(partials, ['北京', '北京的天气', '北京的天气。']);
  const socket = created[0];
  assert.equal(socket.url, 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime');
  assert.equal(socket.options.headers.Authorization, 'Bearer qwen-key');
  const sent = socket.sent.map(event => event.type);
  assert.deepEqual([sent[0], sent.at(-2), sent.at(-1)], ['session.update', 'input_audio_buffer.commit', 'session.finish']);
  // Half-second segments: 1.2 s of 16 kHz audio is three appends.
  assert.equal(sent.filter(type => type === 'input_audio_buffer.append').length, 3);
  assert.deepEqual(socket.sent[0].session, {modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000, input_audio_transcription: {}, turn_detection: null});
});

test('the 1.5.0 fun-asr session recognition still runs on the Qwen-Audio-Realtime socket with interim deltas', async () => {
  const {FakeSocket, created} = sockets((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') {
      socket.emit('message', {type: 'input_audio_buffer.committed', item_id: 'i1'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: '你好'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: '你好世界'});
    }
  });
  const partials = [];
  assert.equal(await transcribeVoice(SAVED_150, wav16(), {WebSocketImpl: FakeSocket, onPartial: value => partials.push(value)}), '你好世界');
  assert.deepEqual(partials, ['你好']);
  assert.equal(created[0].url, 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen-audio-3.1-realtime-flash');
  assert.equal(created[0].options.headers.Authorization, 'Bearer legacy-qwen-key');
  const update = created[0].sent[0].session;
  assert.deepEqual([update.input_audio_transcription, update.modalities, 'voice' in update], [{model: 'fun-asr'}, ['text'], false]);
});

// ---- Tencent Cloud ----

test('TC3-HMAC-SHA256 builds the documented canonical request', () => {
  const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  const result = tc3Authorization({secretId: 'AKIDEXAMPLE', secretKey: 'SECRET', service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances', timestamp: 1551113065, payload});
  assert.equal(sha256(payload), '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064');
  assert.equal(sha256(result.canonicalRequest), '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
  assert.match(result.authorization, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
});

function tencentServer(secretKey, handle) {
  return recorder(call => {
    const host = new URL(call.url).host, h = call.headers;
    const match = /^TC3-HMAC-SHA256 Credential=([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\w+)\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=([0-9a-f]{64})$/.exec(h.Authorization);
    assert(match, 'authorization header');
    const [, , date, service, signature] = match;
    const canonical = `POST\n/\n\ncontent-type:${h['Content-Type']}\nhost:${host}\nx-tc-action:${h['X-TC-Action'].toLowerCase()}\n\ncontent-type;host;x-tc-action\n${sha256(call.body)}`;
    const toSign = `TC3-HMAC-SHA256\n${h['X-TC-Timestamp']}\n${date}/${service}/tc3_request\n${sha256(canonical)}`;
    const mac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
    const expected = crypto.createHmac('sha256', mac(mac(mac('TC3' + secretKey, date), service), 'tc3_request')).update(toSign).digest('hex');
    if (expected !== signature) return json({Response: {Error: {Code: 'AuthFailure.SignatureFailure', Message: 'x'}, RequestId: 'r'}});
    return handle(call, JSON.parse(call.body));
  });
}

test('Tencent TextToVoice and SentenceRecognition run as separate capabilities with their own signed requests', async () => {
  const settings = configured({tts: ['tencent', 'tc', {voice: '502001', speed: 1.2, region: 'ap-guangzhou'}], fileAsr: ['tencent', 'sentence'], recognition: 'file',
    owners: {tts: {entry: 'tencent'}}, keys: {tts: 'AKIDtest0001:secretKey0001'}});
  const server = tencentServer('secretKey0001', (call, body) => {
    if (call.url === 'https://tts.tencentcloudapi.com/') {
      assert.deepEqual([call.headers['X-TC-Action'], call.headers['X-TC-Region'], body.VoiceType, body.Speed, body.SampleRate], ['TextToVoice', 'ap-guangzhou', 502001, 1, 16000]);
      assert(body.Text.length <= 150);
      return json({Response: {Audio: wav16(400).toString('base64'), RequestId: 'r'}});
    }
    assert.equal(call.url, 'https://asr.tencentcloudapi.com/');
    assert.deepEqual([call.headers['X-TC-Action'], call.headers['X-TC-Region'], body.EngSerViceType, body.SourceType], ['SentenceRecognition', undefined, '16k_zh', 1]);
    return json({Response: {Result: '腾讯云语音识别欢迎您。', RequestId: 'r'}});
  });
  const reply = '这是一句用来测试分段合成的话。'.repeat(22);
  const {pcm} = await synthesizeText(settings, reply, {fetchImpl: server.fetchImpl});
  assert.equal(pcm.length, splitText(reply).length * 6400 * 2);
  // File recognition reuses the Tencent key saved for synthesis.
  assert.equal(await transcribeVoice(settings, wav16(), {fetchImpl: server.fetchImpl}), '腾讯云语音识别欢迎您。');
  assert.deepEqual([tencentSpeed(1), tencentSpeed(0.8), tencentSpeed(1.5)], [0, -1, 2]);
});

test('Tencent realtime ASR signs the URL with HMAC-SHA1, paces 200 ms frames and returns the stable segments once', async () => {
  const {url, source, signature} = tencentAsrUrl({appId: '1259228442', secretId: 'AKIDtest0001', secretKey: 'secretKey0001', engine: '16k_zh', voiceId: 'v-1', timestamp: 1673408372, nonce: 1673408372});
  assert.equal(source, 'asr.cloud.tencent.com/asr/v2/1259228442?engine_model_type=16k_zh&expired=1673494772&nonce=1673408372&secretid=AKIDtest0001&timestamp=1673408372&voice_format=1&voice_id=v-1');
  assert.equal(signature, crypto.createHmac('sha1', 'secretKey0001').update(source).digest('base64'));
  assert(url.endsWith('&signature=' + encodeURIComponent(signature)));
  // At most 3 seconds of audio per second.
  assert(TENCENT_FRAME_MS / TENCENT_INTERVAL_MS <= 3);
  const settings = configured({realtimeAsr: ['tencent', 'ws', {appId: '1259228442', model: '16k_zh'}], recognition: 'realtime', owners: {realtimeAsr: {entry: 'tencent'}}, keys: {realtimeAsr: 'AKIDtest0001:secretKey0001'}});
  const service = resolveService(settings, 'realtimeAsr');
  let frames = 0;
  const {FakeSocket, created} = sockets((event, socket) => {
    if (event.binary) { frames++; assert(event.binary.length <= 6400); return; }
    assert.deepEqual(event, {type: 'end'});
    socket.emit('message', {code: 0, result: {slice_type: 0, index: 0, voice_text_str: '实时'}});
    socket.emit('message', {code: 0, result: {slice_type: 2, index: 0, voice_text_str: '实时语音识别'}});
    socket.emit('message', {code: 0, final: 1});
  }, socket => socket.emit('message', {code: 0, message: 'success', voice_id: 'v'}));
  const partials = [];
  const text = await tencentTranscribe(service, wav16(1000), {WebSocketImpl: FakeSocket, intervalMs: 1, onPartial: value => partials.push(value)});
  assert.deepEqual([text, partials, frames], ['实时语音识别', ['实时', '实时语音识别'], 5]);
  assert.match(created[0].url, /^wss:\/\/asr\.cloud\.tencent\.com\/asr\/v2\/1259228442\?engine_model_type=16k_zh&.*voice_format=1&voice_id=[0-9a-f-]{36}&signature=/);
  const failing = sockets(() => {}, socket => socket.emit('message', {code: 4002, message: 'auth'}));
  await assert.rejects(tencentTranscribe(service, wav16(400), {WebSocketImpl: failing.FakeSocket, intervalMs: 1}), error => error.message === 'VOICE_TTS_AUTH' && error.providerCode === '4002');
  const noAppId = configured({realtimeAsr: ['tencent', 'ws', {appId: ''}], recognition: 'realtime', owners: {realtimeAsr: {entry: 'tencent'}}, keys: {realtimeAsr: 'AKIDtest0001:secretKey0001'}});
  await assert.rejects(transcribeVoice(noAppId, wav16(), {WebSocketImpl: failing.FakeSocket}), {message: 'VOICE_TENCENT_APPID'});
});

// ---- OpenAI and the other providers ----

test('OpenAI realtime transcription uses a transcription session at 24 kHz and returns the completed transcript', async () => {
  const settings = configured({realtimeAsr: ['openai', 'transcription'], recognition: 'realtime', owners: {realtimeAsr: {entry: 'openai'}}, keys: {realtimeAsr: 'sk-openai'}});
  const {FakeSocket, created} = sockets((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') {
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.delta', delta: 'Hello'});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello world.'});
    }
  });
  const partials = [];
  assert.equal(await transcribeVoice(settings, wav16(), {WebSocketImpl: FakeSocket, onPartial: value => partials.push(value)}), 'Hello world.');
  assert.equal(created[0].url, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.deepEqual(created[0].sent[0].session.audio.input, {format: {type: 'audio/pcm', rate: 24000}, transcription: {model: 'gpt-4o-mini-transcribe'}, turn_detection: null});
  const appended = created[0].sent.filter(event => event.type === 'input_audio_buffer.append').map(event => Buffer.from(event.audio, 'base64').length);
  assert.equal(appended.reduce((a, b) => a + b, 0), 24000);
  assert.deepEqual(partials, ['Hello']);
});

test('ElevenLabs, Azure and Google keep their synthesis and recognition requests in the capability shape', async () => {
  const eleven = configured({tts: ['elevenlabs', 'tts', {voice: 'JBFqnCBsd6RMkjVDRZzb', speed: 1.5}], fileAsr: ['elevenlabs', 'stt'], recognition: 'file',
    owners: {tts: {entry: 'elevenlabs'}}, keys: {tts: 'xi-key'}});
  const elevenServer = recorder(async call => {
    assert.equal(call.headers['xi-api-key'], 'xi-key');
    if (call.url.includes('/text-to-speech/')) {
      assert.deepEqual(JSON.parse(call.body).voice_settings, {speed: 1.2});
      return new Response(wav16(300));
    }
    return json({text: '你好世界'});
  });
  assert.equal((await synthesizeText(eleven, '你好', {fetchImpl: elevenServer.fetchImpl})).durationMs, 300);
  assert.equal(await transcribeVoice(eleven, wav16(), {fetchImpl: elevenServer.fetchImpl}), '你好世界');

  const azure = configured({tts: ['azure', 'tts', {region: 'eastasia', voice: 'zh-CN-XiaoxiaoNeural'}], fileAsr: ['azure', 'stt', {region: 'eastasia', model: 'zh-CN'}], recognition: 'file',
    owners: {tts: {entry: 'azure'}}, keys: {tts: 'azure-key'}});
  const azureServer = recorder(async call => {
    assert.equal(call.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
    const url = new URL(call.url);
    if (url.host === 'eastasia.tts.speech.microsoft.com') return new Response(wav16(500, 24000));
    assert.deepEqual([url.host, url.searchParams.get('language')], ['eastasia.stt.speech.microsoft.com', 'zh-CN']);
    return json({RecognitionStatus: 'Success', DisplayText: '提醒我买五支铅笔。'});
  });
  assert.equal((await synthesizeText(azure, 'a < b', {fetchImpl: azureServer.fetchImpl})).pcm.length, 16000);
  assert.equal(await transcribeVoice(azure, wav16(), {fetchImpl: azureServer.fetchImpl}), '提醒我买五支铅笔。');
  assert.deepEqual((await listFor(azure, 'tts', {fetchImpl: recorder(() => json([{ShortName: 'zh-CN-YunxiNeural', LocalName: '云希', Locale: 'zh-CN'}])).fetchImpl})).voices,
    [{id: 'zh-CN-YunxiNeural', label: '云希（zh-CN）'}]);

  resetCloudTokens();
  const {privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const account = {type: 'service_account', client_email: 'speech@p.iam.gserviceaccount.com', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})};
  const google = configured({tts: ['google', 'tts'], fileAsr: ['google', 'stt'], recognition: 'file', owners: {fileAsr: {entry: 'google'}}, keys: {fileAsr: JSON.stringify(account)}});
  let tokens = 0;
  const googleServer = recorder(async call => {
    if (call.url === 'https://oauth2.googleapis.com/token') { tokens++; return json({access_token: 'ya29.fixture', expires_in: 3599}); }
    assert.equal(call.headers.Authorization, 'Bearer ya29.fixture');
    if (call.url.endsWith('text:synthesize')) return json({audioContent: wav16(250).toString('base64')});
    return json({results: [{alternatives: [{transcript: '你好'}]}]});
  });
  // Synthesis reuses the Google service account saved for recognition.
  assert.equal((await synthesizeText(google, '你好', {fetchImpl: googleServer.fetchImpl})).durationMs, 250);
  assert.equal(await transcribeVoice(google, wav16(), {fetchImpl: googleServer.fetchImpl}), '你好');
  assert.equal(tokens, 1);
  resetCloudTokens();
});

// ---- custom APIs ----

test('custom APIs: full URLs, gateway prefixes, header or no auth, optional model list and error responses', async () => {
  const full = configured({tts: ['custom', 'speech', {endpoint: 'https://gw.example/team/v1/audio/speech?api-version=2', model: 'm', voice: 'v'}],
    fileAsr: ['custom', 'transcriptions', {endpoint: 'https://gw.example/team/v1?api-version=2', model: 'asr'}], recognition: 'file',
    owners: {tts: {entry: 'custom', origins: ['https://gw.example']}}, keys: {tts: 'k'}});
  const seen = recorder(call => call.url.includes('/audio/speech') ? new Response(wav16(200)) : json({text: '好'}));
  await synthesizeText(full, '你好', {fetchImpl: seen.fetchImpl});
  assert.equal(await transcribeVoice(full, wav16(), {fetchImpl: seen.fetchImpl}), '好');
  assert.deepEqual(seen.calls.map(call => [call.url, call.headers.Authorization]), [
    ['https://gw.example/team/v1/audio/speech?api-version=2', 'Bearer k'], ['https://gw.example/team/v1/audio/transcriptions?api-version=2', 'Bearer k']]);

  const header = configured({tts: ['custom', 'speech', {endpoint: 'https://gw.example/openai/v1', model: 'm', voice: 'v', auth: 'header', authHeader: 'x-api-key'}],
    owners: {tts: {entry: 'custom', origins: ['https://gw.example']}}, keys: {tts: 'k'}});
  const headerAuth = recorder(call => call.url.endsWith('/models') ? new Response('missing', {status: 404}) : new Response(wav16(200)));
  await synthesizeText(header, '你好', {fetchImpl: headerAuth.fetchImpl});
  assert.deepEqual([headerAuth.calls[0].url, headerAuth.calls[0].headers['x-api-key'], headerAuth.calls[0].headers.Authorization], ['https://gw.example/openai/v1/audio/speech', 'k', undefined]);
  await assert.rejects(listFor(header, 'tts', {fetchImpl: headerAuth.fetchImpl}), {message: 'VOICE_TTS_MODELS'});

  const local = configured({tts: ['custom', 'speech', {endpoint: 'http://127.0.0.1:8000', model: 'm', voice: 'v', auth: 'none'}]});
  const open = recorder(() => new Response(wav16(200)));
  await synthesizeText(local, '你好', {fetchImpl: open.fetchImpl});
  assert.deepEqual([open.calls[0].url, open.calls[0].headers.Authorization], ['http://127.0.0.1:8000/v1/audio/speech', undefined]);
  for (const [status, code] of [[401, 'VOICE_TTS_AUTH'], [404, 'VOICE_TTS_MODEL'], [500, 'VOICE_TTS_HTTP']]) {
    await assert.rejects(synthesizeText(full, '你好', {fetchImpl: recorder(() => new Response('x', {status})).fetchImpl}), {message: code});
  }
  assert.throws(() => resolveService(configured({realtimeAsr: ['custom', 'asr', {endpoint: 'wss://gw.example/v1', auth: 'header', authHeader: 'x-key'}]}), 'realtimeAsr'),
    {message: 'VOICE_AUTH_HEADER_REALTIME'});
});

// ---- the plugin actions and the chat path ----

function plugin() {
  const actions = new Map();
  setup({registerAction: action => actions.set(action.id, action)});
  const audio = [];
  const run = (id, args, settings) => actions.get(id).execute({mode: 'settings', settings, signal: undefined, audio: {
    write: async chunk => { audio.push(chunk); }, read: async () => ({b64: wav16(800).toString('base64')}),
  }}, args);
  return {run, audio};
}
async function withGlobals({fetch: fetchReply, WebSocket: socket}, body) {
  const previous = {fetch: globalThis.fetch, WebSocket: globalThis.WebSocket};
  const server = recorder(fetchReply ?? (() => assert.fail('no HTTP request expected')));
  globalThis.fetch = server.fetchImpl;
  if (socket) globalThis.WebSocket = socket;
  try { return await body(server); } finally { Object.assign(globalThis, previous); }
}

test('each WeChat voice goes to the selected recognition method only, and DSH receives the final transcript once', async () => {
  const realtime = sockets((event, socket) => {
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type === 'session.finish') {
      for (const stash of ['今', '今天', '今天下雨']) socket.emit('message', {type: 'conversation.item.input_audio_transcription.text', text: '', stash});
      socket.emit('message', {type: 'conversation.item.input_audio_transcription.completed', transcript: '今天下雨。'});
      socket.emit('message', {type: 'session.finished'});
    }
  });
  const both = recognition => configured({realtimeAsr: ['qwen', 'asr'], fileAsr: ['openai', 'transcriptions'], recognition,
    owners: {realtimeAsr: {entry: 'qwen'}, fileAsr: {entry: 'openai'}}, keys: {realtimeAsr: 'qwen-key', fileAsr: 'sk-openai'}});
  const {run} = plugin();
  // File: only the transcription route is called; no socket is opened.
  await withGlobals({fetch: call => { assert.equal(call.headers.Authorization, 'Bearer sk-openai'); return json({text: '单条识别结果'}); }, WebSocket: realtime.FakeSocket}, async server => {
    assert.deepEqual(await run('transcribe', {id: 'a'.repeat(64)}, both('file')), {ok: true, text: '单条识别结果'});
    assert.deepEqual([server.calls.length, realtime.created.length], [1, 0]);
  });
  // Realtime: one socket, interim results stay inside; the host's ingress delivers one message to DSH.
  await withGlobals({WebSocket: realtime.FakeSocket}, async () => {
    const delivered = [];
    const ingress = new VoiceIngress({
      recognize: async message => run('transcribe', {id: message.voice.id}, both('realtime')),
      deliver: async message => { delivered.push(message.text); },
    });
    const message = {platform: 'wechat', kind: 'private', conversation_id: '123', message_id: 'm1', voice: {id: 'b'.repeat(64)}, text: '[语音]'};
    await Promise.all([ingress.push(message), ingress.push(message)]);
    assert.equal(realtime.created.length, 1);
    assert.deepEqual(delivered, ['[语音转写，可能存在识别误差] 今天下雨。']);
  });
  assert.deepEqual(await run('transcribe', {id: 'c'.repeat(64)}, both('off')), {ok: false, code: 'VOICE_RECOGNITION_OFF', message: '当前设置为不识别微信语音。'});
});

test('settings actions: tests show interim results, never return credentials, and validate each capability', async () => {
  const {run} = plugin();
  const saved = configured({tts: ['tencent', 'tc'], realtimeAsr: ['openai', 'transcription'], recognition: 'realtime',
    owners: {tts: {entry: 'tencent'}, realtimeAsr: {entry: 'openai'}}, keys: {tts: 'AKIDtest0001:secretKey0001', realtimeAsr: 'sk-openai-secret'}});
  const draft = {...saved, ttsKey: '', realtimeAsrKey: ''};
  const socket = sockets((event, ws) => {
    if (event.type === 'session.update') ws.emit('message', {type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') {
      ws.emit('message', {type: 'conversation.item.input_audio_transcription.delta', delta: '你好'});
      ws.emit('message', {type: 'conversation.item.input_audio_transcription.completed', transcript: '你好，sk-openai-secret。'});
    }
  });
  const result = await withGlobals({WebSocket: socket.FakeSocket}, () => run('check-input', {settings: draft, method: 'realtime'}, saved));
  assert.deepEqual(result, {ok: true, method: 'realtime', text: '你好，[已隐藏]。', partials: ['你好']});
  const tts = await withGlobals({fetch: () => json({Response: {Audio: wav16(300).toString('base64'), RequestId: 'r'}})}, () => run('check', {settings: draft}, saved));
  assert.equal(tts.ok, true);
  assert(tts.preview.length > 100);
  assert.deepEqual(await run('credentials', {settings: draft}, saved), {ok: true, sources: {tts: 'tts', realtimeAsr: 'realtimeAsr', fileAsr: ''}});
  assert.deepEqual(await run('validate', {settings: draft}, saved), {ok: true});
  // Selecting file recognition without configuring it, or direct dialogue without Realtime speaking, is refused.
  const noFile = {...draft, services: {...draft.services, recognition: 'file'}, recognitionModel: ''};
  assert.equal((await run('validate', {settings: noFile}, saved)).code, 'VOICE_RECOGNITION_NOT_CONFIGURED');
  const direct = {...draft, services: {...draft.services, reply: 'direct'}};
  assert.equal((await run('validate', {settings: direct}, saved)).code, 'VOICE_REALTIME_CONFIG');
  const keyless = {...saved, ttsKey: ''};
  assert.equal((await run('validate', {settings: {...keyless}}, keyless)).code, 'VOICE_PROVIDER_CREDENTIAL');
  // The 1.5.0 configuration still validates without any change.
  assert.deepEqual(await run('validate', {settings: {...SAVED_150, apiKey: ''}}, SAVED_150), {ok: true});
});

test('synthesis follows the TTS capability: Qwen Realtime speaking keeps its clone voice; switching to dedicated TTS uses the TTS voice', async () => {
  const seen = [];
  const realtime = sockets((event, socket) => {
    seen.push(event);
    if (event.type === 'session.update') socket.emit('message', {type: 'session.updated'});
    if (event.type !== 'response.create') return;
    socket.emit('message', {type: 'response.created', response: {id: 'q'}});
    socket.emit('message', {type: 'response.audio.delta', response_id: 'q', delta: Buffer.alloc(4800, 1).toString('base64')});
    socket.emit('message', {type: 'response.done', response: {id: 'q', status: 'completed'}});
  });
  const {run, audio} = plugin();
  await withGlobals({WebSocket: realtime.FakeSocket}, async () => assert.deepEqual(await run('synthesize', {text: '你好'}, SAVED_150), {ok: true}));
  assert.equal(seen.find(event => event.type === 'session.update').session.voice, CLONE);
  assert(audio.length > 0);
  const services = servicesOf(SAVED_150);
  services.tts.method = 'speech';
  const speech = {...SAVED_150, services, ...hostSettings(services)};
  const half = Buffer.alloc(16000, 2).toString('base64');
  const sse = 'data:' + JSON.stringify({output: {audio: {data: half}}}) + '\n\ndata:' + JSON.stringify({output: {finish_reason: 'stop', audio: {data: ''}}}) + '\n\n';
  await withGlobals({fetch: call => {
    const body = JSON.parse(call.body);
    assert.deepEqual([body.model, body.input.voice, call.headers.Authorization], ['qwen-audio-3.1-tts-flash', 'longanhuan_v3.1', 'Bearer legacy-qwen-key']);
    return new Response(sse);
  }}, async () => assert.deepEqual(await run('synthesize', {text: '你好'}, speech), {ok: true}));
  assert.equal(hostSettings(services).voiceMode, 'separate');
  // The Realtime profile, with the clone voice, is kept for switching back.
  assert.equal(services.tts.profiles['qwen/realtime'].voice, CLONE);
});
