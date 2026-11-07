import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import {settingsViewLifecycle,pluginSettingsMarkup} from '../public/console/plugin-config-ui.mjs';
import {createPluginUI} from '../public/console/plugins.js';
import {validateConfigUi} from './plugin-config-ui.mjs';
import {createConsole} from './console-server.mjs';
import {packZip,unpackZip} from '../packages/plugin-api/zip.mjs';
import {configuration,atomicJson} from '../packages/plugin-api/catalog.mjs';
import {writeVoiceAttempt} from '../packages/plugin-api/voice-status.mjs';
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('retiring a view aborts its requests and disposes detached page state exactly once',()=>{
 const state=settingsViewLifecycle(),old=state.begin();let disposed=0;old.bind(()=>disposed++);
 state.retire();assert(old.signal.aborted);assert.equal(old.current(),false);assert.equal(disposed,1);
 const current=state.begin();old.close();assert(current.current());assert.equal(disposed,1);current.close();assert(!current.current());
});
test('the installed descriptor controls layout and no plugin id selects a host template or widget',()=>{
 const schema={endpoint:{type:'string'},model:{type:'string'}},ui=validateConfigUi({version:1,sections:[{id:'new-section',title:'新版设置 <safe>',fields:['endpoint']}]},schema);
 const item={id:'speech-recognition',configUi:ui};const html=pluginSettingsMarkup(item,[{key:'endpoint',html:'<input id="new-field">'}],esc);
 assert(html.includes('新版设置 &lt;safe&gt;'));assert(html.includes('new-field'));assert(!html.includes('speech'));
 assert(!pluginSettingsMarkup({id:'speech-recognition'},[{key:'fresh',html:'<input id="fresh-only">'}],esc).includes('speech'));
 // The former first-party widget and diagnostics keys are no longer special.
 for(const bad of [{...ui,script:'evil()'},{...ui,sections:[{id:'test',title:'title',fields:['missing']}]},{...ui,fieldOptions:{endpoint:{widget:'html',html:'<script>'}}},{...ui,fieldOptions:{model:{widget:'speech-model'}}},{...ui,diagnostics:{kind:'speech-v1',section:'new-section'}}])assert.throws(()=>validateConfigUi(bad,schema));
});
test('an uninstall prevents a delayed configuration request from reopening the old page',async t=>{
 const before=globalThis.document,handlers=new Map();globalThis.document={addEventListener:(name,fn)=>handlers.set(name,fn),querySelector:()=>null};t.after(()=>globalThis.document=before);
 const waiting=deferred();let gets=0,modals=0,mutation;const row={id:'fixture',name:'Fixture',configSchema:{},settings:{},requestedPermissions:[],permissions:[],chats:[]};
 const ui=createPluginUI({api:async route=>route==='/api/plugins'?(++gets===1?waiting.promise:{revision:'fresh',plugins:[row]}):{ok:true},modal:()=>modals++,closeModal:()=>{},confirmAction:(_a,_b,_c,callback)=>{mutation=callback();},escapeHtml:esc,state:{names:new Map(),config:{wechat:{whitelist:{private:[],groups:[]}}}},renderPage:async()=>{},toast:()=>{},icon:()=>''});
 const pending=ui.settings('fixture');const button={dataset:{pluginUninstall:'fixture'},hasAttribute:()=>false};await handlers.get('click')({target:{closest:()=>button}});await mutation;
 waiting.resolve({revision:'old',plugins:[row]});await pending;assert.equal(modals,0);
});

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-plugin-page-'));const cfg=JSON.parse(fs.readFileSync('config/wechatagent.example.json'));cfg.wechat.whitelist={private:['123'],groups:[]};atomicJson(path.join(root,'config/wechatagent.json'),cfg);fs.mkdirSync(path.join(root,'roles'));fs.writeFileSync(path.join(root,'roles',cfg.persona.default+'.md'),'Fixture');
 // Settings actions run in the plugin's own worker, so the fixture is a real loopback service.
 let block;const observed=deferred(),seen=[];
 const service=http.createServer(async(req,res)=>{seen.push({method:req.method,url:req.url,authorization:req.headers.authorization});for await(const _chunk of req);if(block){observed.resolve();await block.promise;}res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='GET'?{data:[{id:'fixture-asr'}]}:{text:'语音识别测试'}));});
 await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
 const app=createConsole({root,port:0,voiceCapabilities:()=>({checked:true,decoder:true}),fetchImpl:async()=>{throw Error('NO_REMOTE');}});
 const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
 const request=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,headers:response.headers,body:await response.json()};};
 t.after(async()=>{block?.resolve();service.closeAllConnections();service.close();app.server.closeAllConnections();await app.close();assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 return {root,base,request,seen,endpoint:'http://127.0.0.1:'+service.address().port+'/v1',block(){block=deferred();return {observed:observed.promise,release:()=>{block.resolve();block=undefined;}};}};
}
async function install(f,bytes){const preview=await f.request('/api/plugins/inspect',{name:'speech.zip',zip:bytes.toString('base64')});assert.equal(preview.status,200);const result=await f.request('/api/plugins/install',{ticket:preview.body.ticket,revision:preview.body.revision,replace:!!preview.body.installedVersion});assert.equal(result.status,200);}
const zip=()=>fs.readFileSync('optional-extensions/packages/speech-recognition-1.5.0.zip');
test('the speech package owns its settings page; settings actions use saved secrets, stop on uninstall and follow the new package',async t=>{
 const f=await fixture(t);await install(f,zip());let catalog=(await f.request('/api/plugins')).body;const original=catalog.plugins[0];
 assert.equal(original.configUi,undefined);assert.deepEqual(original.ui.settings.actions,['models','check','validate']);assert.equal(original.serviceStatus,undefined);
 assert.match((await f.request('/api/plugins')).headers.get('cache-control'),/no-store/);
 const settings={...original.settings,endpoint:f.endpoint,model:'fixture-asr',apiKey:'fixture-key-123456'};
 assert.equal((await f.request('/api/plugins/speech-recognition',{revision:catalog.revision,packageRevision:original.revision,enabled:false,permissions:[],chats:[],settings})).status,200);
 catalog=(await f.request('/api/plugins')).body;assert.equal(catalog.plugins[0].settings.apiKey,'');
 // Disabled and without grants: the page's own check still works, and a blank secret keeps the saved one.
 const check=await f.request('/api/plugins/speech-recognition/settings-actions/check',{packageRevision:original.revision,args:{settings:{...settings,apiKey:''},decoder:{checked:true,decoder:true}}});
 assert.equal(check.status,200);assert.equal(check.body.summary.ready,true);assert.equal(check.body.probe.text,'语音识别测试');assert(!JSON.stringify(check.body).includes('fixture-key-123456'));
 assert(f.seen.some(row=>row.method==='POST'&&row.authorization==='Bearer fixture-key-123456'));assert(!fs.existsSync(path.join(f.root,'state/plugin-service-checks/speech-recognition.json')));
 assert.equal((await f.request('/api/plugins/speech-recognition/settings-actions/transcribe',{packageRevision:original.revision,args:{id:'a'.repeat(64)}})).status,404);
 assert.equal((await f.request('/api/plugins/speech-recognition/settings-actions/models',{packageRevision:'stale',args:{settings}})).status,409);
 assert.equal((await f.request('/api/plugins/speech-recognition/settings-actions/models',{packageRevision:original.revision,args:{settings:{...settings,unknown:1}}})).status,400);
 const invalid=await f.request('/api/plugins/speech-recognition/settings-actions/validate',{packageRevision:original.revision,args:{settings:{...settings,model:'https://not-a-model'}}});assert.equal(invalid.body.ok,false);assert.equal(invalid.body.code,'VOICE_MODEL_IS_URL');
 // Real voice traffic (not a synthetic check) drives the card and the page's host facts.
 writeVoiceAttempt(f.root,'speech-recognition',{ok:false,code:'VOICE_API_HTTP_403',stage:'api'},configuration(f.root).config.plugins['speech-recognition'].generation);
 catalog=(await f.request('/api/plugins')).body;assert.equal(catalog.plugins[0].serviceStatus.state,'error');assert.match(catalog.plugins[0].serviceStatus.message,/VOICE_API_HTTP_403/);
 const host=(await f.request('/api/plugins/speech-recognition/host-status')).body;assert.deepEqual(host.voice.decoder,{checked:true,decoder:true});assert.equal(host.voice.lastAttempt.code,'VOICE_API_HTTP_403');
 const document=path.join(f.root,'state/plugins/fixture/speech-recognition/keep.json');atomicJson(document,{note:'keep'});
 const held=f.block(),pending=f.request('/api/plugins/speech-recognition/settings-actions/models',{packageRevision:original.revision,args:{settings}});await held.observed;
 assert.equal((await f.request('/api/plugins/speech-recognition/uninstall',{revision:catalog.revision})).status,200);
 const cancelled=await pending;held.release();assert.notEqual(cancelled.status,200);assert(fs.existsSync(document));
 assert.equal((await f.request('/api/plugins/speech-recognition/host-status')).status,404);
 const changed=unpackZip(zip()).map(entry=>entry.name==='ui.json'?{...entry,data:Buffer.from(JSON.stringify({version:1,settings:{entry:'settings.html',height:700,actions:['models']}}))}:entry);
 await install(f,packZip(changed));catalog=(await f.request('/api/plugins')).body;const next=catalog.plugins[0];
 assert.notEqual(next.revision,original.revision);assert.equal(next.ui.settings.height,700);assert.deepEqual(next.ui.settings.actions,['models']);assert.notEqual(next.ui.settings.url,original.ui.settings.url);
 assert.equal((await fetch(f.base+original.ui.settings.url)).status,404);assert.equal((await fetch(f.base+next.ui.settings.url)).status,200);
 assert.equal((await f.request('/api/plugins/speech-recognition/settings-actions/check',{packageRevision:next.revision,args:{settings}})).status,404);
 assert.equal((await f.request('/api/plugins/speech-recognition',{revision:catalog.revision,packageRevision:original.revision,enabled:false,permissions:[],chats:[],settings:next.settings})).status,409);
});
test('an old package descriptor that used the removed speech widget falls back to the standard form',async t=>{
 const legacy={version:1,sections:[{id:'model',title:'选择识别模型',fields:['model']}],fieldOptions:{model:{widget:'speech-model'}},diagnostics:{kind:'speech-v1',section:'model'}};
 const f=await fixture(t),entries=[...unpackZip(zip()).filter(entry=>!entry.name.startsWith('ui')),{name:'config-ui.json',data:Buffer.from(JSON.stringify(legacy))}];
 await install(f,packZip(entries));const item=(await f.request('/api/plugins')).body.plugins[0];assert.equal(item.configUi,undefined);assert.match(item.configUiError,/标准配置/);assert.equal(item.ui,undefined);
});
