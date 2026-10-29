import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hookProfile} from './hook-profiles.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';
import {validateConfig} from './project-config.mjs';
import {HookOneBot,onebotId} from './hook-onebot.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.15.13',
  profile:'4.1.15.13-text-v1',startupState:'ready',nativeTextSend:true,nativeStickerSend:false,databaseAccounts:['wxid_fixture']};

test('profiles keep the old backend intact and advertise current native API extensions separately',()=>{
  assert.equal(hookProfile('4.1.10.27').loader,'version-proxy');
  assert.equal(hookProfile('4.1.15.13').loader,'explicit-text');
  assert.equal(hookProfile('4.1.15.13').nativeSticker,false);
  assert.equal(hookProfile('4.1.15.13').nativeImageApi,true);
  assert.equal(hookProfile('4.1.15.13').nativeMentionApi,true);
  assert.equal(hookProfile('4.1.15.14'),null);
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.example.json'),'utf8'));
  validateConfig(config);
  config.hook.expectedVersion='4.1.15.13';config.hook.wechatExecutable='client/Weixin.exe';validateConfig(config);
  config.hook.expectedVersion='4.1.15.14';assert.throws(()=>validateConfig(config),/exactly matching/);
});

test('current health checks the mapped profile, construction readiness, exact version and account',()=>{
  assert.equal(hookAccountProblem(health,'wxid_fixture','4.1.15.13'),'');
  assert.equal(hookAccountProblem({...health,profile:undefined},'wxid_fixture','4.1.15.13'),'HOOK_INITIALIZATION_PENDING');
  assert.equal(hookAccountProblem({...health,nativeTextSend:false},'wxid_fixture','4.1.15.13'),'HOOK_INITIALIZATION_PENDING');
  assert.equal(hookAccountProblem(health,'wxid_other','4.1.15.13'),'HOOK_ACCOUNT_MISMATCH');
  assert.equal(hookAccountProblem({...health,databaseAccounts:['a','b']},'a','4.1.15.13'),'HOOK_MULTIPLE_ACCOUNT_DATABASES');
  assert.equal(hookAccountProblem(health,'wxid_fixture','4.1.10.27'),'HOOK_VERSION_MISMATCH');
});

function fixture(t,{receipt=true}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hook-41513-'));
  for(const name of ['config','state/hook'])fs.mkdirSync(path.join(directory,name),{recursive:true});
  t.after(()=>{assert(directory.startsWith(os.tmpdir()+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
  const target=onebotId('wxid_peer');let sends=0;
  fs.writeFileSync(path.join(directory,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},
    hook:{baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.1.15.13',requestTimeoutMs:1000},wechat:{whitelist:{private:[target],groups:[]}}}));
  fs.writeFileSync(path.join(directory,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'reader-fixture'}));
  fs.writeFileSync(path.join(directory,'state/hook/native-token.txt'),'a'.repeat(64));
  const adapter=new HookOneBot({directory,receiptTimeoutMs:5,pollMs:1,fetchImpl:async(url,init)=>{
    let body;
    if(url.endsWith('/WeChatAgent/health'))body=health;
    else if(url.includes('/reader/status'))body={backend:'weflow-cli-nt',ownWxid:'wxid_fixture',accountDirectory:'wxid_fixture'};
    else if(url.includes('/sessions?'))body={sessions:[{username:'wxid_peer',displayName:'Fixture'}]};
    else if(url.includes('/messages?'))body={messages:sends&&receipt?[{localId:51,serverId:'123456789',isSend:true,localType:1,createTime:Math.floor(Date.now()/1000),fullText:'fixture text'}]:[]};
    else if(url.endsWith('/SendTextMsg')){
      assert.equal(init.headers.Authorization,'Bearer '+'a'.repeat(64));
      assert.equal(init.headers['X-WeChatAgent-Account'],'wxid_fixture');
      assert.deepEqual(JSON.parse(init.body),{wxidorgid:'wxid_peer',msg:'fixture text'});sends++;body={ret:0};
    }else throw new Error('Unexpected isolated endpoint: '+url);
    return new Response(JSON.stringify(body));
  }});
  return {adapter,target,sends:()=>sends};
}

test('current version uses the unchanged server-receipt confirmation and deduplicates delivery IDs',async t=>{
  const {adapter,target,sends}=fixture(t);
  const result=await adapter.send('private',target,'fixture text','delivery-1');
  assert.equal(result.receipt,'wechat-server-id');assert.equal(result.message_id,51);
  assert.equal((await adapter.send('private',target,'fixture text','delivery-1')).reused,true);
  assert.equal(sends(),1);
});

test('native acceptance without a server receipt is not success and is not resubmitted',async t=>{
  const {adapter,target,sends}=fixture(t,{receipt:false});
  await assert.rejects(adapter.send('private',target,'fixture text','delivery-2'),/TEXT_DELIVERY_UNCONFIRMED/);
  await assert.rejects(adapter.send('private',target,'fixture text','delivery-2'),/TEXT_DELIVERY_UNCONFIRMED/);
  assert.equal(sends(),1);
});

test('current source keeps exact ABI checks, no UI fallback and no machine-specific configuration',()=>{
  const native=fs.readFileSync(path.join(root,'scripts/native-hook/text_4_1_15_13.cpp'),'utf8');
  assert.match(native,/SizeOfImage!=ImageSize/);assert.match(native,/base\+SenderTable\+16/);
  assert.match(native,/message\)\+0x758,text/);assert.match(native,/GuardProbe\(\)/);
  assert.match(native,/nativeImageSend",probeReady/);assert.match(native,/nativeStickerSend",false/);
  assert.doesNotMatch(native,/D:\\\\|QQAgent|SendInput\(|SetForegroundWindow\(|mouse_event\(|keybd_event\(/);
  assert.match(native,/server\.listen\("127\.0\.0\.1",port\)/);
});
