// Portable contract checks only: no DLL load, native call or real message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hookAccountProblem} from './wechat-account-check.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'scripts/native-hook/text_4_1_15_13.cpp'),'utf8');
const profile=fs.readFileSync(path.join(root,'scripts/native-hook/text_profile_4_1_15_13.h'),'utf8');
const read=name=>fs.readFileSync(path.join(root,'scripts',name),'utf8');

test('new API health remains compatible with exact-version and single-account gates',()=>{
  const health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.15.13',profile:'4.1.15.13-media-mentions-v2',
    startupState:'ready',nativeTextSend:true,nativeImageSend:true,nativeMentionSend:true,databaseAccounts:['wxid_fixture']};
  assert.equal(hookAccountProblem(health,'wxid_fixture','4.1.15.13'),'');
  assert.equal(hookAccountProblem({...health,profile:'unreviewed'},'wxid_fixture','4.1.15.13'),'HOOK_INITIALIZATION_PENDING');
  assert.equal(hookAccountProblem(health,'wxid_other','4.1.15.13'),'HOOK_ACCOUNT_MISMATCH');
  assert.equal(hookAccountProblem(health,'wxid_fixture','4.1.15.14'),'HOOK_VERSION_MISMATCH');
});

test('images use the mapped image constructor and native wide path, not a text field or UI',()=>{
  assert.match(profile,/ImageCtorRva=0x1a81f70/);assert.match(profile,/ImageMessageTable=0x90dad78/);
  assert.match(source,/image\?ImageCtorRva:TextCtorRva/);assert.match(source,/image\?ImageMessageTable:MessageTable/);
  assert.match(source,/SetWideString\(static_cast<BYTE\*>\(message\)\+0x120,file.wstring\(\)\)/);
  assert.match(source,/GuardImage\(&target,&file,bytes\)/);
  assert.doesNotMatch(source,/SendInput\(|SetForegroundWindow\(|mouse_event\(|keybd_event\(/);
});

test('image API confines canonical local files to outgoing media and validates bytes/size',()=>{
  assert.match(source,/candidate.is_absolute\(\)/);assert.match(source,/weakly_canonical\(candidate\)/);
  assert.match(source,/relative\.is_absolute\(\)\|\|\*relative.begin\(\)==L"\.\."/);
  assert.match(source,/size>32\*1024\*1024/);assert.match(source,/only PNG, JPEG and WebP/);
  assert.match(read('load-hook-current.ps1'),/state\\hook\\outgoing-images/);
  assert.doesNotMatch(source,/QQAgent|chatgpt-image|D:\\\\/);
});

test('real mentions use at_user_list with bounded member IDs and require a group target',()=>{
  assert.match(source,/SetString\(static_cast<BYTE\*>\(message\)\+0x778,atList\)/);
  assert.match(source,/target.substr\(target.size\(\)-9\)!="@chatroom"/);
  assert.match(source,/values.size\(\)>8/);assert.match(source,/id.find_first_not_of/);
  assert.match(source,/seen.insert\(id\).second/);assert.match(source,/MentionList\(body.at\("atUserIds"\)\)/);
});

test('both new routes require authentication/account readiness and keep uncertain submissions distinct',()=>{
  for(const route of ['/SendImgMsg','/SendTextAtMsg']){
    const handler=source.split('server.Post("'+route+'"')[1]?.split('\n    });')[0];assert.ok(handler);
    assert.match(handler,/authorized\(req,res\)/);assert.match(handler,/lock\(sendMutex\)/);assert.match(handler,/readyFor\(req,res\)/);
    assert.match(handler,/res.status=400/);assert.match(handler,/res.status=503/);assert.match(handler,/do not retry/);
  }
  assert.match(source,/nativeQuoteSend",false/);assert.match(source,/nativeStickerSend",false/);
  assert.match(read('load-hook-current.ps1'),/health.profile -ne \$build.profile/);
  assert.match(read('build-hook-current.ps1'),/profile='4.1.15.13-media-mentions-v2'/);
});
