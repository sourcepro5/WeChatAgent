import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {API_VERSION,HOST_RUNTIME,HOST_FEATURES,PERMISSIONS,PERMISSION_LABELS,hostContract,hostCompatibility,requiredHostFeatures,PLUGIN_HOST_FILES,VOICE_HOST_FILES} from '../packages/plugin-api/contract.mjs';
import {PERMISSION_LABELS as uiPermissions} from '../public/console/plugin-contract.mjs';
import {manifest,configuration,updatePlugin,pluginCatalog,runtimeCatalog,atomicJson,packageFiles,featurePlugins} from '../packages/plugin-api/catalog.mjs';
import {PluginRuntime} from '../packages/plugin-api/index.mjs';
import {PluginProcess} from '../packages/plugin-api/process.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {auditPluginHost} from './plugin-host-check.mjs';
import {createConsole} from './console-server.mjs';

const project=path.resolve(import.meta.dirname,'..'),key='wechat:private:123';
const basic={id:'fixture',name:'Fixture',description:'Fixture',version:'1.0.0',host:'wechatagent',apiVersion:2};
const oldHost={ok:true,project:'WeChatAgent',pluginApiVersion:2,pluginRuntime:HOST_RUNTIME,pluginHostFeatures:HOST_FEATURES.filter(name=>name!=='voice-input-v1')};
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50}));return root;}
function installFixture(root,extra={},code='export function setup(api){api.registerTool({id:"run",description:"fixture",parameters:{type:"object",properties:{}},execute:()=>"ok"});}'){
  const installer=new PluginInstaller(root),zip=packZip([{name:'plugin.json',data:JSON.stringify({...basic,...extra})},{name:'index.mjs',data:code}]);const preview=installer.inspect({name:'fixture.zip',zip:zip.toString('base64')});installer.install(preview);installer.dispose();return preview;
}

test('permission labels and feature requirements have one shared source and infer omitted optional dependencies',()=>{
  assert.equal(API_VERSION,2);assert.deepEqual(uiPermissions,PERMISSION_LABELS);assert.deepEqual(PERMISSIONS,Object.keys(uiPermissions));
  const item=manifest({...basic,permissions:['documents','persona_read','model_generate','schedule','audio_read']});
  assert.deepEqual(new Set(item.requiresHostFeatures),new Set(['documents-v1','persona-read-v1','model-utility-v1','daily-schedule-v1','voice-input-v1']));
  assert.deepEqual(requiredHostFeatures({permissions:['audio_read'],requiresHostFeatures:['actions-v1']}),['actions-v1','voice-input-v1']);
});

test('unsupported permissions and host features report their exact name and upgrade action',()=>{
  assert.throws(()=>manifest({...basic,permissions:['future_audio']}),/future_audio.*更新/);
  assert.throws(()=>manifest({...basic,requiresHostFeatures:['future-v1']}),/future-v1.*更新/);
  assert.throws(()=>manifest({...basic,permissions:[{}]}),/字符串数组/);
});

test('older, malformed and disconnected runtimes cannot silently claim the new capability',()=>{
  assert.equal(hostCompatibility({permissions:['audio_read']},oldHost).compatible,false);
  assert.match(hostCompatibility({permissions:['audio_read']},oldHost).reason,/微信语音输入/);
  assert.equal(hostCompatibility({permissions:['audio_read']},hostContract()).compatible,true);
  assert.equal(hostCompatibility({permissions:['audio_read']},{...oldHost,pluginHostFeatures:{}}).compatible,false);
  assert.equal(hostCompatibility({},null).compatible,false);
});

test('all-chat scope survives the catalog and stale-runtime diagnostics while permissions stay unchanged',t=>{
  const root=temp(t);atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:[]}}});installFixture(root,{permissions:['audio_read']});
  updatePlugin(root,'fixture',{revision:configuration(root).revision,enabled:true,permissions:['audio_read'],chats:null,settings:{}});
  const before=fs.readFileSync(path.join(root,'config/plugins.json'),'utf8'),catalog=runtimeCatalog(pluginCatalog(root),oldHost);
  assert.equal(catalog.plugins[0].chats,null);assert.equal(catalog.plugins[0].statusLabel,'宿主待更新');assert.equal(catalog.plugins[0].active,false);assert.deepEqual(catalog.plugins[0].compatibility.missingFeatures,['voice-input-v1']);assert.equal(fs.readFileSync(path.join(root,'config/plugins.json'),'utf8'),before);
});

test('requiresAccount plugins never execute setup before account binding',async t=>{
  const root=temp(t),marker=path.join(root,'executed');atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:[]}}});
  installFixture(root,{requiresAccount:true},`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');export function setup(api){api.registerAction({id:'run',description:'fixture',parameters:{type:'object',properties:{}},execute:()=>({ok:true})});}`);
  updatePlugin(root,'fixture',{revision:configuration(root).revision,enabled:true,permissions:[],chats:[key],settings:{}});
  const runtime=new PluginRuntime({root});t.after(()=>runtime.dispose());await runtime.sync();assert.equal(fs.existsSync(marker),false);assert.match(runtime.list()[0].reason,/绑定微信账号/);
});

test('chat features go to the one plugin that declares them, never to a fixed id',async t=>{
  const root=temp(t),id='a'.repeat(64);atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123'],groups:[]}}});
  const action=(name,value)=>`export function setup(api){api.registerAction({id:${JSON.stringify(name)},description:'fixture',parameters:{type:'object',properties:{id:{type:'string'}},additionalProperties:false},execute:()=>(${JSON.stringify(value)})});}`;
  installFixture(root,{id:'voice-a',permissions:['audio_read']},action('transcribe',{ok:true,text:'a'}));
  installFixture(root,{id:'voice-b',permissions:['audio_read']},action('transcribe',{ok:true,text:'b'}));
  installFixture(root,{id:'diary-x',permissions:['reply'],requiresHostFeatures:['diary-question-v1']},action('ask',{handled:true,text:'RESPOND: x'}));
  installFixture(root,{id:'plain',permissions:['reply']},action('ask',{handled:true,text:'RESPOND: plain'}));
  const grant=(name,permissions)=>updatePlugin(root,name,{revision:configuration(root).revision,enabled:true,permissions,chats:[key],settings:{}});
  grant('voice-a',['audio_read']);grant('plain',['reply']);
  const runtime=new PluginRuntime({root,accountScope:'fixture-account'});t.after(()=>runtime.dispose());
  assert.deepEqual(featurePlugins(root,'voice-input-v1',key),[{id:'voice-a',generation:configuration(root).config.plugins['voice-a'].generation}]);
  assert.deepEqual(featurePlugins(root,'voice-input-v1','wechat:private:999'),[]);assert.deepEqual(featurePlugins(root,'unknown-v1',key),[]);
  const voice=await runtime.invokeFeature('voice-input-v1',{id},{conversationKey:key,voiceIds:[id]});
  assert.deepEqual(voice,{handled:true,plugin:'voice-a',generation:configuration(root).config.plugins['voice-a'].generation,result:{ok:true,text:'a'}});
  // An ask action without the declaration is not a diary handler.
  assert.deepEqual(featurePlugins(root,'diary-question-v1',key),[]);assert.deepEqual(await runtime.invokeFeature('diary-question-v1',{},{conversationKey:key}),{handled:false});
  grant('diary-x',['reply']);assert.deepEqual(featurePlugins(root,'diary-question-v1',key).map(item=>item.id),['diary-x']);
  const diary=await runtime.invokeFeature('diary-question-v1',{},{conversationKey:key});assert.equal(diary.plugin,'diary-x');assert.deepEqual(diary.result,{handled:true,text:'RESPOND: x'});
  grant('voice-b',['audio_read']);assert.deepEqual(featurePlugins(root,'voice-input-v1',key).map(item=>item.id),['voice-a','voice-b']);
  await assert.rejects(()=>runtime.invokeFeature('voice-input-v1',{id},{conversationKey:key,voiceIds:[id]}),error=>error.message==='PLUGIN_FEATURE_CONFLICT'&&error.plugins.join()==='voice-a,voice-b');
});

test('mixed parent and worker contract versions are rejected before registering tools',()=>{
  let reason;const process=new PluginProcess({},{onFailure:code=>reason=code});process.loading={reject:()=>{}};
  process.message({type:'ready',contract:{...hostContract(),features:[]},tools:[],actions:[],hooks:[],scheduled:false});assert.equal(process.closed,true);assert.equal(reason,'PLUGIN_HOST_CONTRACT_MISMATCH');
});

test('console previews incompatibility, serves the canonical contract and rejects incompatible enable without changing grants',async t=>{
  const root=temp(t),config=JSON.parse(fs.readFileSync(path.join(project,'config/wechatagent.example.json')));config.wechat.whitelist={private:['123'],groups:[]};
  atomicJson(path.join(root,'config/wechatagent.json'),config);fs.mkdirSync(path.join(root,'roles'));fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
  fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'fixture-dsh-token');
  let health={...oldHost,projectRoot:root};const app=createConsole({root,port:0,voiceCapabilities:async()=>({checked:true,decoder:true}),fetchImpl:async input=>new Response(JSON.stringify(new URL(input).pathname==='/health'?health:{extensions:[]}))});t.after(()=>app.close());
  const address=await app.start(),base='http://127.0.0.1:'+address.port,{token}=await fetch(base+'/api/info').then(r=>r.json());
  const rpc=async(route,body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'X-Console-Token':token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  const served=await fetch(base+'/plugin-contract.mjs').then(r=>r.text());assert.equal(served,fs.readFileSync(path.join(project,'packages/plugin-api/contract.mjs'),'utf8'));
  const zip=packZip(packageFiles(path.join(project,'optional-extensions/speech-recognition'))),preview=await rpc('/api/plugins/inspect',{name:'speech.zip',zip:zip.toString('base64')});assert.equal(preview.status,200);assert.equal(preview.body.compatibility.compatible,false);
  assert.equal((await rpc('/api/plugins/install',{ticket:preview.body.ticket,revision:preview.body.revision})).status,200);
  const id='speech-recognition',saved=configuration(root),settings={...saved.config.plugins[id].settings,endpoint:'https://asr.example.test/audio/transcriptions',model:'fixture-asr'},body={revision:saved.revision,enabled:true,permissions:['audio_read'],chats:null,settings};
  const denied=await rpc('/api/plugins/'+id,body);assert.equal(denied.status,409);assert.match(denied.body.error,/微信语音输入/);assert.equal(configuration(root).config.plugins[id].enabled,false);
  health={...oldHost,projectRoot:root,pluginHostFeatures:HOST_FEATURES,pluginPermissions:PERMISSIONS};assert.equal((await rpc('/api/plugins/'+id,body)).status,200);assert.equal((await rpc('/api/plugins')).body.plugins[0].chats,null);
});

function auditFixture(t){
  const root=temp(t);const files=[...PLUGIN_HOST_FILES,...VOICE_HOST_FILES,'packages/plugin-api/bundled.mjs','packages/extension-runtime/catalog.mjs','scripts/project-config.mjs','scripts/console-server.mjs','scripts/plugin-ui.mjs','scripts/plugin-settings-actions.mjs','scripts/voice-host-status.mjs','packages/dsh-social-bridge-plugin/native-context.mjs','public/console/plugins.js','public/console/plugin-contract.mjs','public/console/plugin-frame.mjs'];
  for(const relative of new Set(files)){const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(project,relative),target);}
  atomicJson(path.join(root,'package.json'),{type:'module'});
  for(const item of BUNDLED_PLUGINS){fs.cpSync(path.join(project,item.source),path.join(root,item.source),{recursive:true});if(item.zip){fs.mkdirSync(path.dirname(path.join(root,item.zip)),{recursive:true});for(const suffix of ['', '.sha256'])fs.copyFileSync(path.join(project,item.zip+suffix),path.join(root,item.zip+suffix));}}
  return root;
}

test('release check accepts the complete host and rejects omitted modules, stale declarations and stale ZIP bytes',async t=>{
  const root=auditFixture(t);assert.equal((await auditPluginHost(root)).ok,true);
  fs.unlinkSync(path.join(root,'packages/plugin-api/audio.mjs'));assert((await auditPluginHost(root)).findings.some(item=>item.code==='PLUGIN_HOST_FILE_MISSING'));
  fs.copyFileSync(path.join(project,'packages/plugin-api/audio.mjs'),path.join(root,'packages/plugin-api/audio.mjs'));
  const worker=path.join(root,'packages/plugin-api/worker.mjs'),original=fs.readFileSync(worker,'utf8');fs.writeFileSync(worker,original.replace('contract:hostContract()','contract:{}'));assert((await auditPluginHost(root)).findings.some(item=>item.code==='PLUGIN_HOST_INTEGRATION_STALE'));fs.writeFileSync(worker,original);
  fs.appendFileSync(path.join(root,'optional-extensions/speech-recognition/README.md'),'\nchanged');assert((await auditPluginHost(root)).findings.some(item=>item.code==='PLUGIN_BUNDLE_ZIP_STALE'));
});

test('release check flags runtime modules missing from reload revision coverage',async t=>{
  const root=auditFixture(t);fs.mkdirSync(path.join(root,'packages/plugin-api/helpers'));fs.writeFileSync(path.join(root,'packages/plugin-api/helpers/new-runtime.mjs'),'export const value=1;');assert((await auditPluginHost(root)).findings.some(item=>item.file.endsWith('helpers/new-runtime.mjs')&&item.code==='PLUGIN_HOST_REVISION_FILE_UNTRACKED'));
});
