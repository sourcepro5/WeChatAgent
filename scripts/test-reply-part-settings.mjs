import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {replyMessageLimit,validateReplyLayout,replyLayoutNotice} from '../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import {parseSocialDecision,resolveSocialDecision} from '../components/qq-bridge/src/core/decision-format.js';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {verifiedAssistantSender} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {stableChatInstructions} from '../packages/dsh-social-bridge-plugin/prompt-context.mjs';
import {createConsole} from './console-server.mjs';import {createWorkspaceLayout} from '../public/console/workspace-layout.js';
const sender='wxid_part_fixture',senderId=String(Number(crypto.createHash('sha256').update(sender).digest().readBigUInt64BE(0)%2147483647n+1n)),key='wechat:private:'+senderId;
const message={platform:'wechat',kind:'private',conversation_id:senderId,sender_id:senderId,sender_wxid:sender,self_id:'99',message_id:'first',text:'说明一下',timestamp:Date.now()/1000};
const paragraphs=n=>Array.from({length:n},(_,i)=>'第 '+(i+1)+' 段'),output=n=>'RESPOND: '+paragraphs(n).join('\n\n');
async function until(check){for(let i=0;i<600;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,3));}assert.fail('reply parts fixture timeout');}
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'reply-parts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('zero preserves every model paragraph beyond twenty, positive limits merge overflow without dropping content, and one stays whole',()=>{
 const raw=output(31),all=paragraphs(31);assert.deepEqual(parseSocialDecision(raw,{}, {maxTextParts:0}).textParts,all);assert.equal(parseSocialDecision(raw,{}, {maxTextParts:1}).textParts,undefined);
 const limited=parseSocialDecision(raw,{}, {maxTextParts:3});assert.equal(limited.textParts.length,3);assert.equal(limited.textParts[2],all.slice(2).join('\n\n'));assert.equal(limited.text,all.join('\n\n'));
 assert.equal(parseSocialDecision('RESPOND: ```js\nlet x = 1;\n\nx++;\n```',{}, {maxTextParts:0}).textParts,undefined);
 for(const value of [0,1,2,20])validateReplyLayout({maxMessages:value});for(const value of [-1,21,1.5,'0',null,true])assert.throws(()=>validateReplyLayout({maxMessages:value}));assert.equal(replyMessageLimit({}),2);assert.equal(replyMessageLimit({replyLayout:{maxMessages:0}}),0);assert(!replyLayoutNotice(0).includes('最多两条'));assert(replyLayoutNotice(0).includes('不设固定条数上限'));
});

test('each segment gets a unique ID while the old first, second and sticker IDs remain compatible',()=>{
 const id='a'.repeat(64),hash=value=>crypto.createHash('sha256').update(value).digest('hex'),result={decision:'RESPOND',text:paragraphs(31).join('\n\n'),textParts:paragraphs(31),stickerId:'b'.repeat(64)},parts=replyDeliveryParts(result,id);assert.equal(parts.length,32);assert.equal(new Set(parts.map(p=>p.deliveryId)).size,32);assert.equal(parts[0].deliveryId,id);assert.equal(parts[1].deliveryId,hash(id+'\0text-2'));assert.equal(parts[2].deliveryId,hash(id+'\0text-3'));assert.equal(parts.at(-1).deliveryId,hash(id+'\0sticker'));
});

function fixture(t,{limit=0,count=5,failAt=0,uncertainAt=0,quota=100,hold=false,holdPartAt=0}={}){
 const root=temp(t),file=path.join(root,'messages.json'),adapter=new WechatOneBotAdapter(),sent=[],attempts=[],engines=[],inputs=[];let current=limit,calls=0,failed=false,release,releasePart,partHeld=false;
 adapter.server.action=async(_action,params)=>{const text=params.message[0].data.text,id=params.wechatagent_delivery_id;attempts.push({text,id});const index=paragraphs(count).indexOf(text)+1;if(holdPartAt>0&&index===holdPartAt&&!partHeld){partHeld=true;await new Promise(resolve=>releasePart=resolve);}if(failAt>0&&index===failAt&&!failed){failed=true;throw Object.assign(Error('fixture offline'),{code:'FIXTURE_OFFLINE'});}if(uncertainAt>0&&index===uncertainAt)throw Object.assign(Error('uncertain fixture'),{code:'TEXT_DELIVERY_UNCONFIRMED',data:{attempted:true}});sent.push({text,id});return {status:'ok',retcode:0,data:{receipt:'wechat-server-id'}};};
 const make=(buffer=new MessageBuffer(file))=>{const engine=new SocialEngine({buffer,maxTextPartsFor:()=>current,workModeFor:()=> 'assistant',assistantAccess:(_key,row)=>verifiedAssistantSender(row)===sender,assistantBatchMs:1,batchMs:1,privateMinIntervalMs:0,maxPerMinute:quota,maxPerTenMinutes:1000,stickerPolicyFor:()=>({enabled:false}),decide:async(_key,prompt,meta)=>{calls++;inputs.push(meta.replyMaxMessages);if(hold&&calls===1)await new Promise(resolve=>release=resolve);return output(count);},send:(row,text,opts)=>adapter.sendText({kind:row.kind,target:row.conversation_id,text,deliveryId:opts.deliveryId})});engines.push(engine);return engine;};
 const engine=make();t.after(()=>{for(const item of engines)item.stop();release?.();releasePart?.();});return {root,file,engine,make,sent,attempts,inputs,setLimit:value=>current=value,release:()=>release?.(),releasePart:()=>releasePart?.(),get partHeld(){return partHeld;},get calls(){return calls;},get failed(){return failed;}};
}

test('unlimited ordinary replies deliver thirty-one real adapter frames in one model turn',async t=>{
 const f=fixture(t,{count:31});f.engine.receive(message);await until(()=>f.engine.buffer.unread(key).length===0);assert.equal(f.calls,1);assert.equal(f.sent.length,31);assert.equal(new Set(f.sent.map(item=>item.id)).size,31);assert.deepEqual(f.sent.map(item=>item.text),paragraphs(31));
});

test('a third-part failure survives reload with verified sender identity and resumes only unsent parts',async t=>{
 const f=fixture(t,{failAt:3});f.engine.receive(message);await until(()=>f.failed&&!f.engine.running.has(key));f.engine.stop();const buffer=new MessageBuffer(f.file);assert.equal(buffer.pendingReplies.get(key).message.sender_wxid,sender);assert.equal(buffer.pendingReplies.get(key).parts.length,5);const restored=f.make(buffer);restored.replay(key);await until(()=>restored.buffer.unread(key).length===0);assert.equal(f.calls,1);assert.deepEqual(f.sent.map(item=>item.text),paragraphs(5));assert.equal(f.attempts.filter(item=>item.text==='第 1 段').length,1);assert.equal(f.attempts.filter(item=>item.text==='第 2 段').length,1);assert.equal(f.attempts.filter(item=>item.text==='第 3 段')[0].id,f.attempts.filter(item=>item.text==='第 3 段')[1].id);
});

test('an unconfirmed third segment halts subsequent sends and retires the reply without claiming those parts arrived',async t=>{
 const f=fixture(t,{uncertainAt:3});f.engine.receive(message);await until(()=>f.engine.buffer.unread(key).length===0);assert.equal(f.sent.length,2);assert.equal(f.attempts.length,3);assert.equal(f.engine.buffer.pendingReplies.size,0);assert(f.engine.buffer.contextNotices.get(key).text.includes('第 3 条发送未确认'));assert(f.engine.buffer.contextNotices.get(key).text.includes('后续 2 条没有发送'));
});

test('a stop command interrupts a quota-parked reply without another model call or archiving the conversation',async t=>{
 const f=fixture(t,{quota:1});f.engine.receive(message);await until(()=>f.sent.length===1&&f.engine.timers.has(key));f.engine.receive({...message,message_id:'stop-parts',text:'停止分段'});await until(()=>f.engine.buffer.pendingReplies.size===0&&f.sent.some(item=>item.text.startsWith('已停止本次回复')));assert.equal(f.calls,1);assert.equal(f.sent.filter(item=>/^第 \d+ 段$/.test(item.text)).length,1);assert.equal(f.engine.buffer.unread(key).length,0);
});

test('stopping during a native submission retains its confirmed receipt and cancels only the remaining segments',async t=>{
 const f=fixture(t,{holdPartAt:1});f.engine.receive(message);await until(()=>f.partHeld);f.engine.receive({...message,message_id:'stop-in-flight',text:'停止分段'});f.releasePart();await until(()=>f.engine.buffer.pendingReplies.size===0);assert.equal(f.calls,1);assert.equal(f.sent.filter(item=>/^第 \d+ 段$/.test(item.text)).length,1);assert.equal(f.engine.buffer.recent(key).filter(row=>row.outgoing&&row.delivery_status==='confirmed').length,1);
});

test('limits are frozen for an admitted reply and new values apply to the next model turn',async t=>{
 const f=fixture(t,{hold:true});f.engine.receive(message);await until(()=>f.calls===1);f.setLimit(1);f.release();await until(()=>f.engine.buffer.unread(key).length===0);assert.equal(f.sent.length,5);f.engine.receive({...message,message_id:'next-turn'});await until(()=>f.calls===2&&f.engine.buffer.unread(key).length===0);assert.deepEqual(f.inputs,[0,1]);assert.equal(f.sent.length,6);assert.equal(f.sent.at(-1).text,paragraphs(5).join('\n\n'));
});

test('live owner prompts and format repair honour zero without repeating an obsolete two-part instruction',async t=>{
 const root=temp(t);fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:[senderId],groups:[]},workModes:{[key]:'assistant'},replyLayout:{maxMessages:0}}}));const prompt=stableChatInstructions(root,key);assert(prompt.includes('不设固定条数上限'));assert(!prompt.includes('一次最多两条'));let repair;
 const result=await resolveSocialDecision({key,rawOutput:'fixture invalid',metadata:{},maxTextParts:0,decide:async(_key,text)=>{repair=text;return output(5);}});assert(repair.includes('不设固定条数上限'));assert(!repair.includes('一次最多两条'));assert.equal(result.result.textParts.length,5);
});

test('the UI exposes zero through twenty and the saved setting is hot, revision-protected and validated',async t=>{
 const root=temp(t),config=JSON.parse(fs.readFileSync('config/wechatagent.example.json','utf8'));for(const dir of ['config','roles','state'])fs.mkdirSync(path.join(root,dir),{recursive:true});const file=path.join(root,'config/wechatagent.json');fs.writeFileSync(file,JSON.stringify(config));fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
 const fields=[],draft=structuredClone(config),ui=createWorkspaceLayout({state:{draft,settingsSection:'chat'},escapeHtml:String,icon:()=>'',header:title=>title,field:(name,key,opts)=>{fields.push({name,key,opts});return name;},getCards:()=>({participation:'',rhythm:'',proactive:''})});const html=await ui.settingsPage(),field=fields.find(item=>item.key==='wechat.replyLayout.maxMessages');assert(field);assert.equal(field.opts.transform,'number');assert.deepEqual(field.opts.options.map(([value])=>value),Array.from({length:21},(_,i)=>i));assert(field.opts.options[0][1].includes('不限制'));assert(html.includes('停止分段'));assert.deepEqual(draft,config);
 const app=createConsole({root,port:0,runner:async()=>0,fetchImpl:async()=>new Response('{}'),processProbe:async()=>[]}),address=await app.start();t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));});const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':info.token,'Content-Type':'application/json'},original=await fetch(base+'/api/config',{headers}).then(r=>r.json());let revision=original.revision;
 for(const maxMessages of [0,3]){const changed=structuredClone(config);changed.wechat.replyLayout={maxMessages};const r=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision,config:changed})});assert.equal(r.status,200);const value=await r.json();assert.equal(value.config.wechat.replyLayout.maxMessages,maxMessages);assert(!value.pendingApply);assert(!value.dshRestartRequired);revision=value.revision;}
 const bytes=fs.readFileSync(file);for(const maxMessages of [-1,21,1.5,'0',null]){const changed=structuredClone(config);changed.wechat.replyLayout={maxMessages};assert.equal((await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision,config:changed})})).status,400);assert.deepEqual(fs.readFileSync(file),bytes);}
});
