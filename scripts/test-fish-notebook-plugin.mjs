import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PluginRuntime,createPluginModelUtility} from '../packages/plugin-api/index.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {configuration,updatePlugin,packageFiles,pluginEnabled,manifest} from '../packages/plugin-api/catalog.mjs';
import {packZip,unpackZip} from '../packages/plugin-api/zip.mjs';
import {PluginDocuments} from '../packages/plugin-api/documents.mjs';
import {FishNotebookStore} from '../packages/dsh-social-bridge-plugin/fish-notebook-store.mjs';
import {notebookHash} from '../packages/dsh-social-bridge-plugin/fish-notebook-policy.mjs';
import {createConsole} from './console-server.mjs';
const source=path.resolve('optional-extensions/fish-notebook'),account='a'.repeat(64),viewer='b'.repeat(64),other='c'.repeat(64),chat='wechat:private:123',group='wechat:group:456';
const diary='今天和朋友聊了论文，也记下了一点小小的开心。\n\n鱼把这一页夹好，留给明天的自己慢慢看。';
const question=(n,key=chat,who=viewer)=>({key,args:{id:notebookHash('question-'+n),viewer:who}});
async function fixture(t,{install=true,...options}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-notebook-plugin-')),installer=new PluginInstaller(root),calls=[];let style={personaName:'示例小鱼',persona:'你是一条爱吐泡泡的小鱼。'},now=Date.parse('2026-10-25T12:00:00Z');
  const config={wechat:{whitelist:{private:['123'],groups:['456']},fishNotebook:{enabled:true,writeTime:'21:30',chats:{}}}},configFile=path.join(root,'config/wechatagent.json');fs.mkdirSync(path.dirname(configFile));fs.writeFileSync(configFile,JSON.stringify(config));fs.mkdirSync(path.join(root,'state/weflow'),{recursive:true});fs.writeFileSync(path.join(root,'state/weflow/active-account.json'),JSON.stringify({id:account,legacyId:account}));
  let preview;if(install){preview=installer.inspect({name:'fish.zip',zip:packZip(packageFiles(source)).toString('base64')});installer.install({ticket:preview.ticket,revision:preview.revision});}
  const runtime=new PluginRuntime({root,accountScope:account,personaFor:()=>style,rowsForDate:key=>key===chat?[{who:'朋友',text:'PRIVATE_TODAY_FACT：一起讨论论文。'}]:[],now:()=>now,
    generateText:async value=>{calls.push(value);return value.prompt.includes('写一篇角色日记')?diary:'鱼把小本本往怀里藏了藏，先让我害羞一小会儿嘛。';},...options});
  t.after(async()=>{await runtime.dispose();installer.dispose();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  await runtime.sync();
  const enable=(enabled=true,chats=null)=>{const item=JSON.parse(fs.readFileSync(path.join(source,'plugin.json'),'utf8'));return updatePlugin(root,'fish-notebook',{revision:configuration(root).revision,enabled,permissions:enabled?item.permissions:[],chats,settings:{writeTime:'21:30'}});};
  const ask=async q=>runtime.invokeAction('fish-notebook','ask',q.args,{conversationKey:q.key},{requireReply:true});
  return {root,runtime,installer,preview,calls,config,configFile,enable,ask,style:value=>style=value,clock:value=>now=Date.parse(value)};
}

test('the ZIP is self-contained and the old built-in switch does not run it before explicit installation and grants',async t=>{
  const files=unpackZip(packZip(packageFiles(source)));assert.deepEqual(files.map(file=>file.name).sort(),['README.md','index.mjs','lib/notebook.mjs','plugin.json','ui.json','ui/page.html','ui/page.js','ui/style.css']);
  const f=await fixture(t);assert.equal(configuration(f.root).config.plugins['fish-notebook'].enabled,false);assert.equal(pluginEnabled(f.root,'fish-notebook',chat),false);
  assert.deepEqual(await f.ask(question(1)),{handled:false});await f.runtime.tick();assert.equal(f.calls.length,0);
  f.enable();await f.runtime.sync();assert.equal(pluginEnabled(f.root,'fish-notebook',chat),true);assert(f.runtime.records.get('fish-notebook').process.scheduled);assert.equal(f.runtime.toolDefinitions(chat).length,0);
});

test('installed plugin writes once, hides the first two requests and shares the exact saved diary on the third, across restart',async t=>{
  const f=await fixture(t);f.enable();await f.runtime.sync();
  const first=await f.ask(question(1));assert(first.handled);assert(!first.document);assert(!first.text.includes(diary));assert.deepEqual(await f.ask(question(1)),first);
  const second=await f.ask(question(2));assert(!second.text.includes(diary));const third=await f.ask(question(3));assert(third.document);assert(third.text.endsWith(diary));assert.equal(f.calls.length,3);
  assert(!f.calls[1].prompt.includes('PRIVATE_TODAY_FACT'));assert(!f.calls[1].prompt.includes(diary));
  const view=await f.runtime.invokeAction('fish-notebook','list',{},{conversationKey:chat});assert.equal(view.total,1);assert.equal(view.entries[0].text,diary);assert(!JSON.stringify(view).includes('visitors'));assert.equal(f.calls.length,3);
  await f.runtime.dispose();const restored=new PluginRuntime({root:f.root,accountScope:account,personaFor:()=>({personaName:'示例小鱼',persona:'你是一条爱吐泡泡的小鱼。'}),now:()=>Date.parse('2026-10-25T12:00:00Z'),generateText:()=>{throw Error('NO_NEW_MODEL_CALL');}});t.after(()=>restored.dispose());await restored.sync();
  const again=await restored.invokeAction('fish-notebook','ask',question(4).args,{conversationKey:chat},{requireReply:true});assert.equal(again.text,third.text);
});

test('legacy journals and counts remain compatible, including persona content longer than the model excerpt',async t=>{
  const f=await fixture(t),persona={personaName:'旧人设',persona:'长人设内容。'.repeat(1800)};f.style(persona);const store=new FishNotebookStore(f.root,account),id=store.id('2026-10-25',persona);
  store.write({version:1,accountScope:account,conversationKey:chat,id,date:'2026-10-25',personaName:persona.personaName,personaDigest:notebookHash(persona.persona),createdAt:1,sourceCount:1,text:diary,visitors:{[viewer]:{count:2,receipts:[]}}});
  f.enable();await f.runtime.sync();const result=await f.ask(question(3));assert(result.document);assert(result.text.endsWith(diary));assert.equal(f.calls.length,0);assert.equal(store.list(chat).total,1);assert.equal(store.read(chat,id).visitors[viewer].count,3);
});

test('different users, chats, accounts, dates and personas do not share disclosure counts',async t=>{
  const f=await fixture(t);f.enable();await f.runtime.sync();await f.ask(question(1));await f.ask(question(2));
  assert(!(await f.ask(question(3,chat,other))).document);assert(!(await f.ask(question(4,group))).document);
  f.style({personaName:'另一条鱼',persona:'另一种温柔的语气。'});assert(!(await f.ask(question(5))).document);
  f.clock('2026-10-26T12:00:00Z');assert(!(await f.ask(question(6))).document);assert.equal(new FishNotebookStore(f.root,'d'.repeat(64)).list(chat).total,0);
});

test('host scheduling runs only after the selected time and never regenerates an early or existing diary',async t=>{
  const f=await fixture(t);f.enable();await f.runtime.sync();await f.runtime.tick();assert.equal(f.calls.length,0);
  f.clock('2026-10-25T13:31:00Z');await f.runtime.tick();await f.runtime.tick();assert.equal(f.calls.length,1);assert.equal(new FishNotebookStore(f.root,account).list(chat).total,1);assert.equal(new FishNotebookStore(f.root,account).list(group).total,0);
  await f.ask(question(1));assert.equal(f.calls.length,2);await f.runtime.tick();assert.equal(f.calls.length,2);
});

test('corrupt old data is preserved and does not poison a different chat or later fixed requests',async t=>{
  const f=await fixture(t);f.enable();await f.runtime.sync();await f.ask(question(1));const store=new FishNotebookStore(f.root,account),entry=store.list(chat).entries[0],file=store.file(chat,entry.id),old=fs.readFileSync(file);fs.writeFileSync(file,'{broken');
  await assert.rejects(f.ask(question(2)),/FILE_INVALID/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');assert((await f.ask(question(3,group))).handled);fs.writeFileSync(file,old);assert((await f.ask(question(2))).handled);
});

test('document access rejects other chats, foreign metadata, links and Windows device names',async t=>{
  const f=await fixture(t),docs=new PluginDocuments(f.root,'e'.repeat(64),account,{id:'fixture'});
  docs.put(chat,'entry',{id:'entry',accountScope:account,conversationKey:chat,text:'private'});assert.equal(docs.get(group,'entry'),null);
  assert.throws(()=>docs.put(chat,'other',{conversationKey:group}),/SCOPE_INVALID/);for(const id of ['../x','CON','nul','a/b'])assert.throws(()=>docs.get(chat,id),/ID_INVALID/);
  const folder=docs.folder(chat),target=path.join(f.root,'outside');fs.mkdirSync(target);fs.symlinkSync(target,path.join(folder,'linked.json'),'junction');assert.throws(()=>docs.get(chat,'linked'),/PATH_INVALID/);
});

test('revocation during generation never commits a diary, and disabled data remains viewable',async t=>{
  let started=false,finish;const gate=new Promise(resolve=>finish=resolve);const f=await fixture(t,{generateText:async()=>{started=true;return gate;}});f.enable();await f.runtime.sync();const pending=f.ask(question(1));
  for(let i=0;i<150&&!started;i++)await new Promise(resolve=>setTimeout(resolve,5));assert(started);f.enable(false);finish(diary);await assert.rejects(pending,/PERMISSION_DENIED/);assert.equal(new FishNotebookStore(f.root,account).list(chat).total,0);assert.equal(f.runtime.utilityCalls,0);
});

test('the scoped model utility uses no tools and strips reasoning without altering the main session',async()=>{
  const calls=[],usage=[];class Assembler{push(chunk){if(chunk.type==='text-delta')this.text=(this.text??'')+chunk.text;}blocks(){return [{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:this.text}];}get finish(){return {kind:'stop'};}}
  const generate=createPluginModelUtility({ctx:{llm:{resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off'}]}}),async *stream(options){calls.push(options);yield {type:'text-delta',text:diary};}}},provider:'fixture',model:'fixture',createUserMessage:x=>x,BlockAssembler:Assembler,recordUsage:x=>usage.push(x)});
  assert.equal(await generate({pluginId:'fish-notebook',key:chat,prompt:'write',maxChars:1000,signal:new AbortController().signal,allowed:()=>true}),diary);assert.deepEqual(calls[0].tools,[]);assert.equal(calls[0].reasoningEffort,'off');assert.equal(usage[0].purpose,'plugin:fish-notebook');
});

test('the package page lists diaries through its own action without counting a visit; host-specific notebook routes are gone',async t=>{
  const f=await fixture(t);f.enable();await f.runtime.sync();
  const written=await f.runtime.invokeAction('fish-notebook','write-today',{},{conversationKey:chat});assert.equal(written.entry.text,diary);
  const before=await f.runtime.invokeAction('fish-notebook','list',{offset:0},{conversationKey:chat});assert.deepEqual(before.entries.map(entry=>entry.text),[diary]);assert.equal(before.errors,0);
  const first=await f.ask(question(1));assert(!first.document);const after=await f.runtime.invokeAction('fish-notebook','list',{},{conversationKey:chat});assert.deepEqual(after.entries,before.entries);
  assert.equal((await f.ask(question(2))).document,undefined);assert.equal((await f.runtime.invokeAction('fish-notebook','list',{},{conversationKey:group})).total,0);
  const app=createConsole({root:f.root,port:0,fetchImpl:async()=>{throw Error('offline');}}),address=await app.start();t.after(()=>app.close());const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':info.token,'Content-Type':'application/json'};
  const catalog=await fetch(base+'/api/plugins',{headers}).then(r=>r.json()),item=catalog.plugins.find(row=>row.id==='fish-notebook');assert.equal(item.ui.page.title,'鱼的记事本');assert.equal(item.ui.settings,undefined);
  const page=await fetch(base+item.ui.page.url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'none'/);
  for(const route of ['/api/fish-notebook','/plugin-packages/fish-notebook.zip','/fish-notebook.js','/fish-notebook.css'])assert.notEqual((await fetch(base+route,{headers})).status,200,route);
  for(const route of ['/api/fish-notebook/write','/api/fish-notebook/settings'])assert.notEqual((await fetch(base+route,{method:'POST',headers,body:JSON.stringify({scope:account,key:chat})})).status,200,route);
});

test('manifest schedule validation rejects impossible times and unowned legacy namespaces',()=>{
  const value=JSON.parse(fs.readFileSync(path.join(source,'plugin.json'),'utf8'));assert.throws(()=>manifest({...value,settings:{writeTime:'99:99'}}));assert.throws(()=>manifest({...value,id:'impostor'}));assert.throws(()=>manifest({...value,requiresHostFeatures:['future-service']}));
});

test('stopped backends suppress the daily plan and a stalled utility releases its budget on cancellation',async t=>{
  let backend=false,started=false;const f=await fixture(t,{canSchedule:()=>backend,generateText:()=>{started=true;return new Promise(()=>{});}});f.enable();await f.runtime.sync();f.clock('2026-10-25T13:31:00Z');await f.runtime.tick();assert(!started);
  const pending=f.runtime.invokeAction('fish-notebook','write-today',{}, {conversationKey:chat},{timeoutMs:100});await assert.rejects(pending,/TIMEOUT/);
  for(let i=0;i<100&&f.runtime.utilityCalls;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.runtime.utilityCalls,0);assert.equal(new FishNotebookStore(f.root,account).list(chat).total,0);
});

test('closing during plugin initialization never restarts a worker or a scheduler afterward',async t=>{
  const f=await fixture(t);f.enable();const loading=f.runtime.sync();await f.runtime.dispose();await loading;f.runtime.start();await f.runtime.tick();assert.equal(f.runtime.records.size,0);assert(!f.runtime.timer);assert.equal(f.calls.length,0);
});

test('a slow evening pass stops at midnight instead of writing the next day early for another chat',async t=>{
  let f,calls=0;f=await fixture(t,{rowsForDate:()=>[{who:'朋友',text:'今天一起聊了天。'}],generateText:async()=>{calls++;f.clock('2026-10-25T16:00:01Z');return diary;}});f.enable();await f.runtime.sync();f.clock('2026-10-25T15:59:59Z');await f.runtime.tick();assert.equal(calls,1);assert.equal(new FishNotebookStore(f.root,account).list(group).total,0);
});

test('busy-group evidence and long names fit the model budget without changing the legacy persona identity',async t=>{
  const f=await fixture(t,{rowsForDate:()=>Array.from({length:200},()=>({who:'朋友'.repeat(50),text:'今天一起讨论了文章。'.repeat(7)}))});f.style({personaName:'长人设',persona:'你是一条认真记日记的小鱼。'.repeat(800)});f.enable();await f.runtime.sync();assert((await f.ask(question(1))).handled);
  assert(f.calls[0].prompt.length<=32000);const entry=new FishNotebookStore(f.root,account).list(chat).entries[0];assert(entry.sourceCount>0&&entry.sourceCount<200);
});
