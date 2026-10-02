import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent native context '));
  fs.mkdirSync(path.join(dir,'node_modules/@deepseek-ai/dsh-llm'),{recursive:true});
  fs.writeFileSync(path.join(dir,'node_modules/@deepseek-ai/dsh-llm/package.json'),'{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(dir,'node_modules/@deepseek-ai/dsh-llm/index.js'),'export const createUserMessage=value=>({...value,role:"user"});');
  const pluginDir=path.join(dir,'packages/dsh-social-bridge-plugin');fs.mkdirSync(pluginDir,{recursive:true});
  fs.copyFileSync('packages/dsh-social-bridge-plugin/native-context.mjs',path.join(pluginDir,'native-context.mjs'));
  fs.copyFileSync('packages/dsh-social-bridge-plugin/image-input.mjs',path.join(pluginDir,'image-input.mjs'));
  const {apply}=await import(pathToFileURL(path.join(pluginDir,'native-context.mjs')).href);
  const tokenFile=path.join(dir,'token.txt');fs.writeFileSync(tokenFile,'fixture-native-token');
  const statePath=path.join(dir,'sessions.json'), store=new Map(), servers=[],archived=new Set();
  t.after(async()=>{for(const server of servers.reverse())await server.stop();fs.rmSync(dir,{recursive:true,force:true});});
  async function start() {
    const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
    const listeners=new Map(), agents=new Map(), calls={create:[],resume:[],model:[],titles:[]};let disposer,turn=0;
    const emit=(name,...args)=>{for(const listener of listeners.get(name) ?? [])listener(...args);};
    const waterfall=async(name,payload,next)=>{const callbacks=listeners.get(name) ?? [];let at=0;const invoke=()=>at<callbacks.length?callbacks[at++](payload,invoke):next();return invoke();};
    function session(sid) {
      if(store.has(sid)){const restored=store.get(sid);restored.dispatch=emit;return restored;}
      const events=[{seq:0,type:'system/message',data:{message:{content:[{type:'text',text:'fixture system guard'}]}}}], nodes=[0], offloaded=new Set();let publishing=false;
      const session={id:sid,header:{agentPreset:'wechat-social'},surface:{nodes},dispatch:emit,snapshotEvents:()=>[...events],eventAt:seq=>events[seq],
        deriveEventMessage(event){return {...event.data,content:event.data.content?.map((block,index)=>offloaded.has(event.seq+':'+index)?{...block,offloaded:true}:block)};},
        append(type,data,opts){
          if(publishing)throw new Error('session append cannot reenter while another append is being published');
          const event={seq:events.length,type,data,...opts};events.push(event);if(['user/message','assistant/message'].includes(type))nodes.push(event.seq);
          if(type==='image/offload')for(const target of data.targets){let index=0;events[target.seq].data.content.forEach((block,blockIndex)=>{if(block.type==='image' && target.imageIndexes.includes(index++))offloaded.add(target.seq+':'+blockIndex);});}
          publishing=true;try{session.dispatch('session/event',session,event);}finally{publishing=false;}return event;
        }};
      store.set(sid,session);return session;
    }
    const compact=(sess,fail=false)=>{
      sess.append('compaction/start',{});
      if(!fail){const checkpoint=sess.append('user/message',{content:[{type:'text',text:'fixture compact summary'}],source:{kind:'compact-checkpoint'}},{surfaceOp:'append'});sess.surface.nodes.splice(1,sess.surface.nodes.length-1,checkpoint.seq);}
      sess.append('compaction/end',fail?{error:{message:'fixture summary failure'}}:{});
    };
    function register(sid){
      const sess=session(sid), agent={session:sess,ctx:{},autoCompact:false,overflowCompact:false,
        followup(message){queueMicrotask(async()=>{
          const id=++turn;sess.append('turn/start',{turn:id});
          if(archived.has(sid)){sess.append('turn/end',{turn:id,reason:{kind:'blocked'}});return;}
          if(agent.autoCompact){agent.autoCompact=false;compact(sess);}
          const decision=await waterfall('agent/pre-step',{agent,messages:[message],step:0},async()=>({kind:'enter',messages:[message]}));
          await waterfall('agent/request',{agent},async()=>({provider:'fixture-provider',model:'fixture-model'}));
          for(const input of decision.messages)sess.append('user/message',input,{surfaceOp:'append'});
          if(agent.overflowCompact){agent.overflowCompact=false;compact(sess);await waterfall('agent/request',{agent},async()=>({provider:'fixture-provider',model:'fixture-model'}));}
          calls.model.push(sess.surface.nodes.map(seq=>sess.eventAt(seq)).filter(e=>e.type==='user/message').flatMap(e=>e.data.content??[]).map(b=>b.text??'').join('\n'));
          sess.append('assistant/message',{turn:id,message:{content:[{type:'text',text:'SILENT'}]}},{surfaceOp:'append'});
          sess.append('turn/end',{turn:id,reason:{kind:'completed'}});
        });}};
      agents.set(sid,agent);return {dispose:async()=>agents.delete(sid)};
    }
    const ctx={logger:()=>({info(){},warn(){}}),on(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);},effect(fn){disposer=fn();},
      agentPresets:{resolve:async id=>({id}),mount:async (agentCtx,id)=>{agentCtx.preset=id;return {id};},composedPreset:agentCtx=>agentCtx.preset,serviceFor:(_agent,name)=>name==='compaction'?ctx.compaction:undefined},sessions:{get:sid=>store.get(sid),flush:async()=>true},
      sessionTitle:{get:sess=>sess.title,rename(sess,title){calls.titles.push(title);sess.title={title};sess.append('session/title',{title,source:{kind:'user'}});return sess.title;}},
      compaction:{compactNow:async agent=>{compact(agent.session);return {endSeq:agent.session.snapshotEvents().length-1};}},
      agents:{get:sid=>agents.get(sid),create:async options=>{calls.create.push(options);if(calls.failCreate)throw new Error('fixture creation failed');const handle=register(options.sessionId);await options.setup(agents.get(options.sessionId).ctx);return handle;},resume:async options=>{calls.resume.push(options);const handle=register(options.resumeSessionId);await options.setup(agents.get(options.resumeSessionId).ctx);return handle;}}};
    ctx.workspaceRegistry={get archivedSessionIds(){return [...archived];}};
    ctx.get=name=>ctx[name];ctx.llm={resolveModelInfo:async()=>({inputModalities:['text','image']})};
    ctx.attachments={saveImage:async image=>({attachmentId:'sha256:'+crypto.createHash('sha256').update(image.data).digest('hex'),mediaType:image.mediaType,width:1,height:1,bytes:image.data.length})};
    apply(ctx,{port,statePath,tokenFile,cwd:dir,provider:'fixture-provider',model:'fixture-model'});
    const request=async(route,body,expectedStatus=200)=>{
      const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer fixture-native-token','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(result));return result;
    };
    for(let i=0;i<50;i++){try{await request('/health');break;}catch{await new Promise(r=>setTimeout(r,10));}}
    let stopped=false;const runtime={request,calls,agents,compact,stop:async()=>{if(!stopped){stopped=true;await disposer();}}};servers.push(runtime);return runtime;
  }
  return {start,store,statePath,dir,archived};
}
const key='wechat:private:123', persona='固定测试人格：简短自然。', info={conversationKey:key,persona,personaName:'测试人格',conversationName:'测试好友'};

test('native session stores persona once, names sessions without a model call, and preserves context on resume',async t=>{
  const f=await fixture(t), first=await f.start();
  const configured=await first.request('/configure',info);assert.equal(first.calls.model.length,0);assert.equal(configured.title,'微信私聊｜测试好友｜测试人格');
  const a=await first.request('/followup',{...info,message:'第一条新消息'});
  await first.request('/followup',{...info,message:'第二条新消息'});
  const before=f.store.get(a.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length;
  assert.equal(before,1);assert.equal(first.calls.create.length,1);assert.match(first.calls.model[1],/第一条新消息/);
  assert.equal(first.agents.get(a.sessionId).ctx.preset,'wechat-social');
  await first.stop();const second=await f.start();
  const resumed=await second.request('/followup',{...info,message:'第三条新消息'});assert.equal(resumed.sessionId,a.sessionId);
  assert.equal(second.calls.resume.length,1);assert.deepEqual(second.calls.resume[0].agentOptions,{provider:'fixture-provider',model:'fixture-model'});
  assert.equal(f.store.get(a.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,1);
});
test('manual and automatic compaction each restore persona once in the same session',async t=>{
  const f=await fixture(t), r=await f.start(), a=await r.request('/followup',{...info,message:'压缩前'});
  await r.request('/compact',{conversationKey:key});await r.request('/followup',{...info,message:'手动压缩后'});
  r.agents.get(a.sessionId).autoCompact=true;await r.request('/followup',{...info,message:'自动压缩后'});
  const sess=f.store.get(a.sessionId);assert.equal(sess.snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,3);
  assert.equal((r.calls.model.at(-1).match(/固定测试人格/g)??[]).length,1);assert.equal(r.calls.create.length,1);
});
test('overflow retry restores persona before a request without another pre-step',async t=>{
  const f=await fixture(t),r=await f.start(),a=await r.request('/followup',{...info,message:'第一轮'});
  r.agents.get(a.sessionId).overflowCompact=true;await r.request('/followup',{...info,message:'重试轮'});
  assert.match(r.calls.model.at(-1),/固定测试人格/);assert.equal(f.store.get(a.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,2);
});
test('failed compaction keeps existing persona and duplicate batches avoid another model call',async t=>{
  const f=await fixture(t),r=await f.start();const body={...info,message:'一次输入',batchId:'a'.repeat(64)};
  const a=await r.request('/followup',body);r.compact(f.store.get(a.sessionId),true);
  const retry=await r.request('/followup',body);assert.equal(retry.cached,true);assert.equal(r.calls.model.length,1);
  await r.request('/followup',{...info,message:'下一条'});assert.equal(f.store.get(a.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,1);
});
test('persona changes reinitialize only that conversation and groups receive their own names',async t=>{
  const f=await fixture(t),r=await f.start(),a=await r.request('/followup',{...info,message:'私聊一'});
  const group=await r.request('/followup',{...info,conversationKey:'wechat:group:456',conversationName:'测试群',message:'群聊一'});
  assert.notEqual(group.sessionId,a.sessionId);assert(r.calls.titles.includes('微信群聊｜测试群｜测试人格'));
  await r.request('/followup',{...info,persona:'新的固定人格',message:'切换人格'});
  assert.equal(f.store.get(a.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,2);
  assert.equal(f.store.get(group.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,1);
});

test('image completion offloads after the native append publisher returns and never offloads twice',async t=>{
  const f=await fixture(t),r=await f.start(),id='b'.repeat(64),bytes=Buffer.from('fixture image');
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-reader');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({imageId:id,conversationKey:key,b64:bytes.toString('base64'),mime:'image/jpeg',sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  fs.mkdirSync(path.join(f.dir,'state'));fs.writeFileSync(path.join(f.dir,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:`http://127.0.0.1:${server.address().port}`,reader_token:'fixture-reader'}));
  const result=await r.request('/followup',{...info,message:'请看测试图片',images:[{id}]});
  const session=f.store.get(result.sessionId),events=session.snapshotEvents();
  const imageEvent=events.find(e=>e.type==='user/message' && e.data.source?.socialImageIds);
  assert(imageEvent.data.content.some(block=>block.type==='image'));
  const offload=events.find(e=>e.type==='image/offload'),end=events.findLast(e=>e.type==='turn/end');
  assert(offload && offload.seq>end.seq);assert.equal(session.deriveEventMessage(imageEvent).content.at(-1).offloaded,true);
  await r.request('/followup',{...info,message:'下一轮只发文字'});
  assert.equal(session.snapshotEvents().filter(e=>e.type==='image/offload').length,1);
});

test('archiving a chat rotates only its session, preserves the archive and resumes the fresh mapping after restart',async t=>{
  const f=await fixture(t),r=await f.start();
  const old=await r.request('/followup',{...info,message:'旧会话里的内容'});
  const group=await r.request('/followup',{...info,conversationKey:'wechat:group:456',message:'另一个群的内容'});
  const oldEvents=f.store.get(old.sessionId).snapshotEvents();f.archived.add(old.sessionId);
  const fresh=await r.request('/followup',{...info,message:'归档后的新消息'});
  assert.notEqual(fresh.sessionId,old.sessionId);assert(f.archived.has(old.sessionId));
  assert.deepEqual(f.store.get(old.sessionId).snapshotEvents(),oldEvents);
  assert(!r.calls.model.at(-1).includes('旧会话里的内容'));
  assert.equal(f.store.get(fresh.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,1);
  const listed=await r.request('/sessions');assert.equal(listed.sessions.find(s=>s.conversationKey===key).generation,1);
  assert.equal(listed.sessions.find(s=>s.conversationKey==='wechat:group:456').sessionId,group.sessionId);
  await r.stop();const resumed=await f.start();
  const next=await resumed.request('/followup',{...info,message:'重启后的续聊'});
  assert.equal(next.sessionId,fresh.sessionId);assert.equal(resumed.calls.resume.length,1);
  assert.equal(f.store.get(fresh.sessionId).snapshotEvents().filter(e=>e.data?.source?.socialBootstrap).length,1);
});

test('failed replacement creation keeps the archived mapping and retry allocates the same fresh generation',async t=>{
  const f=await fixture(t),r=await f.start();const old=await r.request('/followup',{...info,message:'归档前'});
  f.archived.add(old.sessionId);r.calls.failCreate=true;
  await r.request('/followup',{...info,message:'第一次恢复'},503);
  const failedTarget=r.calls.create.at(-1).sessionId;
  const saved=JSON.parse(fs.readFileSync(f.statePath,'utf8'));assert.equal(saved.conversations[key],old.sessionId);
  assert.equal(saved.profiles[key].generation,undefined);
  r.calls.failCreate=false;const fresh=await r.request('/followup',{...info,message:'再次恢复'});
  assert.equal(fresh.sessionId,failedTarget);assert(f.archived.has(old.sessionId));
  f.archived.add(fresh.sessionId);const next=await r.request('/followup',{...info,message:'再次归档后'});
  assert.notEqual(next.sessionId,fresh.sessionId);
  assert.equal((await r.request('/sessions')).sessions.find(s=>s.conversationKey===key).generation,2);
});
