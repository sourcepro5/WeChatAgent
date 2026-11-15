import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseSocialDecision,resolveSocialDecision,cleanReplyProtocol,hasReplyProtocolControl} from '../components/qq-bridge/src/core/decision-format.js';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {ProactiveEngine} from '../components/qq-bridge/src/core/proactive-engine.js';
import {PROACTIVE_DEFAULTS} from '../components/qq-bridge/src/core/proactive-policy.js';
const key='wechat:private:123';
const message=(id='fixture',kind='private')=>({platform:'wechat',kind,conversation_id:'123',sender_id:'456',self_id:'99',message_id:id,text:'你好',direct_mention:true,timestamp:Date.now()/1000});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-protocol-'));t.after(()=>{assert(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {dir,buffer:new MessageBuffer(path.join(dir,'messages.json'))};}
async function until(check){for(let i=0;i<250;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('protocol fixture timeout');}

test('duplicate and per-line RESPOND envelopes are removed before replies are split into messages',()=>{
 for(const raw of ['RESPOND: RESPOND: 你好','RESPOND: respond：你好','respond: RESPOND: respond: 你好','RESPOND: \u200brespond\u200b:\ufeff你好','RESPOND:\nRESPOND:\n你好','```text\nRESPOND: respond: 你好\n```']){
  assert.deepEqual(parseSocialDecision(raw),{decision:'RESPOND',text:'你好'},raw);
 }
 const result=parseSocialDecision('RESPOND: respond: 第一段\n\nRESPOND：第二段\nrespond: 同一段续行');
 assert.deepEqual(result.textParts,['第一段','第二段\n同一段续行']);assert.equal(result.text,'第一段\n\n第二段\n同一段续行');assert.equal(cleanReplyProtocol(result.text),result.text);
});

test('normal English, inline quotations and closed code examples preserve their content',()=>{
 const bodies=['Please respond: hello','respond to this message','这里讨论 RESPOND: 的含义','`RESPOND:` 是一个标记','> RESPOND: 这是引用','Response: 保留普通内容','示例：\n```text\nRESPOND: 你好\n\nrespond: 第二行示例\n```'];
 for(const body of bodies){const result=parseSocialDecision('RESPOND: '+body);assert.equal(result.decision,'RESPOND');assert.equal(result.text,body);assert.equal(hasReplyProtocolControl(body),false);}
 assert.equal(parseSocialDecision('RESPOND: '+bodies.at(-1)).textParts,undefined,'Do not split a fenced example across messages');
});

test('normalizing envelopes preserves silence and bound sticker choices without accepting reasoning or unmarked prose',()=>{
 const id='a'.repeat(64);assert.equal(parseSocialDecision('RESPOND: respond: SILENT').decision,'SILENT');
 assert.deepEqual(parseSocialDecision('RESPOND: RESPOND: [STICKER:S1]',{S1:id}),{decision:'STICKER',stickerId:id,text:''});
 const caption=parseSocialDecision('RESPOND: respond: 早\nRESPOND: [STICKER:S1]',{S1:id},{allowStickerCaption:true});assert.equal(caption.text,'早');assert.equal(caption.stickerId,id);
 for(const raw of ['RESPOND:respond:<think>private</think>你好','RESPOND:respond:[S9]','没有协议的普通模型输出','RESPOND: '+ 'RESPOND: '.repeat(20)+'你好'])assert.equal(parseSocialDecision(raw).decision,'INVALID',raw);
});

test('ambiguous decorated headers receive only one bounded correction with a fresh deterministic repair identity',async()=>{
 const raw='RESPOND: **RESPOND:** 你好',metadata={batchId:'b'.repeat(64)};assert.equal(parseSocialDecision(raw).decision,'INVALID');
 const ids=[];let calls=0;
 for(let i=0;i<2;i++){
  const result=await resolveSocialDecision({rawOutput:raw,key,metadata,decide:async(_key,_prompt,options)=>{calls++;ids.push(options.batchId);return 'RESPOND: respond: 你好';}});assert.equal(result.result.text,'你好');
 }
 assert.equal(calls,2);assert.equal(ids[0],ids[1]);assert.notEqual(ids[0],metadata.batchId);
 let invalidCalls=0;const invalid=await resolveSocialDecision({rawOutput:raw,key,metadata,decide:async()=>{invalidCalls++;return raw;}});assert.equal(invalidCalls,1);assert.equal(invalid.result.decision,'INVALID');
});

test('private and group replies deliver cleaned bodies once and record only actual text',async t=>{
 for(const kind of ['private','group']){
  const f=fixture(t),sent=[];let calls=0;
  const engine=new SocialEngine({buffer:f.buffer,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,decide:async()=>{calls++;return 'RESPOND: respond: 第一段\n\nRESPOND: 第二段';},send:async(_target,text)=>{sent.push(text);return{delivered:'database-confirmed'};}});t.after(()=>engine.stop());
  const msg=message(kind,kind),chat='wechat:'+kind+':123';engine.receive(msg);await until(()=>f.buffer.unread(chat).length===0&&!engine.running.has(chat));
  assert.deepEqual(sent,['第一段','第二段']);assert.equal(calls,1);assert.deepEqual(f.buffer.recent(chat).filter(row=>row.outgoing).map(row=>row.text),sent);
 }
});

test('an old queued protocol prefix is cancelled without changing confirmed history or blocking new messages',async t=>{
 const f=fixture(t),msg=message(),sent=[];let calls=0;f.buffer.append(msg);const throughId=f.buffer.unread(key)[0].id,deliveryId='c'.repeat(64);
 const result={decision:'RESPOND',text:'已确认第一段\n\nRESPOND: 旧的第二段',textParts:['已确认第一段','RESPOND: 旧的第二段']},parts=replyDeliveryParts(result,deliveryId);parts[0].state='confirmed';
 f.buffer.recordReplyPart(key,{deliveryId:parts[0].deliveryId},{...msg,text:'已确认第一段',delivery_status:'confirmed',timestamp:Date.now()/1000});
 f.buffer.rememberReply(key,{result,parts,throughId,deliveryId,message:msg,sending:true});
 const restored=new MessageBuffer(path.join(f.dir,'messages.json')),engine=new SocialEngine({buffer:restored,batchMs:1,privateMinIntervalMs:0,maxPerMinute:100,decide:async()=>{calls++;return 'RESPOND: respond: 新回复';},send:async(_target,text)=>{sent.push(text);return{delivered:'database-confirmed'};}});t.after(()=>engine.stop());
 engine.replay(key);await until(()=>restored.pendingReplies.size===0&&restored.unread(key).length===0&&!engine.running.has(key));assert.deepEqual(sent,[]);assert.equal(calls,0);assert.match(restored.contextNotices.get(key).text,/协议/);
 assert.deepEqual(restored.recent(key).filter(row=>row.outgoing).map(row=>row.text),['已确认第一段']);
 engine.receive(message('after-restart'));await until(()=>sent.length===1&&restored.unread(key).length===0);assert.deepEqual(sent,['新回复']);assert.equal(calls,1);
 assert.equal(restored.recent(key).filter(row=>row.outgoing&&row.text==='已确认第一段').length,1);
});

test('proactive greetings normalize protocol without changing the existing message layout',async t=>{
 const f=fixture(t),sent=[];let now=Date.parse('2026-10-19T02:00:00Z'),calls=0;
 const settings={wechat:{whitelist:{private:['123'],groups:[]},proactive:{...PROACTIVE_DEFAULTS,enabled:true,mode:'greeting',intervalMinutes:30,idleMinutes:5,jitterMinutes:0,chats:{[key]:true}}}};
 const social=new SocialEngine({buffer:f.buffer,decide:async()=> 'SILENT',send:async()=>{throw Error('No unrelated sends');}});t.after(()=>social.stop());
 const proactive=new ProactiveEngine({stateFile:path.join(f.dir,'proactive.json'),buffer:f.buffer,social,settingsFor:()=>settings,personaFor:()=>({persona:'offline fixture persona',personaName:'Fixture'}),selfIdFor:()=> '99',now:()=>now,random:()=>0,decide:async()=>{calls++;return 'RESPOND: respond: 早\n\nRESPOND: 今天好好聊';},send:async(_target,text)=>{sent.push(text);return{delivered:'database-confirmed'};}});
 await proactive.tick();now+=30*60000;await proactive.tick();assert.equal(calls,1);assert.equal(sent.join('\n\n'),'早\n\n今天好好聊');assert(sent.every(text=>!hasReplyProtocolControl(text)));
});

test('a legacy proactive draft containing a protocol marker is cancelled on restart',async t=>{
 const f=fixture(t),sent=[];let now=Date.parse('2026-10-19T02:00:00Z'),calls=0;
 const settings={wechat:{whitelist:{private:['123'],groups:[]},proactive:{...PROACTIVE_DEFAULTS,enabled:true,mode:'greeting',intervalMinutes:30,idleMinutes:5,jitterMinutes:0,chats:{[key]:true}}}};
 const social=new SocialEngine({buffer:f.buffer,decide:async()=> 'SILENT',send:async()=>{throw Error('No unrelated sends');}});t.after(()=>social.stop());
 const stateFile=path.join(f.dir,'proactive.json'),make=()=>new ProactiveEngine({stateFile,buffer:f.buffer,social,settingsFor:()=>settings,personaFor:()=>({persona:'offline fixture persona',personaName:'Fixture'}),selfIdFor:()=> '99',now:()=>now,random:()=>0,decide:async()=>{calls++;return 'RESPOND: 早';},send:async()=>{throw Object.assign(Error('fixture busy'),{code:'SENDER_BUSY'});}});
 const proactive=make();await proactive.tick();now+=30*60000;await proactive.tick();assert.equal(calls,1);assert(proactive.state.chats[key].job);
 const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));state.chats[key].job.text='RESPOND: 旧草稿';fs.writeFileSync(stateFile,JSON.stringify(state));
 const restored=make();restored.send=async(_target,text)=>sent.push(text);await restored.tick();await restored.tick();
 assert.deepEqual(sent,[]);assert.equal(calls,1);assert.equal(restored.state.chats[key].job,null);assert(f.buffer.contextNotices.has(key));assert.equal(f.buffer.recent(key).filter(row=>row.outgoing).length,0);
});

// ---- DSH RESPOND_VOICE: one voice message per turn, delivered by WCA ----
import crypto from 'node:crypto';
import {SOCIAL_VOICE_NOTICE,MAX_VOICE_REPLY_CHARS} from '../components/qq-bridge/src/core/decision-format.js';

test('RESPOND_VOICE parses only when voice is offered and suitable; otherwise valid text stays text',()=>{
 assert.deepEqual(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。',{},{allowVoice:true}),{decision:'RESPOND',mode:'voice',text:'好的，我念给你听。'});
 assert.deepEqual(parseSocialDecision('语音回复：好的',{},{allowVoice:true}),{decision:'RESPOND',mode:'voice',text:'好的'});
 assert.equal(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。').mode,undefined);
 assert.equal(parseSocialDecision('RESPOND_VOICE: 好的，我念给你听。').text,'好的，我念给你听。');
 for(const text of ['链接是 https://example.com/a','```\nls -la\n```','长'.repeat(MAX_VOICE_REPLY_CHARS+1)]){
  const result=parseSocialDecision('RESPOND_VOICE: '+text,{},{allowVoice:true});
  assert.equal(result.decision,'RESPOND');assert.equal(result.mode,undefined);assert(!/RESPOND_VOICE/.test(result.text));
 }
 assert.deepEqual(parseSocialDecision('RESPOND_VOICE: SILENT',{},{allowVoice:true}),{decision:'SILENT',text:''});
 assert.equal(parseSocialDecision('RESPOND_VOICE: ',{},{allowVoice:true}).decision,'INVALID');
 assert.equal(cleanReplyProtocol('RESPOND_VOICE: 你好'),'你好');
 assert(hasReplyProtocolControl('你好\nRESPOND_VOICE: 再见'));
 assert.deepEqual(replyDeliveryParts({decision:'RESPOND',mode:'voice',text:'你好'},'e'.repeat(64)).map(part=>part.voiceText),['你好']);
});

function voiceEngine(f,{voiceAllowed=true,sendVoice,decide,buffer=f.buffer}={}){
 const sent=[],voiced=[],prompts=[];let calls=0;
 const engine=new SocialEngine({buffer,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,
  deliveryRetry:{receiptDelayMs:5,busyDelayMs:5},voiceReplyFor:async()=>voiceAllowed,
  decide:async(_key,prompt)=>{calls++;prompts.push(prompt);return decide?decide():'RESPOND_VOICE: 我用语音回你。';},
  sendVoice:async(target,text,options)=>{voiced.push({text,deliveryId:options.deliveryId,chat:target.conversation_id});return sendVoice?sendVoice(voiced.length):{status:'confirmed'};},
  send:async(_target,text,options)=>{sent.push({text,deliveryId:options?.deliveryId});return{delivered:'database-confirmed'};}});
 return {engine,sent,voiced,prompts,calls:()=>calls};
}

test('a voice turn sends exactly one voice message, no text, and a restart sends nothing more',async t=>{
 const f=fixture(t),run=voiceEngine(f);t.after(()=>run.engine.stop());
 run.engine.receive(message('voice-1'));await until(()=>f.buffer.unread(key).length===0&&!run.engine.running.has(key)&&run.voiced.length===1);
 assert(run.prompts[0].includes(SOCIAL_VOICE_NOTICE));
 assert.deepEqual(run.sent,[]);assert.equal(run.voiced[0].text,'我用语音回你。');assert.match(run.voiced[0].deliveryId,/^[a-f0-9]{64}$/);
 assert.deepEqual(f.buffer.recent(key).filter(row=>row.outgoing).map(row=>row.text),['[语音] 我用语音回你。']);
 run.engine.receive(message('voice-1'));await new Promise(resolve=>setTimeout(resolve,60));
 run.engine.stop();
 const restored=new MessageBuffer(path.join(f.dir,'messages.json')),again=voiceEngine(f,{buffer:restored});t.after(()=>again.engine.stop());
 again.engine.replay(key);await new Promise(resolve=>setTimeout(resolve,60));
 assert.deepEqual([run.voiced.length,run.sent.length,again.voiced.length,again.sent.length,again.calls()],[1,0,0,0,0]);
});

test('a definite synthesis failure falls back to one text message with its own delivery ID',async t=>{
 const f=fixture(t),run=voiceEngine(f,{sendVoice:()=>({status:'rejected',fallback:true,error:'VOICE_TTS_FAILED'})});t.after(()=>run.engine.stop());
 run.engine.receive(message('voice-2'));await until(()=>run.sent.length===1&&!run.engine.running.has(key));
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(run.voiced.length,1);assert.equal(run.sent.length,1);assert.equal(run.sent[0].text,'我用语音回你。');
 assert.equal(run.sent[0].deliveryId,crypto.createHash('sha256').update(run.voiced[0].deliveryId+'\0voice-fallback').digest('hex'));
 assert.deepEqual(f.buffer.recent(key).filter(row=>row.outgoing).map(row=>row.text),['我用语音回你。']);
});

test('uncertain or rejected voice deliveries are never replaced by text',async t=>{
 for(const [label,sendVoice] of [
  ['pending',()=>({status:'pending'})],
  ['rejected',()=>({status:'rejected',error:'VOICE_NATIVE_REJECTED'})],
  ['timeout',()=>{throw Error('OneBot action timeout: send_voice_text');}],
 ]){
  const f=fixture(t),run=voiceEngine(f,{sendVoice});t.after(()=>run.engine.stop());
  run.engine.receive(message('voice-'+label));await until(()=>f.buffer.unread(key).length===0&&!run.engine.running.has(key)&&f.buffer.pendingReplies.size===0);
  assert.deepEqual(run.sent,[],label);assert(run.voiced.length>=1,label);
  assert.equal(new Set(run.voiced.map(item=>item.deliveryId)).size,1,label+' keeps one delivery ID for receipt checks');
  if(label==='pending')assert.equal(run.voiced.length,3,'two receipt checks after the first submit');
  else assert.equal(run.voiced.length,1,label);
 }
});

test('a persisted submitted voice part only re-checks its receipt after restart',async t=>{
 const f=fixture(t),msg=message('voice-restart');f.buffer.append(msg);const throughId=f.buffer.unread(key)[0].id,deliveryId='f'.repeat(64);
 const result={decision:'RESPOND',mode:'voice',text:'重启前已提交的语音'},parts=replyDeliveryParts(result,deliveryId);parts[0].state='submitted';
 f.buffer.rememberReply(key,{result,parts,throughId,deliveryId,message:msg,sending:true});
 const restored=new MessageBuffer(path.join(f.dir,'messages.json')),run=voiceEngine(f,{buffer:restored});t.after(()=>run.engine.stop());
 run.engine.replay(key);await until(()=>restored.pendingReplies.size===0&&!run.engine.running.has(key));
 assert.equal(run.calls(),0);assert.deepEqual(run.sent,[]);assert.deepEqual(run.voiced.map(item=>[item.text,item.deliveryId]),[['重启前已提交的语音',parts[0].deliveryId]]);
 assert.deepEqual(restored.recent(key).filter(row=>row.outgoing).map(row=>row.text),['[语音] 重启前已提交的语音']);
});

test('without a voice-capable backend the prompt has no voice notice and RESPOND_VOICE is sent as text',async t=>{
 const f=fixture(t),run=voiceEngine(f,{voiceAllowed:false,decide:()=>'RESPOND_VOICE: 只能打字。'});t.after(()=>run.engine.stop());
 run.engine.receive(message('voice-off'));await until(()=>run.sent.length===1&&!run.engine.running.has(key));
 assert(!run.prompts[0].includes(SOCIAL_VOICE_NOTICE));assert.deepEqual(run.voiced,[]);assert.equal(run.sent[0].text,'只能打字。');
 const plain=fixture(t),textRun=voiceEngine(plain,{decide:()=>'RESPOND: 普通文字回复'});t.after(()=>textRun.engine.stop());
 textRun.engine.receive(message('text-turn'));await until(()=>textRun.sent.length===1&&!textRun.engine.running.has(key));
 assert.deepEqual([textRun.sent[0].text,textRun.voiced.length],['普通文字回复',0]);
});
