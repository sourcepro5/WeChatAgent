import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepareSpeechSettings,inferSpeechService,modelService,QWEN_AUDIO_TEMPLATE,speechFailureHelp} from '../optional-extensions/speech-recognition/lib/presets.mjs';
import {resolveApi,requestFor,transcribeAudio} from '../optional-extensions/speech-recognition/lib/recognize.mjs';
import {modelsCandidates,sampleAudio} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
const defaults=JSON.parse(fs.readFileSync(new URL('../optional-extensions/speech-recognition/plugin.json',import.meta.url))).settings;
const config=(more={})=>({...defaults,endpoint:'https://gateway.invalid/team/v1',model:'team-audio-alias',...more});

test('guided file transcription retains gateway origin/prefix/query and passes opaque model IDs unchanged',async()=>{
  const original=config({endpoint:'https://gateway.invalid/team/v1?region=fixture',apiKey:'fixture-key'}),prepared=prepareSpeechSettings(original);
  assert.equal(original.apiProtocol,'auto');assert.equal(prepared.apiKey,original.apiKey);
  const url=resolveApi(prepared).url;assert.equal(url.origin,'https://gateway.invalid');assert.equal(url.pathname,'/team/v1/audio/transcriptions');assert.equal(url.search,'?region=fixture');
  assert.equal(modelsCandidates(prepared)[0].href,'https://gateway.invalid/team/v1/models?region=fixture');
  const {body}=requestFor(prepared,sampleAudio());
  assert(body instanceof FormData);assert.equal(body.get('model'),original.model);assert.equal(body.get('file').type,'audio/wav');
  let calls=0;const text=await transcribeAudio(prepared,sampleAudio(),{fetchImpl:async(target,options)=>{calls++;assert.equal(String(target),url.href);assert.equal(options.method,'POST');return Response.json({text:'语音识别测试'});}});
  assert.equal(text,'语音识别测试');assert.equal(calls,1);assert.equal(inferSpeechService(prepared),'auto');
});
test('protocol choices work for any model and no name selects a provider-specific adapter',()=>{
  for(const model of ['qwen3-asr-flash','whisper-1','qwen-audio-3.1-asr-flash','tenant/custom-model']){
    const chat=prepareSpeechSettings(config({model}),'chat-audio');assert.equal(chat.apiProtocol,'openai-chat');assert.match(resolveApi(chat).url.pathname,/\/team\/v1\/chat\/completions$/);
    const file=prepareSpeechSettings(config({model}),'transcriptions');assert.equal(file.apiProtocol,'openai-transcriptions');assert.match(resolveApi(file).url.pathname,/\/audio\/transcriptions$/);
    assert.equal(modelService(model),'');assert.equal(resolveApi(prepareSpeechSettings(config({model}))).protocol,'openai-transcriptions');
  }
  assert.equal(inferSpeechService(prepareSpeechSettings(config(),'chat-audio-data-url')),'chat-audio-data-url');
});
test('unknown models use the documented protocol default; discovery does not require a selected model',()=>{
  const value=config({model:'fixture-asr'});assert.equal(resolveApi(prepareSpeechSettings(value)).protocol,'openai-transcriptions');
  assert.equal(prepareSpeechSettings(value,'auto',{forModels:true}).apiProtocol,'auto');
  assert.equal(prepareSpeechSettings(value,'transcriptions').apiProtocol,'openai-transcriptions');
  assert.deepEqual(prepareSpeechSettings(config({endpoint:'',model:''}),'auto',{forModels:true}),config({endpoint:'',model:''}));
  assert.throws(()=>prepareSpeechSettings(config({model:'https://fixture.invalid'})),error=>error.field==='model');
});
test('advanced configurations and blank secrets are preserved; arbitrary gateway prefixes are accepted',()=>{
  const old=config({apiProtocol:'custom',requestMode:'json',jsonTemplate:'{"audio":"{{audio_base64}}"}',responsePath:'private.result',headersJson:'',apiKey:'',modelsEndpoint:'https://list.invalid/v1/models'});
  assert.equal(inferSpeechService(old),'advanced');assert.deepEqual(prepareSpeechSettings(old,'advanced'),old);
  assert.equal(resolveApi(prepareSpeechSettings(config({endpoint:'https://gateway.invalid/arbitrary-prefix'}))).url.pathname,'/arbitrary-prefix/audio/transcriptions');
  const credentials=new URL('https://gateway.invalid/v1');credentials.username='fixture';credentials.password='fixture';
  assert.throws(()=>prepareSpeechSettings(config({endpoint:credentials.href})),error=>error.field==='endpoint');
  const native=config({apiProtocol:'custom',requestMode:'json',jsonTemplate:QWEN_AUDIO_TEMPLATE,responsePath:'output.text',endpoint:'https://gateway.invalid/private-upload'});assert.deepEqual(prepareSpeechSettings(native,'advanced'),native);
  assert.equal(prepareSpeechSettings(config({modelsEndpoint:'https://list.invalid/models'})).modelsEndpoint,'https://list.invalid/models');
});
test('failure help still distinguishes a missing voice route from a model list',()=>{
  assert.match(speechFailureHelp('VOICE_API_HTTP_404'),/模型能列出不代表/);
});

// The interactive behaviour of ui/settings.html is exercised in a real
// sandboxed frame by the Electron probe; these checks pin its boundaries.
const pluginRoot=new URL('../optional-extensions/speech-recognition/',import.meta.url);
const page=fs.readFileSync(new URL('ui/settings.js',pluginRoot),'utf8'),schema=JSON.parse(fs.readFileSync(new URL('plugin.json',pluginRoot))).configSchema;
test('the package settings page declares only its settings actions and reaches the host solely through the SDK',()=>{
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('ui.json',pluginRoot))).settings.actions,['models','check','validate']);
  assert.deepEqual([...page.matchAll(/^import .* from '([^']+)';$/gm)].map(match=>match[1]),['./__sdk.mjs']);
  for(const forbidden of [/\bfetch\(/,/XMLHttpRequest/,/WebSocket/,/localStorage/,/innerHTML/,/postMessage/])assert(!forbidden.test(page),String(forbidden));
  assert.deepEqual([...page.matchAll(/wa\.actions\.call\('([a-z-]+)'/g)].map(match=>match[1]).sort(),['validate']);
  assert.deepEqual([...page.matchAll(/run\('([a-z-]+)'\)/g)].map(match=>match[1]).sort(),['check','models','models','models','models']);
  // Only the explicit button uploads the bundled sample; automatic refreshes read models.
  assert.equal((page.match(/run\('check'\)/g)??[]).length,1);assert.match(page,/#check-api'\)\.addEventListener\('click', \(\) => void run\('check'\)\)/);
});
test('every schema field is placed on the page and secrets are never pre-filled',()=>{
  const listed=key=>new RegExp(`'${key}'`).test(page);
  for(const key of Object.keys(schema))assert(listed(key),key);
  assert.match(page,/spec\.secret \? 'password'/);assert.match(page,/留空保留已保存值/);
});
test('the host console ships no speech-specific page, widget or diagnostics code',()=>{
  const host=new URL('../public/console/',import.meta.url);
  assert.deepEqual(fs.readdirSync(host).filter(name=>/speech|fish-notebook/.test(name)),[]);
  for(const file of ['plugins.js','plugin-config-ui.mjs','plugin-frame.mjs','console.js'])assert(!/speech|fish-notebook/i.test(fs.readFileSync(new URL(file,host),'utf8')),file);
  for(const file of ['../scripts/plugin-config-ui.mjs','../scripts/console-server.mjs'])assert(!/speech-recognition|fish-notebook|speechChecks/.test(fs.readFileSync(new URL(file,import.meta.url),'utf8')),file);
});
