import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {hookAccountProblem,verifyWeChatAccount} from './wechat-account-check.mjs';
import {createConsole} from './console-server.mjs';
import {needsWeChatRepair} from '../public/console/process-recovery.js';
const source=path.resolve(import.meta.dirname,'..'),health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.10.27',startupState:'ready',pid:123,databaseAccounts:['wxid_b']};
function fixture(t,version='4.1.10.27'){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-live-account-')),config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));config.hook.expectedVersion=version;config.hook.wechatExecutable='state/hook/wechat-'+version+'/Weixin.exe';config.ports={weflow:0,onebot:0,adapter:0,dshPlugin:0};
 const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 const a={dbPath:path.join(root,'wxid_a'),myWxid:'wxid_a',decryptKey:'userdpapi:YQ=='},b={dbPath:path.join(root,'wxid_b'),myWxid:'wxid_b',decryptKey:'userdpapi:Yg=='};for(const account of [a,b])fs.mkdirSync(path.join(account.dbPath,'db_storage'),{recursive:true});
 write('config/wechatagent.json',config);write('state/weflow/WeFlow-config.json',a);write('state/wechat-io-config.json',{self_wxid:'wxid_a'});write('state/hook/native-token.txt','c'.repeat(64));
 t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return{root,config,a,b,write};}
const response=value=>new Response(JSON.stringify(value));

test('the account gate requires one exact account and distinguishes login, mismatch, ambiguity and invalid metadata',()=>{
 assert.equal(hookAccountProblem(health,'WXID_B'),'');
 for(const [override,code]of [[{databaseAccounts:[]},'HOOK_LOGIN_REQUIRED'],[{databaseAccounts:['wxid_a']},'HOOK_ACCOUNT_MISMATCH'],[{databaseAccounts:['wxid_a','wxid_b']},'HOOK_MULTIPLE_ACCOUNT_DATABASES'],[{databaseAccounts:null},'HOOK_ACCOUNT_METADATA_INVALID'],[{databaseAccounts:[null]},'HOOK_ACCOUNT_METADATA_INVALID'],[{version:'4.1.15.13'},'HOOK_VERSION_MISMATCH'],[{backend:'foreign'},'REVIEWED_HOOK_BUILD_REQUIRED'],[{startupState:'waiting'},'HOOK_INITIALIZATION_PENDING']])assert.equal(hookAccountProblem({...health,...override},'wxid_b'),code);
});

test('ambiguous and mismatched accounts offer the existing confirmed repair flow rather than a generic port action',()=>{
 for(const code of ['HOOK_MULTIPLE_ACCOUNT_DATABASES','HOOK_ACCOUNT_MISMATCH','HOOK_ACCOUNT_METADATA_INVALID'])assert.equal(needsWeChatRepair('['+code+']'),true);
 for(const code of ['HOOK_LOGIN_REQUIRED','READER_KEY_INVALID','SERVICE_PORT_IN_USE'])assert.equal(needsWeChatRepair(code),false);
});

test('connection tolerates a bounded startup/login wait, authenticates locally and accepts only the selected account',async t=>{
 const f=fixture(t);let now=0,calls=0;const progress=[];
 const result=await verifyWeChatAccount({...f,settings:f.b,now:()=>now,sleep:async ms=>{now+=ms;},timeoutMs:30,intervalMs:2,onProgress:message=>progress.push(message),fetchImpl:async(url,options)=>{assert.equal(new URL(url).hostname,'127.0.0.1');assert.equal(options.headers.Authorization,'Bearer '+'c'.repeat(64));assert.equal(options.redirect,'error');if(++calls===1)throw new TypeError('fixture',{cause:{code:'ECONNREFUSED'}});return response({...health,databaseAccounts:calls<4?[]:['wxid_b']});}});
 assert.equal(result.ready,true);assert.equal(calls,4);assert.equal(progress.length,1);assert(!progress.join('').includes('c'.repeat(64)));
});

test('offline databases cannot satisfy live confirmation, while a soft preflight can allow login to proceed',async t=>{
 const f=fixture(t);let now=0;const options={...f,settings:f.b,fetchImpl:async()=>response({...health,databaseAccounts:[]}),timeoutMs:4,intervalMs:2,now:()=>now,sleep:async ms=>{now+=ms;}};
 assert.equal((await verifyWeChatAccount({...options,wait:false,requireReady:false})).ready,false);await assert.rejects(verifyWeChatAccount(options),/HOOK_LOGIN_REQUIRED/);
 await assert.rejects(verifyWeChatAccount({...options,wait:false}),/HOOK_LOGIN_REQUIRED/);
 await assert.rejects(verifyWeChatAccount({...options,wait:false,requireReady:false,fetchImpl:async()=>{throw new TypeError('fixture',{cause:{code:'ECONNREFUSED'}});}}),/HOOK_NOT_LISTENING/);
});

test('authentication, invalid versions and multiple accounts never retry or expose authentication values',async t=>{
 const f=fixture(t);for(const [body,code]of [[new Response('{}',{status:401}),'HOOK_AUTH_FAILED'],[{...health,version:'other'},'HOOK_VERSION_MISMATCH'],[{...health,databaseAccounts:['wxid_a','wxid_b']},'HOOK_MULTIPLE_ACCOUNT_DATABASES']]){let calls=0;await assert.rejects(verifyWeChatAccount({...f,settings:f.b,fetchImpl:async()=>{calls++;return body instanceof Response?body:response(body);}}),error=>error.code===code&&!error.message.includes('c'.repeat(64)));assert.equal(calls,1);}
});

test('a body timeout remains a timeout, malformed JSON stays invalid, and remote Hook addresses are refused',async t=>{
 const f=fixture(t);await assert.rejects(verifyWeChatAccount({...f,settings:f.b,wait:false,fetchImpl:async()=>({status:200,ok:true,json:async()=>{throw new DOMException('fixture','AbortError');}})}),/HOOK_HEALTH_TIMEOUT/);
 await assert.rejects(verifyWeChatAccount({...f,settings:f.b,fetchImpl:async()=>new Response('invalid')}),/HOOK_HEALTH_INVALID_RESPONSE/);
 await assert.rejects(verifyWeChatAccount({...f,settings:f.b,config:{hook:{baseUrl:'https://example.com/'}}}),/HOOK_LOOPBACK_REQUIRED/);
});

async function consoleFixture(t,{live,setup,stop}={}){
 const f=fixture(t);let setups=0,stops=0,calls=0;
 const app=createConsole({root:f.root,port:0,readerSetup:async({request})=>{setups++;return setup?setup(request):{ok:true,dbPath:request.dbPath,myWxid:request.myWxid,protectedKey:request.decryptKey||'userdpapi:Yg=='};},fetchImpl:async()=>response(live?live(++calls):health),runner:async()=>{stops++;return stop?stop():0;}});
 const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
 const request=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return r.json();};
 const connect=async()=>request('/api/jobs',{action:'reader-connect',revision:(await request('/api/reader-config')).revision,dbPath:f.b.dbPath,myWxid:f.b.myWxid,decryptKey:'',autoKey:true});
 const wait=async id=>{for(let i=0;i<100;i++){const job=await request('/api/job?id='+id);if(job.finishedAt)return job;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('account fixture timeout');};
 return{...f,request,connect,wait,get setups(){return setups;},get stops(){return stops;}};
}

test('a wrong live account fails before capture or stopping services and leaves the saved account untouched',async t=>{
 const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:['wxid_a']})}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'HOOK_ACCOUNT_MISMATCH');assert.equal(job.phase,'checking-wechat');assert.equal(f.setups,0);assert.equal(f.stops,0);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!fs.existsSync(path.join(f.root,'state/weflow/active-account.json')));
});

test('an incomplete selection cannot silently fall back to the previously saved account',async t=>{
 const f=await consoleFixture(t),revision=(await f.request('/api/reader-config')).revision;
 for(const [dbPath,myWxid]of [[f.b.dbPath,''],['',''],['',f.b.myWxid]]){const result=await f.request('/api/jobs',{action:'reader-connect',revision,dbPath,myWxid,decryptKey:'',autoKey:true});assert(result.error.includes('明确选择'));}
 assert.equal(f.setups,0);assert.equal(f.stops,0);
});

test('a valid cached database still cannot commit when the live account becomes ambiguous after validation',async t=>{
 const f=await consoleFixture(t,{live:call=>({...health,databaseAccounts:call===1?['wxid_b']:['wxid_a','wxid_b']})}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'HOOK_MULTIPLE_ACCOUNT_DATABASES');assert(job.message.includes('修复微信连接'));assert.equal(f.setups,1);assert.equal(f.stops,0);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!job.readerConfigured);
});

test('a login change while old services stop is caught by the final check before saving the new account',async t=>{
 let stopped=false;const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:[stopped?'wxid_a':'wxid_b']}),stop:()=>{stopped=true;return 0;}}),before=fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'));const job=await f.wait((await f.connect()).id);
 assert.equal(job.state,'failed');assert.equal(job.code,'HOOK_ACCOUNT_MISMATCH');assert.equal(f.stops,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json')),before);assert(!fs.existsSync(path.join(f.root,'state/weflow/active-account.json')));
});

test('a correct live account commits the selected credentials and preserves the DSH restart requirement',async t=>{
 const f=await consoleFixture(t),job=await f.wait((await f.connect()).id);assert.equal(job.state,'succeeded');assert.equal(job.readerConfigured,true);assert.equal(job.accountSwitched,true);assert.equal(job.dshRestartRequired,true);assert.equal(job.phase,'complete');assert.equal(f.stops,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'))).myWxid,'wxid_b');assert(!JSON.stringify(job).includes('userdpapi:'));
});

test('A to B to A uses each live account and restores only that account settings and credential cache',async t=>{
 let account='wxid_b';const f=await consoleFixture(t,{live:()=>({...health,databaseAccounts:[account]})});f.config.wechat.whitelist.private=['123'];f.write('config/wechatagent.json',f.config);
 assert.equal((await f.wait((await f.connect()).id)).state,'succeeded');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'))).wechat.whitelist.private,[]);
 account='wxid_a';const revision=(await f.request('/api/reader-config')).revision,next=await f.request('/api/jobs',{action:'reader-connect',revision,dbPath:f.a.dbPath,myWxid:f.a.myWxid,decryptKey:'',autoKey:true});assert.equal((await f.wait(next.id)).state,'succeeded');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'))).wechat.whitelist.private,['123']);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/weflow/WeFlow-config.json'))).decryptKey,f.a.decryptKey);assert.equal(f.stops,2);
});


test('current client account verification accepts only the exact ready profile and selected account',async t=>{
 const f=fixture(t,'4.1.15.13'),current={...health,version:'4.1.15.13',profile:'4.1.15.13-media-mentions-v2',nativeTextSend:true};
 assert.equal((await verifyWeChatAccount({...f,settings:f.b,wait:false,fetchImpl:async()=>response(current)})).ready,true);
 await assert.rejects(verifyWeChatAccount({...f,settings:f.b,wait:false,fetchImpl:async()=>response(health)}),/HOOK_VERSION_MISMATCH/);
 await assert.rejects(verifyWeChatAccount({...f,settings:f.b,wait:false,fetchImpl:async()=>response({...current,profile:'unknown'})}),/HOOK_INITIALIZATION_PENDING/);
 await assert.rejects(verifyWeChatAccount({...f,settings:f.b,wait:false,fetchImpl:async()=>response({...current,databaseAccounts:['wxid_a','wxid_b']})}),/HOOK_MULTIPLE_ACCOUNT_DATABASES/);
});
