import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import deployment from '../apps/console-desktop/deployment.cjs';
import {verifyHookBuild} from './hook-build-policy.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'wechatagent-release-client-'));
 t.after(()=>{assert(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(base,{recursive:true,force:true,maxRetries:3});});
 const resources=path.join(base,'resources'),home=path.join(base,'data');
 const write=(relative,value)=>{const file=path.join(resources,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
 const manifest={version:'0.4.2',buildId:'current-build',wechatVersion:'4.1.15.13',dshBundled:false,files:['config/wechatagent.example.json']};
 write('project/config/wechatagent.example.json',JSON.stringify({runtime:{python:'python',dshDesktop:''},hook:{expectedVersion:'4.1.15.13',wechatExecutable:'state/hook/wechat-4.1.15.13/Weixin.exe'},wechat:{whitelist:{private:[],groups:[]}},persona:{default:'example',chats:{}}}));
 write('project/deployment.json',JSON.stringify(manifest));
 write('runtime/python/python.exe','fixture-python');write('runtime/node.exe','fixture-node');
 write('vendor/wechat/Weixin.exe','fixture-client');write('vendor/wechat/4.1.15.13/Weixin.dll','fixture-core');
 write('vendor/hook/version.dll','fixture-legacy');write('vendor/hook/build.json','{}');
 const build={targetVersion:'4.1.15.13',profile:'4.1.15.13-media-mentions-v2',integration:'WeChatAgent-1',nativeTextSend:true,nativeImageSend:true,nativeMentionSend:true,sha256:hash('fixture-current-dll'),loaderSha256:hash('fixture-current-loader')};
 write('vendor/hook-current/build.json',JSON.stringify(build));write('vendor/hook-current/wechatagent-text-4.1.15.13.dll','fixture-current-dll');write('vendor/hook-current/wechatagent-text-loader.exe','fixture-current-loader');
 return {resources,home,write,manifest,build};
}
test('0.4.2 deploys the exact current client and external native resources without personal configuration',async t=>{
 const f=fixture(t),context=await deployment.bootstrapDeployment(f.resources,f.home);
 const config=JSON.parse(fs.readFileSync(path.join(context.root,'config/wechatagent.json')));
 assert.equal(config.hook.expectedVersion,'4.1.15.13');assert.equal(config.hook.wechatExecutable,'state/hook/wechat-4.1.15.13/Weixin.exe');
 assert.deepEqual(config.wechat.whitelist,{private:[],groups:[]});
 assert(!fs.existsSync(path.join(context.root,'state/hook/native')));
 assert.equal(fs.readFileSync(path.join(context.root,config.hook.wechatExecutable),'utf8'),'fixture-client');
 assert.equal(fs.readFileSync(path.join(context.root,'state/hook/native-4.1.15.13/wechatagent-text-loader.exe'),'utf8'),'fixture-current-loader');
 assert(!fs.existsSync(path.join(context.root,'state/hook/native-token.txt')));
 assert(!fs.existsSync(path.join(context.root,'state/hook/native-4.1.15.13/wechatagent-hook.token')));
});
test('upgrading from the old bundle retains the selected client, settings, secrets and old native resources',async t=>{
 const f=fixture(t);delete f.manifest.wechatVersion;f.manifest.version='0.4.1+';f.write('project/deployment.json',JSON.stringify(f.manifest));
 const old=await deployment.bootstrapDeployment(f.resources,f.home),configFile=path.join(old.root,'config/wechatagent.json');
 const config=JSON.parse(fs.readFileSync(configFile));config.wechat.whitelist.private=['fixture-chat'];config.persona.default='own-role';fs.writeFileSync(configFile,JSON.stringify(config));
 const secret=path.join(old.root,'state/hook/native-token.txt');fs.writeFileSync(secret,'fixture-secret');
 f.manifest.version='0.4.2';f.manifest.wechatVersion='4.1.15.13';f.manifest.buildId='upgraded';f.write('project/deployment.json',JSON.stringify(f.manifest));
 const next=await deployment.bootstrapDeployment(f.resources,f.home),updated=JSON.parse(fs.readFileSync(configFile));
 assert.equal(updated.hook.expectedVersion,'4.1.10.27');assert.equal(updated.hook.wechatExecutable,'state/hook/wechat-4.1.10.27/Weixin.exe');
 assert.deepEqual(updated.wechat.whitelist.private,['fixture-chat']);assert.equal(updated.persona.default,'own-role');assert.equal(fs.readFileSync(secret,'utf8'),'fixture-secret');
 assert(fs.existsSync(path.join(next.root,'state/hook/wechat-4.1.15.13/Weixin.exe')));assert(fs.existsSync(path.join(next.root,'state/hook/wechat-4.1.10.27/Weixin.exe')));
 assert.equal(JSON.parse(fs.readFileSync(path.join(next.root,'state/console-state.json'))).pendingApply,true);
});
test('unknown bundled versions and corrupt current native payloads stop deployment',async t=>{
 const f=fixture(t);f.manifest.wechatVersion='../other';f.write('project/deployment.json',JSON.stringify(f.manifest));
 await assert.rejects(()=>deployment.bootstrapDeployment(f.resources,f.home),/微信版本无效/);
 f.manifest.wechatVersion='4.1.15.13';f.write('project/deployment.json',JSON.stringify(f.manifest));f.write('vendor/hook-current/wechatagent-text-loader.exe','changed-loader');
 await assert.rejects(()=>deployment.bootstrapDeployment(f.resources,f.home),/校验失败/);
 assert(!fs.existsSync(path.join(f.home,'workspace/config/wechatagent.json')));
});
test('packaging checks both current native resources and the exact capability profile',t=>{
 const f=fixture(t),directory=path.join(f.resources,'vendor/hook-current');
 assert.equal(verifyHookBuild(directory,'4.1.15.13').sha256,f.build.sha256);
 f.write('vendor/hook-current/wechatagent-text-4.1.15.13.dll','changed');assert.throws(()=>verifyHookBuild(directory,'4.1.15.13'),/does not match/);
 f.write('vendor/hook-current/wechatagent-text-4.1.15.13.dll','fixture-current-dll');f.build.profile='unknown';f.write('vendor/hook-current/build.json',JSON.stringify(f.build));
 assert.throws(()=>verifyHookBuild(directory,'4.1.15.13'),/profile mismatch/);
 assert.throws(()=>verifyHookBuild(directory,'4.1.15.56'),/Unsupported/);
});


function current42(t){
 const f=fixture(t);
 for(const relative of ['vendor/hook','vendor/wechat/4.1.15.13']){const target=path.resolve(f.resources,relative);assert(target.startsWith(path.resolve(f.resources)+path.sep));fs.rmSync(target,{recursive:true,force:true});}
 f.manifest.wechatVersion='4.2.0.12';f.manifest.bundledWechatVersions=['4.2.0.12'];f.write('project/deployment.json',JSON.stringify(f.manifest));
 f.write('vendor/wechat/4.2.0.12/Weixin.dll','fixture-4.2-core');
 const build={...f.build,targetVersion:'4.2.0.12',profile:'4.2.0.12-stickers-v2',productionEnabled:true,runtimeVerified:true,nativeStickerSend:true,acceptance:{coldStart:true,textReceipt:true,imageReceipt:true,stickerReceipt:true,animatedSticker:true}};
 f.write('vendor/hook-current/build.json',JSON.stringify(build));f.write('vendor/hook-current/wechatagent-text-4.2.0.12.dll','fixture-current-dll');
 const previous=path.resolve(f.resources,'vendor/hook-current/wechatagent-text-4.1.15.13.dll');assert(previous.startsWith(path.resolve(f.resources)+path.sep));fs.rmSync(previous);
 return {...f,build};
}
test('a 4.2-only package deploys without any legacy client or legacy sender payload',async t=>{
 const f=current42(t);assert.equal(verifyHookBuild(path.join(f.resources,'vendor/hook-current'),'4.2.0.12').targetVersion,'4.2.0.12');
 const installed=await deployment.bootstrapDeployment(f.resources,f.home),config=JSON.parse(fs.readFileSync(path.join(installed.root,'config/wechatagent.json'),'utf8'));
 assert.equal(config.hook.expectedVersion,'4.2.0.12');assert.equal(config.hook.wechatExecutable,'state/hook/wechat-4.2.0.12/Weixin.exe');
 for(const old of ['native','native-4.1.15.13','wechat-4.1.10.27','wechat-4.1.15.13'])assert(!fs.existsSync(path.join(installed.root,'state/hook',old)));
 assert(fs.existsSync(path.join(installed.root,'state/hook/native-4.2.0.12/wechatagent-text-4.2.0.12.dll')));
});
test('4.2 packaging and deployment reject missing runtime acceptance and mixed bundled versions',async t=>{
 const f=current42(t);f.build.acceptance.coldStart=false;f.write('vendor/hook-current/build.json',JSON.stringify(f.build));
 assert.throws(()=>verifyHookBuild(path.join(f.resources,'vendor/hook-current'),'4.2.0.12'),/acceptance/);await assert.rejects(()=>deployment.bootstrapDeployment(f.resources,f.home),/运行验收/);
 f.build.acceptance.coldStart=true;f.write('vendor/hook-current/build.json',JSON.stringify(f.build));f.manifest.bundledWechatVersions.push('4.1.15.13');f.write('project/deployment.json',JSON.stringify(f.manifest));
 await assert.rejects(()=>deployment.bootstrapDeployment(f.resources,f.home),/其他微信版本/);
});

test('4.2 cannot ship text-only or unverified animated-sticker payloads',async t=>{
 for(const field of ['nativeStickerSend','stickerReceipt','animatedSticker']){
  const f=current42(t);if(field==='nativeStickerSend')f.build[field]=false;else f.build.acceptance[field]=false;
  f.write('vendor/hook-current/build.json',JSON.stringify(f.build));
  assert.throws(()=>verifyHookBuild(path.join(f.resources,'vendor/hook-current'),'4.2.0.12'),/profile mismatch|acceptance/);
  await assert.rejects(()=>deployment.bootstrapDeployment(f.resources,f.home),/运行验收/);
 }
});
