import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
import {transcribeAudio,recognize,resolveApi} from '../optional-extensions/speech-recognition/lib/recognize.mjs';
import {effectiveSpeechSettings} from '../optional-extensions/speech-recognition/lib/presets.mjs';
import {modelsCandidates,probeTranscription} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
import {unpackZip,packZip} from '../packages/plugin-api/zip.mjs';
import {packageFiles} from '../packages/plugin-api/catalog.mjs';
const project=path.resolve(import.meta.dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(project,'optional-extensions/speech-recognition/plugin.json'),'utf8')),defaults=manifest.settings;
const settings=(more={})=>({...defaults,endpoint:'https://gateway.invalid/team/v1',model:'tenant/recognizer-alias',apiKey:'fixture-key',...more});
const audio={b64:Buffer.from('synthetic-audio').toString('base64'),mime:'audio/wav',filename:'fixture.wav',sampleRate:16000,durationSeconds:1};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

test('raw auto settings use file transcription for every model without any host UI preparation',async()=>{
  for(const model of ['tenant/recognizer-alias','qwen-audio-3.0-asr-flash','qwen3-asr-flash','whisper-1']){
    let calls=0;const raw=settings({model}),text=await transcribeAudio(raw,audio,{fetchImpl:async(url,options)=>{calls++;assert.equal(url.href,'https://gateway.invalid/team/v1/audio/transcriptions');assert(options.body instanceof FormData);assert.equal(options.body.get('model'),model);return Response.json({text:'插件独立转写'});}});
    assert.equal(text,'插件独立转写');assert.equal(calls,1);assert.equal(raw.apiProtocol,'auto');assert.equal(raw.responsePath,'text');assert.equal(raw.requestMode,'multipart');
    assert.equal(modelsCandidates(raw)[0].pathname,'/team/v1/models');
  }
});
test('explicit Chat protocols and complete Chat addresses work with opaque aliases independently of the host',async()=>{
  for(const apiProtocol of ['auto','openai-chat','chat-audio-data-url']){
    const text=await transcribeAudio(settings({apiProtocol,endpoint:'https://gateway.invalid/team/v1/chat/completions'}),audio,{fetchImpl:async(url,options)=>{
      assert.equal(url.pathname,'/team/v1/chat/completions');const body=JSON.parse(options.body),input=body.messages[0].content[0].input_audio;
      assert.equal(input.data,apiProtocol==='chat-audio-data-url'?'data:audio/wav;base64,'+audio.b64:audio.b64);
      assert.equal(body.model,'tenant/recognizer-alias');assert.equal(body.messages[0].content[1].type,'text');return Response.json({choices:[{message:{content:'独立 Chat 转写'}}]});
    }});assert.match(text,/独立/);
  }
});
test('explicit protocols, legacy JSON/field mappings and unrecognized gateway aliases keep their existing behavior',()=>{
  const explicit=settings({apiProtocol:'openai-transcriptions'});assert.equal(resolveApi(explicit).protocol,'openai-transcriptions');
  const custom=settings({requestMode:'json',jsonTemplate:'{"clip":"{{audio_base64}}"}',responsePath:'payload.text'});assert.deepEqual(effectiveSpeechSettings(custom),custom);
  const alias=settings({model:'gateway-private-alias'});assert.deepEqual(effectiveSpeechSettings(alias),alias);
  for(const extra of [{fileField:'clip',responsePath:'result.text'},{responseMode:'text',endpoint:'https://gateway.invalid/custom/asr'}]){const mapped=settings(extra);assert.deepEqual(effectiveSpeechSettings(mapped),mapped);}
  const prepared=effectiveSpeechSettings(settings());assert.deepEqual(effectiveSpeechSettings(prepared),prepared);
});
test('conflicting protocol routes and incompatible Chat formats fail before reading voice; HTTP failures never reupload',async()=>{
  for(const extra of [{apiProtocol:'openai-chat',endpoint:'https://gateway.invalid/v1/audio/transcriptions'},{apiProtocol:'openai-chat',audioFormat:'silk'}]){
    let reads=0;const result=await recognize({config:()=>settings(extra),audio:{read(){reads++;}}},{id:'a'.repeat(64)});assert.equal(result.ok,false);assert.equal(result.stage,'configuration');assert.equal(reads,0);assert.match(result.code,/^VOICE_API_/);
  }
  let calls=0;await assert.rejects(()=>transcribeAudio(settings(),audio,{fetchImpl:async()=>{calls++;return new Response('private details',{status:404});}}),/VOICE_API_HTTP_404/);assert.equal(calls,1);
});
test('plugin-owned synthetic diagnostics use the same public protocol and make only one POST',async()=>{
  let calls=0;const result=await probeTranscription(settings(),{fetchImpl:async(url,options)=>{calls++;assert.equal(options.method,'POST');assert.equal(url.pathname,'/team/v1/audio/transcriptions');return Response.json({text:'语音识别测试'});}});assert.equal(result.verified,true);assert.equal(calls,1);
});

test('the real ZIP works on a copied unchanged host with no bundled preset module or frontend',async t=>{
  const source=process.env.WECHATAGENT_COMPAT_HOST?path.resolve(process.env.WECHATAGENT_COMPAT_HOST):project;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'speech-standalone-')),host=path.join(root,'frozen-host'),workspace=path.join(root,'workspace');
  const files=[...fs.readdirSync(path.join(source,'packages/plugin-api')).filter(name=>name.endsWith('.mjs')&&name!=='bundled.mjs').map(name=>'packages/plugin-api/'+name),'packages/extension-runtime/catalog.mjs','packages/dsh-social-bridge-plugin/deadline.mjs','components/qq-bridge/src/safe-fetch.js'];
  for(const relative of files){const target=path.join(host,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,relative),target);}
  fs.writeFileSync(path.join(host,'package.json'),'{"type":"module"}');
  const [{PluginInstaller},{PluginRuntime},catalog]=await Promise.all(['installer','index','catalog'].map(name=>import(pathToFileURL(path.join(host,'packages/plugin-api',name+'.mjs')).href)));
  const id='a'.repeat(64),chat='wechat:private:123';catalog.atomicJson(path.join(workspace,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:[]}}});
  const bytes=fs.readFileSync(path.join(project,'optional-extensions/packages/speech-recognition-'+manifest.version+'.zip')),entries=unpackZip(bytes);assert(entries.some(entry=>entry.name==='lib/presets.mjs'));
  assert(!fs.existsSync(path.join(host,'optional-extensions')));assert(!fs.existsSync(path.join(host,'public')));
  let uploads=0,expected='file';const server=http.createServer(async(req,res)=>{
    try{uploads++;assert.equal(req.headers.authorization,'Bearer fixture-key');let body='';for await(const chunk of req)body+=chunk;
      if(expected==='chat'){assert.equal(req.url,'/team/v1/chat/completions');assert.equal(JSON.parse(body).messages[0].content[0].input_audio.data,audio.b64);res.end('{"choices":[{"message":{"content":"旧宿主 Chat 成功"}}]}');}
      else if(expected==='custom'){assert.equal(req.url,'/team/private-asr');assert.equal(JSON.parse(body).clip,audio.b64);res.end('{"payload":{"text":"旧宿主自定义成功"}}');}
      else {assert.equal(req.url,'/team/v1/audio/transcriptions');assert.match(req.headers['content-type'],/multipart/);assert.match(body,/synthetic-audio/);res.end('{"text":"旧宿主文件转写成功"}');}
    }catch(error){res.statusCode=500;res.end(error.message);}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const installer=new PluginInstaller(workspace);let runtime;
  t.after(async()=>{await runtime?.dispose();installer.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  const previousSource=path.join(source,'optional-extensions/speech-recognition');
  const oldFiles=process.env.WECHATAGENT_COMPAT_HOST?packageFiles(previousSource):unpackZip(fs.readFileSync(path.join(project,'optional-extensions/packages/speech-recognition-1.3.0.zip')));
  const prior=installer.inspect({name:'previous.zip',zip:packZip(oldFiles).toString('base64')});installer.install(prior);
  catalog.updatePlugin(workspace,manifest.id,{revision:catalog.configuration(workspace).revision,enabled:true,permissions:['audio_read'],chats:[chat],settings:{endpoint:'https://gateway.invalid/team/v1',apiKey:'fixture-key',model:'tenant/recognizer-alias'}});
  runtime=new PluginRuntime({root:workspace,accountScope:'fixture-account',readAudio:async(_id,_chat,_plugin,options)=>{assert.equal(options.format,'wav');return {...audio,id};}});
  await runtime.sync();assert(runtime.list().some(item=>item.id===manifest.id&&item.loaded));
  const preview=installer.inspect({name:'speech.zip',zip:bytes.toString('base64')});assert.notEqual(preview.installedVersion,null);installer.install({...preview,replace:true});
  const upgraded=catalog.configuration(workspace).config.plugins['speech-recognition'];assert.equal(upgraded.enabled,false);assert.deepEqual(upgraded.permissions,[]);assert.deepEqual(upgraded.chats,[chat]);assert.equal(upgraded.settings.apiKey,'fixture-key');assert.equal(upgraded.settings.apiProtocol,'auto');
  const before=Object.fromEntries(files.map(relative=>[relative,hash(fs.readFileSync(path.join(host,relative)))]));
  const origin='http://127.0.0.1:'+server.address().port;

  for(const [model,kind,extra]of [['tenant/recognizer-alias','file',{}],['qwen-audio-3.0-asr-flash','file',{}],['same-alias','chat',{endpoint:origin+'/team/v1/chat/completions'}],['same-alias','custom',{apiProtocol:'custom',requestMode:'json',jsonTemplate:'{"clip":"{{audio_base64}}"}',responsePath:'payload.text',endpoint:origin+'/team/private-asr'}]]){
    expected=kind;catalog.updatePlugin(workspace,manifest.id,{revision:catalog.configuration(workspace).revision,enabled:true,permissions:['audio_read'],chats:[chat],settings:{...defaults,endpoint:origin+'/team/v1',apiKey:'fixture-key',model,...extra}});
    const result=await runtime.invokeAction(manifest.id,'transcribe',{id},{conversationKey:chat,voiceIds:[id]});assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.text,/旧宿主/);
  }
  assert.equal(uploads,4);assert.deepEqual(Object.fromEntries(files.map(relative=>[relative,hash(fs.readFileSync(path.join(host,relative)))])),before);
});
