import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveApi,requestFor,requestHeaders,transcribeAudio,recognize} from '../optional-extensions/speech-recognition/lib/recognize.mjs';
import {discoverModels,modelsCandidates,normalizeModels} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
import {writeVoiceAttempt,readVoiceAttempt} from '../packages/plugin-api/voice-status.mjs';
import {VoiceIngress} from '../components/qq-bridge/src/core/voice-ingress.js';

const defaults=JSON.parse(fs.readFileSync('optional-extensions/speech-recognition/plugin.json','utf8')).settings;
const config=extra=>({...defaults,endpoint:'https://asr.example.test/gateway/v1',apiProtocol:'openai-transcriptions',apiKey:'fixture-key',model:'fixture-asr',...extra});
const audio={b64:Buffer.from('synthetic').toString('base64'),mime:'audio/wav',filename:'voice.wav',sampleRate:16000,durationSeconds:1};

test('protocol routing keeps a gateway prefix, accepts a complete path, and never guesses another service',async()=>{
  const c=config();assert.equal(resolveApi(c).url.href,'https://asr.example.test/gateway/v1/audio/transcriptions');
  assert.equal(modelsCandidates(c)[0].href,'https://asr.example.test/gateway/v1/models');
  assert.equal(resolveApi(config({endpoint:c.endpoint+'/audio/transcriptions/'})).url.pathname,'/gateway/v1/audio/transcriptions/');
  assert.throws(()=>resolveApi(config({endpoint:c.endpoint+'/chat/completions'})),/PROTOCOL_MISMATCH/);
  let calls=0;const found=await discoverModels(c,{fetchImpl:async(url,options)=>{calls++;assert.equal(url.pathname,'/gateway/v1/models');assert.equal(options.headers.get('authorization'),'Bearer fixture-key');return Response.json({data:[{id:'fixture-asr'}]});}});
  assert.equal(found.ok,true);assert.equal(calls,1);
});

test('Anthropic model discovery uses native authentication and one normalized v1 prefix, without uploading audio',async()=>{
  const c=config({endpoint:'https://gateway.example.test/apps/anthropic/v1/',apiProtocol:'anthropic-messages'});
  let calls=0;const result=await discoverModels(c,{fetchImpl:async(url,options)=>{calls++;assert.equal(url.pathname,'/apps/anthropic/v1/models');assert.equal(url.searchParams.get('limit'),'1000');assert.equal(options.method,'GET');assert.equal(options.headers.get('x-api-key'),'fixture-key');assert.equal(options.headers.get('anthropic-version'),'2023-06-01');assert.equal(options.headers.has('authorization'),false);return Response.json({data:[{id:'fixture-text',inputModalities:['text']}]});}});
  assert.equal(result.ok,true);assert.equal(calls,1);
  let reads=0;const outcome=await recognize({config:()=>c,audio:{read(){reads++;}}},{id:'a'.repeat(64)});
  assert.equal(outcome.code,'VOICE_API_AUDIO_PROTOCOL_UNSUPPORTED');assert.equal(outcome.stage,'configuration');assert.equal(reads,0);
});

test('model maps preserve endpoint-facing aliases and declared text-only models never become audio candidates',()=>{
  const models=normalizeModels({models:{'alias-asr':{id:'canonical-id',inputModalities:['audio']},'asr-but-text':{input:['text']},directory:'metadata',bad:null}});
  assert.equal(models.length,2);assert(models.some(item=>item.id==='alias-asr'&&item.audioCandidate));assert.equal(models.find(item=>item.id==='asr-but-text').audioCandidate,false);
  assert(!models.some(item=>item.id==='canonical-id'));
});

test('standard Chat audio protocols build the documented payload styles and accept structured text responses',async()=>{
  for(const protocol of ['openai-chat','chat-audio-data-url']){
    const c=config({apiProtocol:protocol,extraFieldsJson:'{"temperature":0}'}),request=requestFor(c,audio),body=JSON.parse(request.body),input=body.messages[0].content[0].input_audio;
    assert.equal(body.stream,false);assert.equal(body.model,'fixture-asr');assert.equal(body.temperature,0);
    if(protocol==='openai-chat'){assert.equal(input.data,audio.b64);assert.equal(input.format,'wav');}
    else assert.equal(input.data,'data:audio/wav;base64,'+audio.b64);
    assert.equal(await transcribeAudio(c,audio,{fetchImpl:async(url)=>{assert.equal(url.pathname,'/gateway/v1/chat/completions');return Response.json({choices:[{message:{content:[{type:'reasoning',text:'hidden'},{type:'text',text:'转写成功'}]}}]});}}),'转写成功');
  }
});

test('empty models and malformed credentials are rejected before private audio is prepared; custom requests remain compatible',async()=>{
  for(const c of [config({model:''}),config({apiKey:'密钥'}),config({apiKey:'fixture\nkey'}),config({apiProtocol:'openai-chat',audioFormat:'silk'})]){
    let reads=0;const result=await recognize({config:()=>c,audio:{read(){reads++;}}},{id:'a'.repeat(64)});assert.equal(reads,0);assert.equal(result.stage,'configuration');
  }
  assert.equal(requestHeaders(config({apiKey:'  fixture-key  '})).get('authorization'),'Bearer fixture-key');
  const custom=config({apiProtocol:'custom',endpoint:'https://example.test/custom/asr',model:'',requestMode:'json',jsonTemplate:'{"audio":"{{audio_base64}}"}'});
  assert.equal(resolveApi(custom).url.pathname,'/custom/asr');assert.equal(JSON.parse(requestFor(custom,audio).body).audio,audio.b64);
  const legacy=config({apiProtocol:'auto',endpoint:'https://example.test/v1/audio/transcriptions',fileField:'clip',responsePath:'payload.text'});
  assert.equal(resolveApi(legacy).protocol,'custom');assert.equal(requestFor(legacy,audio).body.has('clip'),true);
});

test('HTTP failure never retries an upload under another protocol and retains the failing stage',async()=>{
  let calls=0;await assert.rejects(()=>transcribeAudio(config(),audio,{fetchImpl:async()=>{calls++;return new Response('private provider body',{status:403});}}),/VOICE_API_HTTP_403/);assert.equal(calls,1);
});

test('auto uses address structure for arbitrary model aliases and retains gateway query parameters',async()=>{
  for(const model of ['customer/audio-v2','qwen-audio-3.1-asr-flash','whisper-1','gpt-4o-transcribe','model-with-no-audio-keyword']){
    const c=config({apiProtocol:'auto',endpoint:'https://asr.example.test/tenant/proxy?api-version=fixture',model});
    assert.equal(resolveApi(c).url.href,'https://asr.example.test/tenant/proxy/audio/transcriptions?api-version=fixture');
    assert.equal(modelsCandidates(c)[0].href,'https://asr.example.test/tenant/proxy/models?api-version=fixture');
    assert.equal(requestFor(c,audio).body.get('model'),model);
    const chat={...c,endpoint:'https://asr.example.test/tenant/proxy/chat/completions'};
    assert.equal(resolveApi(chat).protocol,'openai-chat');assert.equal(JSON.parse(requestFor(chat,audio).body).model,model);
  }
  const c=config({apiProtocol:'anthropic-messages',endpoint:'https://asr.example.test/tenant/v1?region=fixture'});
  assert.equal(modelsCandidates(c)[0].search,'?region=fixture&limit=1000');
  const pasted=config({apiProtocol:'auto',endpoint:'  https://asr.example.test/v1  ',model:'  tenant/opaque-alias  '});
  assert.equal(requestFor(pasted,audio).body.get('model'),'tenant/opaque-alias');assert.equal(pasted.model,'  tenant/opaque-alias  ');
});

test('directory aliases without capability metadata stay selectable without claiming audio support',()=>{
  const list=normalizeModels({models:{'tenant/alias':{id:'upstream-canonical-id'},'declared-text':{input:['text']},'declared-socket':{transport:'websocket'}}});
  assert.equal(list.find(item=>item.id==='tenant/alias').audioCandidate,true);
  assert.equal(list.find(item=>item.id==='tenant/alias').audioDeclared,null);
  assert.equal(list.find(item=>item.id==='declared-text').audioCandidate,false);
  assert.equal(list.find(item=>item.id==='declared-socket').audioCandidate,false);
  assert(!list.some(item=>item.id==='upstream-canonical-id'));
});

test('pasted credential wrappers and malformed request parameters fail before audio is read',async()=>{
  for(const extra of [
    {apiKey:'Bearer fixture-key'},{apiKey:'"fixture-key"'},{apiKey:"'fixture-key'"},{apiKey:'SERVICE_API_KEY=fixture-key'},
    {extraFieldsJson:'not-json'},{apiProtocol:'openai-chat',extraFieldsJson:'{"messages":[]}'},
    {apiProtocol:'custom',requestMode:'json',jsonTemplate:'{"clip":"{{audio_base64}}","bad":"{{unknown}}"}'},
  ]){
    let reads=0;const result=await recognize({config:()=>config(extra),audio:{read(){reads++;}}},{id:'a'.repeat(64)});
    assert.equal(result.ok,false);assert.equal(result.stage,'configuration');assert.equal(reads,0);
  }
  assert.equal(requestHeaders(config({apiKey:'YWJjZA=='})).get('authorization'),'Bearer YWJjZA==');
});

test('legacy auto JSON, text responses and field mappings retain their exact custom endpoints',()=>{
  for(const extra of [{requestMode:'json'},{responseMode:'text'},{fileField:'clip'},{modelField:'alias'},{languageField:'locale'},{responsePath:'payload.text'},{responsePath:''}]){
    const c=config({apiProtocol:'auto',endpoint:'https://asr.example.test/private-upload',...extra});
    assert.equal(resolveApi(c).protocol,'custom');assert.equal(resolveApi(c).url.pathname,'/private-upload');
  }
  const mapped=config({apiProtocol:'auto',endpoint:'https://asr.example.test/v1/messages',requestMode:'json'});
  assert.equal(resolveApi(mapped).protocol,'custom');assert.equal(resolveApi(mapped).url.pathname,'/v1/messages');
});

test('runtime diagnostics only store bounded metadata for the current settings generation',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-status-'));t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  writeVoiceAttempt(root,'voice-fixture',{ok:false,code:'VOICE_API_HTTP_403',stage:'api',text:'private transcript',apiKey:'private key'},'fixture-generation');
  const result=readVoiceAttempt(root,'voice-fixture','fixture-generation');assert.equal(result.code,'VOICE_API_HTTP_403');assert.equal(readVoiceAttempt(root,'voice-fixture','new-generation'),null);
  assert.equal(readVoiceAttempt(root,'other-plugin','fixture-generation'),null);writeVoiceAttempt(root,'../escape',{ok:true},'fixture-generation');assert(!fs.existsSync(path.join(root,'state/plugin-service-checks/escape.json')));
  const raw=fs.readFileSync(path.join(root,'state/plugin-service-checks/voice-input/voice-fixture.json'),'utf8');assert(!raw.includes('private'));assert(!raw.includes('transcript'));
});

const voice=id=>({platform:'wechat',kind:'private',conversation_id:id,message_id:id,text:'[语音]',voice:{id:'a'.repeat(64),durationSeconds:1}});
test('three simultaneous chats wait for two recognition slots rather than dropping the third voice',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let calls=0,active=0,max=0;const delivered=[];
  const ingress=new VoiceIngress({recognize:async()=>{calls++;active++;max=Math.max(max,active);await gate;active--;return {ok:true,text:'测试'};},deliver:message=>delivered.push(message)});
  const pending=['1','2','3'].map(id=>ingress.push(voice(id)));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);release();await Promise.all(pending);assert.equal(calls,3);assert.equal(max,2);assert.equal(delivered.length,3);assert(delivered.every(item=>item.text.includes('语音转写')));ingress.stop();
});

test('a failed voice is reported as received and preserves a safe error code in diagnostics and fallback text',async()=>{
  let diagnostic,delivered;const ingress=new VoiceIngress({generationFor:message=>'fixture-generation:'+message.conversation_id,recognize:async()=>({ok:false,code:'VOICE_API_HTTP_403',stage:'api',plugin:'voice-fixture'}),onResult:(_message,result,generation)=>{diagnostic={...result,generation};},deliver:message=>{delivered=message;}});
  await ingress.push(voice('1'));assert.equal(diagnostic.generation,'fixture-generation:1');assert.equal(diagnostic.plugin,'voice-fixture');assert.equal(diagnostic.code,'VOICE_API_HTTP_403');assert.match(delivered.text,/语音消息已收到/);assert.match(delivered.text,/VOICE_API_HTTP_403/);ingress.stop();
});

test('stopping the bridge wakes queued recognition slots and prevents new uploads or deliveries',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let calls=0,delivered=0;
  const ingress=new VoiceIngress({recognize:async()=>{calls++;await gate;return {ok:true,text:'discarded'};},deliver:()=>{delivered++;}});
  const pending=['1','2','3'].map(id=>ingress.push(voice(id)));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  ingress.stop();release();await Promise.all(pending);assert.equal(calls,2);assert.equal(delivered,0);assert.equal(ingress.active,0);
});
