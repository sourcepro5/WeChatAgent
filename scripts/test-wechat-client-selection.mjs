import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {inspectWeChatClient} from './wechat-client-selection.mjs';
import {hookProfiles} from './hook-profiles.mjs';
import {createConsole} from './console-server.mjs';

const source=path.resolve(import.meta.dirname,'..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,version='4.1.15.13'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-selection-'));
  t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
  const write=(relative,value)=>{const p=path.join(root,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);return p;};
  const executable=write('client with spaces/Weixin.exe','fixture-client');
  const directory='state/hook/'+(version==='4.1.10.27'?'native':'native-'+version);
  const build={targetVersion:version,profile:version==='4.2.0.12'?'4.2.0.12-stickers-v2':'4.1.15.13-media-mentions-v2',integration:'WeChatAgent-1',nativeTextSend:true,nativeImageSend:true,nativeMentionSend:true,nativeStickerSend:version!=='4.1.15.13',productionEnabled:true,runtimeVerified:true,acceptance:{coldStart:true,textReceipt:true,imageReceipt:true,stickerReceipt:true,animatedSticker:true},initialization:'deferred-module-v3',mutexCompatibility:'legacy-runtime-constructor-v1',exceptionDiagnostics:'seh-cpp-stage-v1',logWriter:'win32-srw-v1',sha256:hash('fixture-dll'),loaderSha256:hash('fixture-loader')};
  write(directory+'/build.json',JSON.stringify(build));
  write(directory+'/'+(version==='4.1.10.27'?'version.dll':'wechatagent-text-'+version+'.dll'),'fixture-dll');
  write(directory+'/wechatagent-text-loader.exe','fixture-loader');
  const info={version,coreVersion:version,coreExists:true,signatureValid:true,coreSignatureValid:true};
  return {root,write,executable,directory,build,info,inspect:overrides=>inspectWeChatClient({root,executable,probe:async()=>({...info,...overrides})})};
}

for(const version of Object.keys(hookProfiles))test('selection derives the exact supported version '+version+' from verified files',async t=>{
  const f=fixture(t,version),result=await f.inspect();assert.equal(result.version,version);assert.equal(result.path,f.executable);
});
test('missing and non-Weixin selections are rejected without probing or launching',async t=>{
  const f=fixture(t);let calls=0;
  for(const executable of ['',null,'missing/Weixin.exe',f.write('other.exe','fixture')])await assert.rejects(inspectWeChatClient({root:f.root,executable,probe:async()=>{calls++;return f.info;}}));
  assert.equal(calls,0);
});
test('unsupported versions, unsigned files and mismatched or missing cores never become a selection',async t=>{
  const f=fixture(t);
  for(const [value,message]of [[{version:'4.2.0.13'},/不支持/],[{signatureValid:false},/数字签名/],[{coreExists:false},/核心文件缺失/],[{coreVersion:'4.1.10.27'},/版本不一致/],[{coreSignatureValid:false},/数字签名/]])await assert.rejects(f.inspect(value),message);
});
test('absent, wrong-profile and changed sender payloads are rejected',async t=>{
  const f=fixture(t);f.write(f.directory+'/wechatagent-text-4.1.15.13.dll','corrupt');await assert.rejects(f.inspect(),/配套发送组件/);
  f.write(f.directory+'/wechatagent-text-4.1.15.13.dll','fixture-dll');f.build.profile='wrong';f.write(f.directory+'/build.json',JSON.stringify(f.build));await assert.rejects(f.inspect(),/配套发送组件/);
  fs.unlinkSync(path.join(f.root,f.directory,'build.json'));await assert.rejects(f.inspect(),/配套发送组件/);
});

async function consoleFixture(t,{probe}={}){
  const f=fixture(t),config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json')));
  f.write('config/wechatagent.json',JSON.stringify(config));
  f.write('roles/'+config.persona.default+'.md','# Fixture persona');
  const credentials=f.write('state/weflow/WeFlow-config.json','{"decryptKey":"fixture-retained-key"}');
  let calls=0;
  const app=createConsole({root:f.root,port:0,wechatClientInspector:async args=>{calls++;return inspectWeChatClient({...args,probe:probe??(async()=>f.info)});}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const api=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  return {...f,config,credentials,api,get calls(){return calls;}};
}
test('preview does not save; changing only the path atomically saves the detected version and preserves credentials',async t=>{
  const f=await consoleFixture(t),file=path.join(f.root,'config/wechatagent.json'),before=fs.readFileSync(file);
  assert.equal((await f.api('/api/wechat-client',{path:f.executable})).body.version,'4.1.15.13');assert.deepEqual(fs.readFileSync(file),before);
  const current=(await f.api('/api/config')).body;current.config.hook.expectedVersion='4.1.10.27';current.config.hook.wechatExecutable=f.executable;
  const saved=await f.api('/api/config',current);assert.equal(saved.status,200);assert.equal(saved.body.config.hook.expectedVersion,'4.1.15.13');assert.equal(saved.body.config.hook.wechatExecutable,f.executable);
  assert.deepEqual(saved.body.config.persona,f.config.persona);assert.deepEqual(saved.body.config.wechat.whitelist,f.config.wechat.whitelist);assert.equal(fs.readFileSync(f.credentials,'utf8'),'{"decryptKey":"fixture-retained-key"}');
});
test('bad selection saves nothing, while unrelated settings do not require an installed client',async t=>{
  const f=await consoleFixture(t),current=(await f.api('/api/config')).body,file=path.join(f.root,'config/wechatagent.json'),before=fs.readFileSync(file);
  const changed=structuredClone(current);changed.config.hook.wechatExecutable='missing/Weixin.exe';assert.equal((await f.api('/api/config',changed)).status,400);assert.deepEqual(fs.readFileSync(file),before);
  current.config.account.nicknames=['fixture nickname'];assert.equal((await f.api('/api/config',current)).status,200);assert.equal(f.calls,1);
});
test('a concurrent save during file inspection cannot overwrite newer settings',async t=>{
  let entered,release;const probing=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  const f=await consoleFixture(t,{probe:async()=>{entered();await wait;return f.info;}}),original=(await f.api('/api/config')).body;
  const changed=structuredClone(original);changed.config.hook.wechatExecutable=f.executable;
  const pending=f.api('/api/config',changed);await probing;
  original.config.account.nicknames=['newer nickname'];assert.equal((await f.api('/api/config',original)).status,200);release();
  assert.equal((await pending).status,409);const saved=(await f.api('/api/config')).body;assert.deepEqual(saved.config.account.nicknames,['newer nickname']);assert.equal(saved.config.hook.wechatExecutable,f.config.hook.wechatExecutable);
});

async function browseFixture({selection,error,canceled=false}={}){
  const text=fs.readFileSync(path.join(source,'public/console/console.js'),'utf8');
  const fn=text.slice(text.indexOf('async function browse(button)'),text.indexOf('async function discoverReader('));
  const state={draft:{hook:{expectedVersion:'4.1.10.27',wechatExecutable:'old/Weixin.exe'}}},messages=[],calls=[];
  const input={dataset:{path:'hook.wechatExecutable'},value:state.draft.hook.wechatExecutable,dispatchEvent(){state.draft.hook.wechatExecutable=this.value;}};
  const button={disabled:false,dataset:{browse:'exe',target:'client'}};
  await vm.runInNewContext(fn+';browse(button)',{button,state,document:{getElementById:()=>input},Event:class {},setPath:(target,key,value)=>{assert.equal(key,'hook.expectedVersion');target.hook.expectedVersion=value;},toast:value=>messages.push(value),api:async(route,body)=>{calls.push({route,body});if(route==='/api/browse')return {path:canceled?'':'new/Weixin.exe'};if(error)throw Error(error);return selection;}});
  return {state,messages,calls,button};
}
test('the actual browser selection flow updates path and version together, and cancel/failure leaves the draft intact',async()=>{
  const good=await browseFixture({selection:{version:'4.1.15.13'}});assert.deepEqual(good.state.draft.hook,{expectedVersion:'4.1.15.13',wechatExecutable:'new/Weixin.exe'});assert.equal(good.calls[1].route,'/api/wechat-client');assert.equal(good.button.disabled,false);
  for(const options of [{canceled:true},{error:'unsupported'}]){const f=await browseFixture(options);assert.deepEqual(f.state.draft.hook,{expectedVersion:'4.1.10.27',wechatExecutable:'old/Weixin.exe'});assert.equal(f.button.disabled,false);}
});
