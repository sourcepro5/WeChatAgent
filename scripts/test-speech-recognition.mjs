import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {recognize,requestFor,endpointUrl,responseText} from '../optional-extensions/speech-recognition/lib/recognize.mjs';
import {inspectPackage,packageFiles,configuration,updatePlugin,atomicJson,pluginCatalog} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {PluginRuntime} from '../packages/plugin-api/index.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {createAudioReader} from '../packages/plugin-api/audio.mjs';
import {VoiceIngress} from '../components/qq-bridge/src/core/voice-ingress.js';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';

const source=path.resolve('optional-extensions/speech-recognition'),manifest=inspectPackage(source),defaults=manifest.settings;
const id='a'.repeat(64),key='wechat:private:123',other='wechat:group:456';
const audio={id,b64:Buffer.from('synthetic-audio').toString('base64'),mime:'audio/wav',filename:'voice.wav',sampleRate:16000,durationSeconds:2};
function context(config={},read=async()=>audio){return {account:{id:'fixture'},chat:{key},signal:new AbortController().signal,config:()=>({...defaults,apiProtocol:'custom',...config}),audio:{read}};}
async function server(t,handler){const s=http.createServer((req,res)=>void Promise.resolve(handler(req,res)).catch(error=>{res.writeHead(500);res.end(error.message);}));await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>{s.closeAllConnections();s.close();});return 'http://127.0.0.1:'+s.address().port+'/custom/asr';}

test('package declares scoped audio permission and ships no endpoint, credential, model or dependencies',()=>{
  assert.deepEqual(manifest.permissions,['audio_read']);assert(manifest.requiresHostFeatures.includes('voice-input-v1'));
  assert.equal(defaults.endpoint,'');assert.equal(defaults.apiKey,'');assert.equal(defaults.model,'');
  assert(packageFiles(source).every(file=>!file.name.includes('node_modules')));
});

test('empty endpoint fails before reading or uploading voice',async()=>{
  let reads=0;const result=await recognize(context({},()=>{reads++;throw Error('must not read');}),{id});
  assert.equal(result.code,'VOICE_API_NOT_CONFIGURED');assert.equal(reads,0);
});

test('multipart calls the configured complete endpoint with custom fields and auth, and caches by account/chat/config',async t=>{
  let calls=0,reads=0;
  const endpoint=await server(t,async(req,res)=>{calls++;assert.equal(req.url,'/custom/asr');assert.equal(req.headers['x-api-key'],'fixture-secret');assert.match(req.headers['content-type'],/multipart\/form-data; boundary=/);let body='';for await(const chunk of req)body+=chunk;
    assert(body.includes('name="clip"'));assert(body.includes('synthetic-audio'));assert(body.includes('fixture-model'));assert(body.includes('name="tag"'));res.end(JSON.stringify({payload:{transcript:'周五一起吃饭'}}));});
  const ctx=context({endpoint,apiKey:'fixture-secret',authHeader:'X-API-Key',authPrefix:'',fileField:'clip',model:'fixture-model',extraFieldsJson:'{"tag":"test"}',responsePath:'payload.transcript'},async()=>{reads++;return audio;});
  assert.equal((await recognize(ctx,{id})).text,'周五一起吃饭');assert.equal((await recognize(ctx,{id})).cached,true);assert.equal(calls,1);assert.equal(reads,1);
});

test('JSON templates preserve nested structure, escaping and numeric placeholders; plain responses are supported',async t=>{
  const endpoint=await server(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    assert.equal(body.input.audio,audio.b64);assert.equal(body.rate,16000);assert.equal(body.size,Buffer.from(audio.b64,'base64').length);assert.equal(body.model,'name"with\\escapes');assert.equal(req.headers['x-custom'],'fixture');res.end('你好，测试成功');});
  const result=await recognize(context({endpoint,model:'name"with\\escapes',requestMode:'json',headersJson:'{"X-Custom":"fixture"}',jsonTemplate:'{"input":{"audio":"{{audio_base64}}"},"rate":"{{sample_rate}}","size":"{{audio_bytes}}","model":"{{model}}"}',responseMode:'text'}),{id});
  assert.equal(result.text,'你好，测试成功');
});

test('HTTP errors never echo provider bodies or credentials; redirects are not followed',async t=>{
  let targetCalls=0;const target=await server(t,(_req,res)=>{targetCalls++;res.end('secret');});
  const endpoint=await server(t,(_req,res)=>{res.writeHead(401);res.end('fixture-secret and private provider details');});
  const result=await recognize(context({endpoint,apiKey:'fixture-secret'}),{id});assert.deepEqual(result,{ok:false,code:'VOICE_API_HTTP_401',stage:'api'});
  const redirect=await server(t,(_req,res)=>{res.writeHead(307,{location:target});res.end();});assert.equal((await recognize(context({endpoint:redirect}),{id})).ok,false);assert.equal(targetCalls,0);
});

test('API deadlines and response bounds return controlled failures',async t=>{
  const stalled=await server(t,()=>{});assert.equal((await recognize(context({endpoint:stalled,timeoutMs:1000}),{id})).code,'VOICE_API_TIMEOUT');
  const huge=await server(t,(_req,res)=>res.end('x'.repeat(70000)));assert.equal((await recognize(context({endpoint:huge,responseMode:'text'}),{id})).code,'VOICE_API_RESPONSE_TOO_LARGE');
  const blank=await server(t,(_req,res)=>res.end('{"text":""}'));assert.equal((await recognize(context({endpoint:blank}),{id})).code,'VOICE_API_EMPTY_TRANSCRIPT');
});

test('templates, paths and headers reject ambiguity without evaluating code',()=>{
  const credentialUrl=new URL('https://example.com/asr');credentialUrl.username='fixture';credentialUrl.password='fixture';
  assert.throws(()=>endpointUrl('http://example.com/asr'));assert.throws(()=>endpointUrl(credentialUrl.href));assert.equal(endpointUrl('http://127.0.0.1:9999/asr').pathname,'/asr');
  assert.throws(()=>requestFor({...defaults,requestMode:'json',jsonTemplate:'{"x":"{{unknown}}"}'},audio));assert.throws(()=>requestFor({...defaults,headersJson:'{"Host":"evil"}'},audio));assert.throws(()=>requestFor({...defaults,jsonTemplate:'{"__proto__":{}}',requestMode:'json'},audio));
  assert.equal(responseText({result:[{text:'hello'}]},'result.0.text'),'hello');assert.throws(()=>responseText({},'constructor.name'));
});

test('runtime only allows a bound voice in the current authorized chat; revocation discards prepared bytes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-plugin-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5}));
  atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:['456']}}});const installer=new PluginInstaller(root);t.after(()=>installer.dispose());
  const zip=packZip([{name:'plugin.json',data:JSON.stringify({...JSON.parse(fs.readFileSync(path.join(source,'plugin.json'),'utf8')),id:'audio-fixture',settings:{},configSchema:{},requiresHostFeatures:['voice-input-v1']})},{name:'index.mjs',data:`export function setup(api){api.registerAction({id:'read',description:'fixture',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},async execute(ctx,args){const a=await ctx.audio.read(args.id);return {text:a.filename};}});}`}]);
  const preview=installer.inspect({name:'fixture.zip',zip:zip.toString('base64')});installer.install(preview);
  const grant=enabled=>updatePlugin(root,'audio-fixture',{revision:configuration(root).revision,enabled,permissions:['audio_read'],chats:[key],settings:{}});grant(true);
  let reads=0,revoke=false;const runtime=new PluginRuntime({root,accountScope:'fixture-account',readAudio:async()=>{reads++;if(revoke)grant(false);return audio;}});t.after(()=>runtime.dispose());await runtime.sync();
  await assert.rejects(()=>runtime.invokeAction('audio-fixture','read',{id},{conversationKey:key}),/VOICE_REFERENCE_NOT_ALLOWED/);assert.equal(reads,0);
  assert.deepEqual(await runtime.invokeAction('audio-fixture','read',{id},{conversationKey:other,voiceIds:[id]}),{handled:false});
  assert.equal((await runtime.invokeAction('audio-fixture','read',{id},{conversationKey:key,voiceIds:[id]})).text,'voice.wav');revoke=true;
  await assert.rejects(()=>runtime.invokeAction('audio-fixture','read',{id},{conversationKey:key,voiceIds:[id]}),/PLUGIN_PERMISSION_DENIED/);
});

test('audio reader verifies chat binding and SHA256 instead of trusting reader fields',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-reader-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));atomicJson(path.join(root,'state/wechat-io-config.json'),{reader_base_url:'http://127.0.0.1:9999',reader_token:'fixture'});
  const body={...audio,conversationKey:key,sha256:crypto.createHash('sha256').update(Buffer.from(audio.b64,'base64')).digest('hex')};
  const reader=createAudioReader(root,{fetchImpl:async(_url,options)=>{assert.equal(options.headers.Authorization,'Bearer fixture');return Response.json(body);}});
  assert.equal((await reader(id,key,'speech-recognition')).filename,'voice.wav');body.conversationKey=other;await assert.rejects(()=>reader(id,key,'speech-recognition'),/VOICE_CONVERSATION_MISMATCH/);body.conversationKey=key;body.sha256='0'.repeat(64);await assert.rejects(()=>reader(id,key,'speech-recognition'),/VOICE_INTEGRITY_FAILED/);
});

test('the actual ZIP runs in its isolated worker and only uploads its bound synthetic audio to the configured API',async t=>{
  let uploads=0;const endpoint=await server(t,async(req,res)=>{uploads++;assert.equal(req.headers.authorization,'Bearer secret-only-in-settings');let bytes=0;for await(const chunk of req)bytes+=chunk.length;assert(bytes>10);res.end('{"text":"真实插件子进程的模拟转写"}');});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-actual-plugin-'));
  atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:[]}}});
  const installer=new PluginInstaller(root),preview=installer.inspect({name:'speech.zip',zip:packZip(packageFiles(source)).toString('base64')});installer.install(preview);
  updatePlugin(root,manifest.id,{revision:configuration(root).revision,enabled:true,permissions:['audio_read'],chats:[key],settings:{...defaults,apiProtocol:'custom',endpoint,apiKey:'secret-only-in-settings'}});
  assert(!JSON.stringify(pluginCatalog(root)).includes('secret-only-in-settings'));
  const runtime=new PluginRuntime({root,accountScope:'fixture-account',readAudio:async(voiceId,chat,plugin)=>{assert.equal(voiceId,id);assert.equal(chat,key);assert.equal(plugin,manifest.id);return audio;}});
  t.after(async()=>{await runtime.dispose();installer.dispose();fs.rmSync(root,{recursive:true,force:true,maxRetries:5});});
  assert.equal((await runtime.invokeAction(manifest.id,'transcribe',{id},{conversationKey:key,voiceIds:[id]})).text,'真实插件子进程的模拟转写');assert.equal(uploads,1);
});

const message=(message_id,voice=false,conversation_id='123')=>({platform:'wechat',kind:'private',conversation_id,message_id,text:voice?'[语音]':'随后发出的文字',...(voice?{voice:{id,durationSeconds:2}}:{})});
test('voice preprocessing keeps per-chat ordering and deduplicates in-flight uploads',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),delivered=[];let calls=0;
  const ingress=new VoiceIngress({recognize:async()=>{calls++;await gate;return {ok:true,text:'转写内容'};},deliver:msg=>delivered.push(msg)});
  const first=ingress.push(message('one',true)),duplicate=ingress.push(message('one',true)),next=ingress.push(message('two')),otherChat=ingress.push(message('three',false,'456'));await otherChat;assert.equal(delivered[0].message_id,'three');release();await Promise.all([first,duplicate,next]);assert.equal(calls,1);assert.deepEqual(delivered.map(msg=>msg.message_id),['three','one','two']);assert.match(delivered[1].text,/语音转写.*转写内容/);ingress.stop();
});

test('disabled or failed recognition retains a truthful placeholder and later text continues',async()=>{
  const delivered=[];let calls=0;const ingress=new VoiceIngress({canRecognize:()=>false,recognize:()=>{calls++;},deliver:msg=>delivered.push(msg)});
  await ingress.push(message('one',true));await ingress.push(message('two'));assert.equal(calls,0);assert.match(delivered[0].text,/未提供语音内容/);assert.equal(delivered[1].text,'随后发出的文字');ingress.stop();
});

test('asynchronous permission checks cannot exceed the two-upload concurrency limit and stopping discards results',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let active=0,peak=0;const delivered=[];
  const ingress=new VoiceIngress({canRecognize:async()=>true,recognize:async()=>{active++;peak=Math.max(peak,active);await gate;active--;return {ok:true,text:'ok'};},deliver:msg=>delivered.push(msg)});
  const jobs=Array.from({length:5},(_,i)=>ingress.push(message('voice-'+i,true,String(100+i))));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(peak,2);ingress.stop();release();await Promise.all(jobs);assert.equal(delivered.filter(msg=>msg.text.includes('语音转写')).length,0);
});

test('normalization admits only bounded reader references, never arbitrary audio URLs',()=>{
  const event={message_type:'private',user_id:123,self_id:99,message:[{type:'text',data:{text:'[语音]'}},{type:'record',data:{voice_id:id,file:'wechatagent://voice/'+id,duration:2}}]};
  assert.equal(normalizeOneBotEvent('wechat','wechat-onebot',event).voice.id,id);event.message[1].data.file='https://example.com/private-audio';assert.equal(normalizeOneBotEvent('wechat','wechat-onebot',event).voice,undefined);
});
