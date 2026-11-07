import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HookOneBot,onebotId} from './hook-onebot.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';

const health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.2.0.12',profile:'4.2.0.12-stickers-v2',startupState:'ready',nativeTextSend:true,nativeImageSend:true,nativeMentionSend:true,nativeStickerSend:true,databaseAccounts:['fixture-account']};
function fixture(t,{receipt=true,receiptType=34359738417,md5Matches=true,native=health,kind='private'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-gif-42012-'));t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
 const peer=kind==='group'?'fixture-room@chatroom':'fixture-peer',target=onebotId(peer),id='a'.repeat(64),md5='b'.repeat(32),delivery='c'.repeat(64);let submissions=0;
 const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 write('config/wechatagent.json',{runtime:{sender:'wechat-hook',weflowMode:'nt'},hook:{baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.2.0.12',requestTimeoutMs:1000},wechat:{whitelist:{private:kind==='private'?[target]:[],groups:kind==='group'?[target]:[]},stickers:{enabled:true,chats:{}}}});
 write('state/wechat-io-config.json',{reader_base_url:'http://127.0.0.1:5031',reader_token:'reader-fixture'});write('state/hook/native-token.txt','d'.repeat(64));
 const adapter=new HookOneBot({directory:root,receiptTimeoutMs:8,pollMs:1,fetchImpl:async(url,options)=>{
  let body;
  if(url.endsWith('/WeChatAgent/health'))body=native;
  else if(url.includes('/reader/status'))body={backend:'weflow-cli-nt',ownWxid:'fixture-self',accountDirectory:'fixture-account'};
  else if(url.includes('/sessions?'))body={sessions:[{username:peer,conversationId:target}]};
  else if(url.includes('/stickers/'+id))body={id,conversationKey:'wechat:'+kind+':'+target,path:path.join(root,'state/stickers/outgoing',md5+'.gif'),format:'gif',fields:{md5,len:1024}};
  else if(url.includes('/messages?'))body={messages:submissions&&receipt?[{localId:21,serverId:'9007199254740993',createTime:Math.floor(Date.now()/1000),isSend:1,localType:receiptType,stickerKind:'appmsg-8',stickerMd5:md5Matches?md5:'e'.repeat(32)}]:[]};
  else if(url.endsWith('/SendStickerMsg')){const request=JSON.parse(options.body);assert.equal(options.headers['X-WeChatAgent-Account'],'fixture-account');assert.equal(request.wxidorgid,peer);assert.equal(request.sticker.md5,md5);assert(request.path.endsWith('.gif'));submissions++;body={ret:0};}
  else throw Error('Unexpected endpoint '+url);
  return new Response(JSON.stringify(body));
 }});
 const request={action:kind==='group'?'send_group_msg':'send_private_msg',params:{[kind==='group'?'group_id':'user_id']:target,message:[{type:'wechat_sticker',data:{id}}],wechatagent_delivery_id:delivery}};
 return {adapter,request,get submissions(){return submissions;}};
}

test('4.2 GIF delivery uses the native sticker endpoint and confirms appmsg-8 receipts',async t=>{
 const f=fixture(t),first=await f.adapter.action(f.request);assert.equal(first.retcode,0);assert.equal(first.data.media_type,'wechat-sticker');assert.equal(first.data.receipt,'wechat-server-id');
 const second=await f.adapter.action(f.request);assert.equal(second.data.reused,true);assert.equal(f.submissions,1);
});
test('a missing receipt never becomes success and the same delivery is not submitted again',async t=>{
 const f=fixture(t,{receipt:false});assert.equal((await f.adapter.action(f.request)).message,'STICKER_DELIVERY_UNCONFIRMED');assert.equal((await f.adapter.action(f.request)).message,'STICKER_DELIVERY_UNCONFIRMED');assert.equal(f.submissions,1);assert.equal(f.adapter.targetsSending.size,0);
});
for(const options of [{receiptType:3},{md5Matches:false}])test('image or wrong-digest rows cannot confirm a native GIF '+JSON.stringify(options),async t=>{
 const f=fixture(t,options);assert.equal((await f.adapter.action(f.request)).message,'STICKER_DELIVERY_UNCONFIRMED');assert.equal(f.submissions,1);
});
test('old text-only components retain text readiness but cannot claim GIF availability',async t=>{
 const old={...health,profile:'4.2.0.12-experimental-v1',nativeStickerSend:false};assert.equal(hookAccountProblem(old,'fixture-account','4.2.0.12'),'');
 const f=fixture(t,{native:old});assert.equal((await f.adapter.action(f.request)).message,'NATIVE_STICKER_UNAVAILABLE');assert.equal(f.submissions,0);
 assert.equal(hookAccountProblem({...health,nativeStickerSend:false},'fixture-account','4.2.0.12'),'HOOK_INITIALIZATION_PENDING');
});
test('account mismatch blocks native GIF submission',async t=>{
 const f=fixture(t,{native:{...health,databaseAccounts:['another-account']}});assert.equal((await f.adapter.action(f.request)).message,'HOOK_ACCOUNT_MISMATCH');assert.equal(f.submissions,0);
});

test('group GIF delivery keeps the same scoped receipt and duplicate protection',async t=>{const f=fixture(t,{kind:'group'});assert.equal((await f.adapter.action(f.request)).retcode,0);assert.equal((await f.adapter.action(f.request)).data.reused,true);assert.equal(f.submissions,1);});
