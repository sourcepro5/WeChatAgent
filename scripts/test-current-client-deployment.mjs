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
