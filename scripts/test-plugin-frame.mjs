import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {validatePluginUi,uiSegments} from './plugin-ui.mjs';
import {mountPluginFrame,FRAME_SANDBOX} from '../public/console/plugin-frame.mjs';
import {consoleRoute} from '../public/console/layout-model.mjs';
import {pluginCard} from '../public/console/plugins.js';
import {createConsole} from './console-server.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {atomicJson,inspectPackage} from '../packages/plugin-api/catalog.mjs';

const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('ui.json accepts only package-relative HTML entries and bounded fields',()=>{
  const ok=validatePluginUi({version:1,settings:{entry:'settings.html',height:300},page:{entry:'pages/main.html',title:'页面'}});
  assert.equal(ok.page.entry,'pages/main.html');
  for(const bad of [
    {version:1},{version:2,page:{entry:'a.html',title:'x'}},{version:1,script:'x',page:{entry:'a.html',title:'x'}},
    {version:1,settings:{entry:'../plugin.json'}},{version:1,settings:{entry:'a.js'}},{version:1,settings:{entry:'__sdk.mjs'}},
    {version:1,settings:{entry:'/abs.html'}},{version:1,settings:{entry:'a.html',height:20}},{version:1,settings:{entry:'con.html'}},
    {version:1,page:{entry:'a.html'}},{version:1,page:{entry:'a.html',title:'x'.repeat(41)}},{version:1,page:{entry:'a.html',title:'x',html:'<b>'}},
  ])assert.throws(()=>validatePluginUi(bad),undefined,JSON.stringify(bad));
  for(const bad of ['..','a/../b.html','a\\b.html','.hidden','a/./b','a.html.','x/'.repeat(9)+'a.html',''])assert.equal(uiSegments(bad),null,bad);
});

test('the example package declares valid pages and actions',()=>{
  const item=inspectPackage('examples/plugins/chat-notes');assert.deepEqual(item.requiresHostFeatures,['actions-v1']);
  const ui=validatePluginUi(JSON.parse(fs.readFileSync('examples/plugins/chat-notes/ui.json','utf8')));
  for(const entry of [ui.settings.entry,ui.page.entry])assert(fs.existsSync(path.join('examples/plugins/chat-notes/ui',entry)));
});

test('plugin page routes and cards stay bound to a plugin id',()=>{
  assert.deepEqual(consoleRoute('#plugin/chat-notes'),{page:'plugin',section:'chat-notes'});
  assert.equal(consoleRoute('#plugin/../x').page,'overview');assert.equal(consoleRoute('#plugin/').page,'overview');
  const card=pluginCard({id:'fixture',name:'F',version:'1',description:'d',chats:[],statusTone:'ok',statusLabel:'on',reason:'',ui:{page:{url:'/x'}}},esc,()=>'');
  assert.match(card,/href="#plugin\/fixture"/);
  assert.doesNotMatch(pluginCard({id:'fixture',name:'F',version:'1',description:'d',chats:[],statusTone:'ok',statusLabel:'on',reason:''},esc,()=>''),/#plugin\//);
});

function fakeDom(){
  const listeners=new Map(),frames=[];
  const win={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},getComputedStyle:()=>({getPropertyValue:name=>name==='--text'?' #123 ':''})};
  const doc={documentElement:{dataset:{theme:'dark'}},defaultView:win,createElement(){
    const frame={attrs:{},style:{},on:{},removed:false,clientHeight:500,setAttribute(k,v){this.attrs[k]=v;},addEventListener(n,f){this.on[n]=f;},remove(){this.removed=true;},contentWindow:{posted:[],postMessage(message,target){this.posted.push({message,target});}}};
    frames.push(frame);return frame;
  }};
  const container={children:[],append(el){this.children.push(el);}};
  const send=async(frame,data,source=frame.contentWindow)=>{listeners.get('message')?.({source,data});await tick();await tick();};
  return {win,doc,container,frames,listeners,send};
}

test('the bridge answers only its own frame, whitelists methods and drops late work after dispose',async()=>{
  const dom=fakeDom();let release;const slow=new Promise(resolve=>release=resolve);
  const bridge=mountPluginFrame({container:dom.container,src:'/plugin-ui/x/fixture/a.html',title:'F',height:5000,win:dom.win,doc:dom.doc,handlers:{
    'host.info':()=>({pluginId:'fixture'}),'slow':()=>slow,'ui.resize':({height},b)=>b.resize(height),
  }});
  const frame=dom.frames[0],posted=frame.contentWindow.posted;
  assert.equal(frame.attrs.sandbox,FRAME_SANDBOX);assert.equal(frame.attrs.referrerpolicy,'no-referrer');assert.equal(frame.style.height,'2000px');assert.equal(frame.src,'/plugin-ui/x/fixture/a.html');
  await dom.send(frame,{wa:1,type:'request',id:1,method:'host.info'},{postMessage(){}});assert.equal(posted.length,0,'other windows are ignored');
  await dom.send(frame,{wa:1,type:'request',id:1,method:'host.info'});assert.deepEqual(posted.at(-1).message,{wa:1,type:'response',id:1,ok:true,result:{pluginId:'fixture'}});assert.equal(posted.at(-1).target,'*');
  await dom.send(frame,{wa:1,type:'request',id:2,method:'constructor'});assert.equal(posted.at(-1).message.ok,false);
  await dom.send(frame,{wa:1,type:'request',id:3,method:'ui.resize',params:{height:10}});assert.equal(frame.style.height,'120px');
  await dom.send(frame,{wa:2,type:'request',id:4,method:'host.info'});assert.equal(posted.at(-1).message.id,3,'foreign protocols are ignored');
  // Host -> page request with an answer, then a timeout.
  const collected=bridge.request('collect');const id=posted.at(-1).message.id;assert.equal(posted.at(-1).message.method,'collect');
  await dom.send(frame,{wa:1,type:'response',id,ok:true,result:{maxNotes:3}});assert.deepEqual(await collected,{maxNotes:3});
  const silent=bridge.request('collect',{},5);await assert.rejects(silent,error=>error.timeout===true);
  const failing=bridge.request('collect').catch(error=>error);await dom.send(frame,{wa:1,type:'response',id:posted.at(-1).message.id,ok:false,error:'需要地址'});assert.match((await failing).message,/需要地址/);
  // Late results after dispose are never posted.
  dom.send(frame,{wa:1,type:'request',id:9,method:'slow'});await tick();const waiting=bridge.request('collect',{},10000);const count=posted.length;
  bridge.dispose();await assert.rejects(waiting,/已关闭/);release({late:true});await tick();await tick();
  assert.equal(posted.length,count);assert(frame.removed);assert(!dom.listeners.has('message'));
});

test('the bridge refuses non-cloneable results and caps concurrent requests',async()=>{
  const dom=fakeDom();let release;const hold=new Promise(resolve=>release=resolve);
  mountPluginFrame({container:dom.container,src:'/x',title:'F',win:dom.win,doc:dom.doc,handlers:{bad:()=>({fn(){}}),hold:()=>hold}});
  const frame=dom.frames[0],posted=frame.contentWindow.posted;
  await dom.send(frame,{wa:1,type:'request',id:'b',method:'bad'});assert.equal(posted.at(-1).message.ok,false);
  for(let i=0;i<8;i++)dom.send(frame,{wa:1,type:'request',id:'h'+i,method:'hold'});await tick();
  await dom.send(frame,{wa:1,type:'request',id:'over',method:'hold'});assert.match(posted.at(-1).message.error,/请求过多/);
  release(1);await tick();await tick();assert.equal(posted.filter(item=>item.message.ok===true).length,8);
});

async function server(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-plugin-frame-'));const cfg=JSON.parse(fs.readFileSync('config/wechatagent.example.json'));cfg.wechat.whitelist={private:['123'],groups:[]};atomicJson(path.join(root,'config/wechatagent.json'),cfg);fs.mkdirSync(path.join(root,'roles'));fs.writeFileSync(path.join(root,'roles',cfg.persona.default+'.md'),'Fixture');
  const app=createConsole({root,port:0,fetchImpl:async()=>{throw Error('offline');}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  const request=async(route,body,headers={})=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,headers:response.headers,body:await response.json().catch(()=>null)};};
  t.after(async()=>{app.server.closeAllConnections();await app.close();assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {root,base,request};
}
const manifest=(version='1.0.0')=>JSON.stringify({id:'paged',name:'Paged',version,apiVersion:2,host:'wechatagent',description:'fixture',permissions:[],settings:{n:1},configSchema:{n:{type:'integer'},token:{type:'string',secret:true}}});
const pagedZip=(version,ui='{"version":1,"settings":{"entry":"settings.html"},"page":{"entry":"page.html","title":"页面"}}')=>packZip([
  {name:'plugin.json',data:Buffer.from(manifest(version))},
  {name:'index.mjs',data:Buffer.from('export function setup(api){api.registerTool({id:"run",description:"x",parameters:{type:"object",properties:{}},execute:()=>"ok"});}')},
  {name:'ui.json',data:Buffer.from(ui)},
  {name:'ui/settings.html',data:Buffer.from('<!doctype html><script type="module" src="app.js"></script>')},
  {name:'ui/page.html',data:Buffer.from('<!doctype html><p>page</p>')},
  {name:'ui/app.js',data:Buffer.from('import wa from "./__sdk.mjs";')},
  {name:'ui/notes.txt',data:Buffer.from('not served')},
]);
async function installZip(f,bytes){
  const preview=await f.request('/api/plugins/inspect',{name:'paged.zip',zip:bytes.toString('base64')});assert.equal(preview.status,200);
  const result=await f.request('/api/plugins/install',{ticket:preview.body.ticket,revision:preview.body.revision,replace:!!preview.body.installedVersion});assert.equal(result.status,200);
  return preview.body;
}
const item=async f=>(await f.request('/api/plugins')).body.plugins.find(row=>row.id==='paged');

test('package pages are served sandboxed, behind an expiring capability, and cannot reach the console API',async t=>{
  const f=await server(t);const preview=await installZip(f,pagedZip());assert.equal(preview.hasPages,true);
  const row=await item(f);assert.match(row.ui.settings.url,/^\/plugin-ui\/[a-f0-9]{32}\/paged\/settings\.html$/);assert.equal(row.ui.settings.height,420);assert.equal(row.ui.page.title,'页面');
  const base=row.ui.settings.url.replace(/settings\.html$/,'');
  const page=await fetch(f.base+row.ui.settings.url);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  const csp=page.headers.get('content-security-policy');
  assert.match(csp,/^sandbox allow-scripts allow-forms;/);assert.match(csp,/connect-src 'none'/);assert.match(csp,new RegExp(`script-src ${f.base}${base}(;|\\s)`));assert.match(csp,new RegExp(`frame-ancestors ${f.base}$`));
  assert.equal(page.headers.get('x-frame-options'),null);assert.equal(page.headers.get('access-control-allow-origin'),'*');
  // Subresources of an opaque-origin page arrive as Origin: null / cross-site.
  const sdk=await fetch(f.base+base+'__sdk.mjs',{headers:{Origin:'null','Sec-Fetch-Site':'cross-site'}});assert.equal(sdk.status,200);assert.match(await sdk.text(),/export const wa/);
  assert.equal((await fetch(f.base+base+'app.js',{headers:{Origin:'null'}})).status,200);
  assert.equal((await fetch(f.base+base+'app.js',{headers:{Origin:'https://evil.example'}})).status,403);
  // The same opaque origin is refused everywhere else.
  assert.equal((await fetch(f.base+'/api/info',{headers:{Origin:'null'}})).status,403);
  assert.equal((await f.request('/api/plugins',undefined,{Origin:'null'})).status,403);
  assert.equal((await fetch(f.base+'/index.html',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  for(const bad of ['notes.txt','%2e%2e%2fplugin.json','..%2Findex.mjs','missing.html'])assert.equal((await fetch(f.base+base+bad)).status,404,bad);
  assert.equal((await fetch(f.base+base.replace(/[a-f0-9]{32}/,'0'.repeat(32))+'settings.html')).status,404);
  assert.equal((await fetch(f.base+'/plugin-ui/'+base.split('/')[2]+'/other/settings.html')).status,404);
  // Updating the package rotates the capability; uninstalling revokes it.
  await installZip(f,pagedZip('1.0.1'));assert.equal((await fetch(f.base+row.ui.settings.url)).status,404);
  const next=await item(f);assert.notEqual(next.ui.settings.url,row.ui.settings.url);assert.equal((await fetch(f.base+next.ui.settings.url)).status,200);
  const catalog=(await f.request('/api/plugins')).body;assert.equal((await f.request('/api/plugins/paged/uninstall',{revision:catalog.revision})).status,200);
  assert.equal((await fetch(f.base+next.ui.settings.url)).status,404);
});

test('invalid declarations and linked folders fall back to the standard form',async t=>{
  const f=await server(t);await installZip(f,pagedZip('1.0.0','{"version":1,"settings":{"entry":"../index.mjs"}}'));
  let row=await item(f);assert.equal(row.ui,undefined);assert.match(row.uiError,/标准配置表单/);
  await installZip(f,pagedZip('1.0.1','{"version":1,"settings":{"entry":"absent.html"}}'));row=await item(f);assert.equal(row.ui,undefined);assert.match(row.uiError,/标准配置表单/);
  await installZip(f,pagedZip('1.0.2'));row=await item(f);assert(row.ui.settings.url);
  // A ui/ folder replaced by a junction is no longer served.
  const folder=path.join(f.root,'plugins/paged/ui'),outside=path.join(f.root,'outside');fs.renameSync(folder,outside);
  try{fs.symlinkSync(outside,folder,'junction');}catch{t.skip('junctions unavailable');return;}
  assert.equal((await fetch(f.base+row.ui.settings.url)).status,404);
});

test('a package without ui.json keeps the generated form and has no page',async t=>{
  const f=await server(t);const bytes=packZip([{name:'plugin.json',data:Buffer.from(manifest())},{name:'index.mjs',data:Buffer.from('export function setup(api){api.registerTool({id:"run",description:"x",parameters:{type:"object",properties:{}},execute:()=>"ok"});}')}]);
  const preview=await installZip(f,bytes);assert.equal(preview.hasPages,false);const row=await item(f);assert.equal(row.ui,undefined);assert.equal(row.uiError,undefined);
});
