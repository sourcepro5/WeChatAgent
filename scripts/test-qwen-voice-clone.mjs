import assert from 'node:assert/strict';
import test from 'node:test';
import {cloneVoice as cloneWith, queryVoice as queryWith} from '../optional-extensions/speech-synthesis/lib/voice-clone.mjs';
import {cloneTarget} from '../optional-extensions/speech-synthesis/ui/qwen-clone.mjs';
import {resolveService} from '../optional-extensions/speech-synthesis/lib/resolve.mjs';
import {servicesOf} from '../optional-extensions/speech-synthesis/ui/providers.mjs';
// The clone action resolves the TTS service from the settings first.
const cloneVoice = async (value, ...rest) => cloneWith(resolveService(value, 'tts'), ...rest);
const queryVoice = async (value, ...rest) => queryWith(resolveService(value, 'tts'), ...rest);
const qwenCloneEndpoint = value => cloneTarget(servicesOf(value))?.endpoint ?? null;
import {waveFile} from '../optional-extensions/speech-synthesis/lib/wav.mjs';
import {settingsActionBytes} from './plugin-settings-actions.mjs';

const model = 'qwen-audio-3.1-realtime-flash';
const settings = {voiceMode: 'dsh-realtime', endpoint: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',
  realtimeModel: model, apiKey: 'fixture-key', timeoutMs: 1000};
const voiceId = model + '-myvoice-123456';
const recording = {prefix: 'myvoice', format: 'wav', base64: waveFile(Buffer.alloc(320000)).toString('base64')};

test('uploads a local recording to the official endpoint and queries the matching model', async () => {
  const requests = [];
  const fetchImpl = async (url, {body, headers, method, redirect}) => {
    assert.equal(url, 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization');
    assert.equal(headers.Authorization, 'Bearer fixture-key');
    assert.equal(method, 'POST');
    assert.equal(redirect, 'error');
    const request = JSON.parse(body);
    assert.equal(request.model, 'voice-enrollment');
    requests.push(request.input);
    return Response.json({output: requests.length === 1 ? {voice_id: voiceId} : {status: 'OK', target_model: model, resource_link: 'private'}});
  };
  assert.deepEqual(await cloneVoice(settings, recording, {fetchImpl}), {voiceId});
  assert.deepEqual(await queryVoice(settings, voiceId, {fetchImpl}), {voiceId, status: 'OK', targetModel: model});
  assert.deepEqual(requests, [
    {action: 'create_voice', target_model: model, prefix: recording.prefix, audio: 'data:audio/wav;base64,' + recording.base64},
    {action: 'query_voice', voice_id: voiceId},
  ]);
  assert(Buffer.byteLength(JSON.stringify(recording)) > settingsActionBytes('speech-synthesis', 'check'));
  assert(Buffer.byteLength(JSON.stringify(recording)) < settingsActionBytes('speech-synthesis', 'clone-voice'));
  assert.equal(settingsActionBytes('other-plugin', 'clone-voice'), settingsActionBytes('speech-synthesis', 'check'));
});

test('uses the configured Alibaba Cloud workspace and rejects invalid uploads before calling the provider', async () => {
  const workspace = 'myworkspace.cn-beijing.maas.aliyuncs.com';
  assert.equal(qwenCloneEndpoint({...settings, realtimeEndpoint: 'wss://' + workspace + '/api-ws/v1/realtime'}),
    'https://' + workspace + '/api/v1/services/audio/tts/customization');
  const fetchImpl = () => assert.fail('Invalid input must stay local');
  for (const endpoint of ['https://maas.qianwenaiapi.com.example.org', 'http://maas.qianwenaiapi.com', 'wss://user@maas.qianwenaiapi.com']) {
    await assert.rejects(cloneVoice({...settings, endpoint}, recording, {fetchImpl}), {message: 'VOICE_CLONE_CONFIG'});
  }
  await assert.rejects(cloneVoice({...settings, realtimeModel: 'glm-realtime-flash'}, recording, {fetchImpl}), {message: 'VOICE_CLONE_CONFIG'});
  await assert.rejects(cloneVoice(settings, {...recording, prefix: '测试'}, {fetchImpl}), {message: 'VOICE_CLONE_PREFIX'});
  await assert.rejects(cloneVoice(settings, {...recording, format: 'm4a'}, {fetchImpl}), {message: 'VOICE_CLONE_AUDIO'});
  await assert.rejects(cloneVoice(settings, {...recording, base64: recording.base64 + '\n==='}, {fetchImpl}), {message: 'VOICE_CLONE_AUDIO'});
});

test('reports deployment status and never retries an ambiguous create', async () => {
  for (const status of ['DEPLOYING', 'UNDEPLOYED']) {
    const fetchImpl = async () => Response.json({output: {status, target_model: model}});
    assert.deepEqual(await queryVoice(settings, voiceId, {fetchImpl}), {voiceId, status, targetModel: model});
  }
  await assert.rejects(queryVoice(settings, voiceId, {fetchImpl: async () => Response.json({output: {status: 'OK', target_model: 'other'}})}),
    {message: 'VOICE_CLONE_MODEL'});
  let attempts = 0;
  const fetchImpl = async () => { attempts++; throw new TypeError('fixture disconnected'); };
  await assert.rejects(cloneVoice(settings, recording, {fetchImpl}), {message: 'VOICE_CLONE_UNCERTAIN'});
  assert.equal(attempts, 1);
});

test('a dedicated TTS method clones for its own model; a voice bound to another model is never applied', async () => {
  const tts = 'qwen-audio-3.1-tts-flash';
  const speech = {services: {version: 2, recognition: 'off', reply: 'dsh', tts: {entry: 'qwen', method: 'speech', profiles: {'qwen/speech': {endpoint: 'https://maas.qianwenaiapi.com/api/v1', model: tts, voice: 'longanhuan_v3.1', speed: 1}}},
    realtimeAsr: {entry: '', method: '', profiles: {}}, fileAsr: {entry: '', method: '', profiles: {}}, owners: {tts: {entry: 'qwen'}, realtimeAsr: null, fileAsr: null}, legacy: null},
  ttsKey: 'tts-key', apiKey: '', timeoutMs: 1000};
  assert.equal(qwenCloneEndpoint(speech), 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization');
  const inputs = [];
  const fetchImpl = async (url, {body, headers}) => {
    assert.equal(headers.Authorization, 'Bearer tts-key');
    const {input} = JSON.parse(body);
    inputs.push(input);
    return Response.json({output: input.action === 'create_voice' ? {voice_id: tts + '-me-1'} : {status: 'OK', target_model: input.voice_id === 'old' ? model : tts}});
  };
  assert.deepEqual(await cloneVoice(speech, recording, {fetchImpl}), {voiceId: tts + '-me-1'});
  assert.equal(inputs[0].target_model, tts);
  assert.deepEqual(await queryVoice(speech, tts + '-me-1', {fetchImpl}), {voiceId: tts + '-me-1', status: 'OK', targetModel: tts});
  // A Realtime-bound clone (the voice already saved for Realtime) cannot be applied to the TTS model.
  await assert.rejects(queryVoice(speech, 'old', {fetchImpl}), {message: 'VOICE_CLONE_MODEL'});
});
