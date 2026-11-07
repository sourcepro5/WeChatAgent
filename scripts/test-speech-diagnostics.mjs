import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {discoverModels,normalizeModels,modelsCandidates,inspectConfiguration,probeTranscription,sampleAudio,EXPECTED_SAMPLE} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
import {createSettingsActions} from '../optional-extensions/speech-recognition/lib/settings-actions.mjs';
import {configuration,updatePlugin,atomicJson,packageFiles} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {createConsole} from './console-server.mjs';

const source=path.resolve('optional-extensions/speech-recognition'),defaults=JSON.parse(fs.readFileSync(path.join(source,'plugin.json'))).settings;
const config=extra=>({...defaults,endpoint:'https://asr.example.test/v1/audio/transcriptions',model:'fixture-asr',apiKey:'fixture-secret-key',...extra});
const capability=async()=>({checked:true,decoder:true});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'speech-diagnostics-'));t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  atomicJson(path.join(root,'config/wechatagent.json'),{runtime:{python:'fixture-python'},wechat:{whitelist:{private:['123'],groups:[]}}});
  const installer=new PluginInstaller(root),preview=installer.inspect({name:'speech.zip',zip:packZip(packageFiles(source)).toString('base64')});installer.install(preview);installer.dispose();
  const save=settings=>updatePlugin(root,'speech-recognition',{revision:configuration(root).revision,enabled:false,permissions:[],chats:[],settings});save(config());
  return {root,save,body:(extra={})=>({revision:configuration(root).revision,settings:{...config(),...extra}})};
}

test('model discovery derives standard same-service paths and respects a fully custom list endpoint',()=>{
  assert.equal(modelsCandidates(config())[0].href,'https://asr.example.test/v1/models');
  assert.equal(modelsCandidates(config({endpoint:'https://gateway.example.test/prefix/chat/completions'}))[0].pathname,'/prefix/models');
  assert.equal(modelsCandidates(config({endpoint:'https://gateway.example.test/apps/proxy'}))[0].pathname,'/apps/proxy/models');
  assert.deepEqual(modelsCandidates(config({modelsEndpoint:'https://catalog.example.test/custom/list'})).map(url=>url.href),['https://catalog.example.test/custom/list']);
});

test('model lists handle custom JSON paths, deduplicate IDs, mark audio candidates and reject unsafe IDs',()=>{
  const models=normalizeModels({result:{items:[{id:'fixture-chat',input_modalities:['text']},{id:'custom-audio',input_modalities:['audio']},{id:'whisper-fixture'},{id:'custom-audio'},'manual-model',{id:'bad"id'},{id:'https://not-a-model.example'}]}},'result.items');
  assert.equal(models.length,4);assert.equal(models.find(item=>item.id==='custom-audio').audioDeclared,true);assert.equal(models.find(item=>item.id==='fixture-chat').audioDeclared,false);assert.equal(models.find(item=>item.id==='whisper-fixture').audioCandidate,true);
  assert.throws(()=>normalizeModels({models:'not an array or model map'}),/VOICE_MODELS_RESPONSE_INVALID/);
});

test('discovery carries configured auth, never follows redirects and treats missing model APIs as optional',async()=>{
  let calls=0;const result=await discoverModels(config({authHeader:'X-API-Key',authPrefix:''}),{fetchImpl:async(_url,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.get('X-API-Key'),'fixture-secret-key');return Response.json({data:[{id:'fixture-asr'}]});}});
  assert.equal(result.ok,true);assert.equal(calls,1);
  const missing=await discoverModels(config(),{fetchImpl:async()=>new Response('',{status:404})});assert.equal(missing.code,'VOICE_MODELS_UNSUPPORTED');
  const denied=await discoverModels(config(),{fetchImpl:async()=>new Response('fixture-secret-key must never echo',{status:401})});assert.equal(denied.code,'VOICE_API_HTTP_401');assert(!JSON.stringify(denied).includes('fixture-secret-key'));
});

test('discovery has a total timeout, validates model-array shape and bounds responses',async()=>{
  const timed=await discoverModels(config({timeoutMs:30}),{fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});assert.equal(timed.code,'VOICE_API_TIMEOUT');
  const huge=await discoverModels(config(),{fetchImpl:async()=>new Response('x'.repeat(513*1024))});assert.equal(huge.code,'VOICE_API_RESPONSE_TOO_LARGE');
});

test('configuration checks catch a model URL, missing JSON audio mapping and missing WAV conversion before upload',()=>{
  const wrong=inspectConfiguration(config({model:'https://example.test/model'}),{checked:true,decoder:false});assert.equal(wrong.configurationValid,false);assert.equal(wrong.checks[0].code,'VOICE_MODEL_IS_URL');assert.equal(wrong.decoderReady,false);
  const badTemplate=inspectConfiguration(config({requestMode:'json',jsonTemplate:'{"model":"{{model}}"}'}),{checked:true,decoder:true});assert.equal(badTemplate.configurationValid,false);assert.equal(badTemplate.checks[0].code,'VOICE_API_TEMPLATE_AUDIO_MISSING');
  assert.equal(inspectConfiguration(config({audioFormat:'silk'}),{checked:true,decoder:false}).decoderReady,true);
  assert.equal(inspectConfiguration(config({endpoint:'bad-url'}),{checked:true,decoder:true}).configurationValid,false);
});

test('transport metadata controls candidates while model names do not imply a wire protocol',()=>{
  const models=normalizeModels({data:[{id:'fixture-asr-realtime',input_modalities:['audio'],transport:'websocket'},{id:'fixture-asr-flash-message',transport:'websocket'},{id:'custom-asr',transport:'websocket'},{id:'fixture-asr-http',protocol:'https'}]});
  assert.equal(models.filter(model=>model.audioCandidate).length,1);assert.equal(models[0].id,'fixture-asr-http');
  assert(models.filter(model=>model.transportHint==='websocket').every(model=>!model.audioCandidate));
  const report=inspectConfiguration(config({model:'fixture-asr-flash-message'}),{checked:true,decoder:true},models);
  assert.equal(report.checks.find(item=>item.id==='model-transport').state,'warning');
  assert.equal(inspectConfiguration(config({model:'custom-asr'}),{checked:true,decoder:true},models).checks.find(item=>item.id==='model-transport').state,'warning');
  assert.equal(normalizeModels({data:[{id:'fixture-realtime-alias'}]})[0].audioCandidate,true);
  assert.equal(inspectConfiguration(config({endpoint:'https://asr.example.test/v1/chat/completions'})).checks.find(item=>item.id==='request-protocol').state,'warning');
});

test('a SILK-only API rejecting the bundled WAV is reported as inconclusive rather than verified',async()=>{
  const probe=await probeTranscription(config({audioFormat:'silk'}),{fetchImpl:async()=>new Response('',{status:415})});
  assert.equal(probe.verified,false);assert.equal(probe.inconclusive,true);assert.match(probe.message,/SILK/);
});

test('API test uses the bundled synthetic WAV and only verifies a matching transcript',async()=>{
  const audio=sampleAudio();assert.equal(Buffer.from(audio.b64,'base64').toString('ascii',0,4),'RIFF');assert(audio.durationSeconds>0&&audio.durationSeconds<5);
  const good=await probeTranscription(config(),{fetchImpl:async(_url,options)=>{assert.equal(options.method,'POST');assert.equal(options.body.get('file').name,'config-test.wav');return Response.json({text:'你好，这是'+EXPECTED_SAMPLE+'。'});}});assert.equal(good.verified,true);
  const unrelated=await probeTranscription(config(),{fetchImpl:async()=>Response.json({text:'我无法处理音频，请输入文字。'})});assert.equal(unrelated.ok,true);assert.equal(unrelated.verified,false);
  const empty=await probeTranscription(config(),{fetchImpl:async()=>Response.json({text:''})});assert.equal(empty.ok,false);
});

const schema=JSON.parse(fs.readFileSync(path.join(source,'plugin.json'))).configSchema;
const saved=config({headersJson:'{}'});
const run=async(kind,draft,{fetchImpl,decoder={checked:true,decoder:true}}={})=>createSettingsActions(schema,{fetchImpl,now:()=>1000})[kind]({settings:saved,signal:new AbortController().signal},{settings:draft,decoder});

test('reading models never uploads audio; a blank secret uses the saved one and results never echo credentials',async()=>{
  let posts=0,auth;const fetchImpl=async(_url,options)=>{auth=options.headers.get('Authorization');if(options.method==='POST')posts++;return Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'你好，这是语音识别测试。'});};
  const models=await run('models',{...saved,apiKey:'',headersJson:''},{fetchImpl});assert.equal(models.models.ok,true);assert.equal(models.summary.ready,false);assert.equal(posts,0);assert.equal(auth,'Bearer fixture-secret-key');
  const checked=await run('check',{...saved,apiKey:'',headersJson:''},{fetchImpl});assert.equal(posts,1);assert.equal(checked.summary.ready,true);assert.equal(checked.probe.testedAt,1000);assert(!JSON.stringify(checked).includes('fixture-secret-key'));
  const typed=await run('models',{...saved,apiKey:'typed-fixture-key'},{fetchImpl});assert.equal(auth,'Bearer typed-fixture-key');assert(!JSON.stringify(typed).includes('typed-fixture-key'));
});

test('missing conversion stays not-ready even when the remote WAV test works; unsupported lists allow manual models',async()=>{
  const fetchImpl=async(_url,options)=>options.method==='GET'?new Response('',{status:404}):Response.json({text:'语音识别测试'});
  const missing=await run('check',saved,{fetchImpl,decoder:{checked:true,decoder:false}});assert.equal(missing.probe.verified,true);assert.equal(missing.summary.ready,false);assert.equal(missing.summary.label,'转换组件未就绪');
  const manual=await run('check',saved,{fetchImpl});assert.equal(manual.models.code,'VOICE_MODELS_UNSUPPORTED');assert.equal(manual.summary.ready,true);
});

test('wrong model settings block the test call and the enable-time validation, offline',async()=>{
  let calls=0,posts=0;const fetchImpl=async(_url,options)=>{calls++;if(options.method==='POST')posts++;return Response.json({data:[]});};
  const draft={...saved,model:'https://wrong.example/model'},result=await run('check',draft,{fetchImpl});assert.equal(posts,0);assert.equal(result.summary.ready,false);assert.equal(result.summary.label,'配置有误');
  const before=calls,check=await run('validate',draft,{fetchImpl});assert.equal(calls,before);assert.equal(check.ok,false);assert.match(check.message,/模型名填写了网址/);
  assert.deepEqual(await run('validate',saved,{fetchImpl}),{ok:true});
});

test('every run reflects the current credentials; a new authorization failure removes green readiness',async()=>{
  let denied=false;const fetchImpl=async(_url,options)=>denied?new Response('',{status:401}):Response.json(options.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'语音识别测试'});
  assert.equal((await run('check',saved,{fetchImpl})).summary.ready,true);denied=true;
  const refreshed=await run('models',saved,{fetchImpl});assert.equal(refreshed.models.code,'VOICE_API_HTTP_401');assert.equal(refreshed.summary.ready,false);
  const failed=await run('check',saved,{fetchImpl});assert.equal(failed.summary.state,'error');assert.match(failed.summary.message,/密钥/);
});

test('console settings actions need the token and the page declaration, run unsaved values without enabling, and old speech routes are gone',async t=>{
  const f=fixture(t),full=JSON.parse(fs.readFileSync('config/wechatagent.example.json'));full.wechat.whitelist={private:['123'],groups:[]};atomicJson(path.join(f.root,'config/wechatagent.json'),full);fs.mkdirSync(path.join(f.root,'roles'));fs.writeFileSync(path.join(f.root,'roles',full.persona.default+'.md'),'Fixture persona');
  const marker=path.join(f.root,'entry-executed');fs.appendFileSync(path.join(f.root,'plugins/speech-recognition/index.mjs'),`\nimport markerFs from 'node:fs';markerFs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const seen=[],service=http.createServer((req,res)=>{seen.push(req.method);req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='POST'?{text:'语音识别测试'}:{data:[{id:'fixture-asr'}]}));});});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));t.after(()=>service.close());
  const app=createConsole({root:f.root,port:0,voiceCapabilities:capability,fetchImpl:async()=>{throw Error('NO_REMOTE');}});t.after(()=>app.close());const addr=await app.start(),base='http://127.0.0.1:'+addr.port,{token}=await fetch(base+'/api/info').then(r=>r.json());
  const catalog=await fetch(base+'/api/plugins',{headers:{'X-Console-Token':token}}).then(r=>r.json()),item=catalog.plugins[0];assert.equal(fs.existsSync(marker),false,'listing never runs plugin code');
  const url=base+'/api/plugins/speech-recognition/settings-actions/models',body={packageRevision:item.revision,args:{settings:{...config(),endpoint:'http://127.0.0.1:'+service.address().port+'/v1'}}};
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);assert.deepEqual(seen,[]);assert.equal(fs.existsSync(marker),false);
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','X-Console-Token':token},body:JSON.stringify(body)});assert.equal(response.status,200);const listed=await response.json();assert.equal(listed.models.ok,true,JSON.stringify(listed.models));assert.equal(listed.models.models[0].id,'fixture-asr');assert.deepEqual(seen,['GET']);
  assert.equal(fs.existsSync(marker),true);assert.equal(configuration(f.root).config.plugins['speech-recognition'].enabled,false);
  const host=await fetch(base+'/api/plugins/speech-recognition/host-status',{headers:{'X-Console-Token':token}}).then(r=>r.json());assert.deepEqual(host.voice,{decoder:{checked:true,decoder:true},lastAttempt:null});
  for(const route of ['/api/plugins/speech-recognition/models','/api/plugins/speech-recognition/check'])assert.notEqual((await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','X-Console-Token':token},body:JSON.stringify({revision:catalog.revision,settings:config()})})).status,200,route);
  for(const route of ['/speech-settings.mjs','/speech-setup.mjs','/optional-extensions/speech-recognition/lib/presets.mjs'])assert.equal((await fetch(base+route)).status,404,route);
});
