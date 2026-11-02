import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createConsole} from './console-server.mjs';
import net from 'node:net';
test('a failed startup port stays inspectable even when cached status claims the adapter is healthy',async t=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'port-recovery-api-'));
 fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state'));const config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));
 const onebot=net.createServer(socket=>socket.end());await new Promise(resolve=>onebot.listen(0,'127.0.0.1',resolve));config.ports.onebot=onebot.address().port;t.after(()=>new Promise(resolve=>onebot.close(resolve)));
 fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_token:'fixture'}));
 const probes=[],app=createConsole({root,port:0,runner:async(_spec,output)=>{output('SERVICE_PORT_IN_USE service=adapter port=8766 owners=777');return 1;},fetchImpl:async input=>{
  const url=new URL(input);return new Response(JSON.stringify(url.pathname==='/status'?{ob_connected:true,reader_connected:true,hook_connected:true,hook_account_verified:true,version:config.hook.expectedVersion}:{lastError:''}));
 },processProbe:async input=>{probes.push(input);return{items:[]};},processStop:async()=>{throw Error('Inspection must not terminate processes');}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const address=await app.start(),base=`http://127.0.0.1:${address.port}`,info=await(await fetch(base+'/api/info')).json();
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const initial=await api('/api/status');assert(initial.body.services.find(service=>service.id==='bridge').ready);
 assert.equal((await api('/api/jobs',{action:'start'})).status,202);
 for(let i=0;i<30;i++){if((await api('/api/status')).body.latestJob?.state==='failed')break;await new Promise(resolve=>setTimeout(resolve,20));}
 const scan=await api('/api/process-recovery');assert.equal(scan.status,200);assert(probes.at(-1).ports.includes(8766),'Cached healthy status must not hide the failed port');assert(!probes.at(-1).ports.includes(config.ports.onebot),'Other healthy ports stay protected');
});
test('repair API scopes process termination to the configured client and requires a single-use second confirmation',async t=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-repair-api-'));
 fs.mkdirSync(path.join(root,'config'));const config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
 const probes=[],stops=[];
 const app=createConsole({root,port:0,runner:async()=>{throw Error('No real commands allowed');},fetchImpl:async()=>{throw Error('No production API requests allowed');},processProbe:async input=>{probes.push(input);return{items:[{pid:777,name:'Weixin.exe',path:input.wechatExecutable,start:'123',commandHash:'fixture',ports:[],canStop:true},{pid:778,name:'Weixin.exe',path:'C:/unrelated/Weixin.exe',start:'124',commandHash:'fixture',ports:[],canStop:true}]};},processStop:async input=>{stops.push(input);return{stopped:input.items.map(i=>i.pid)};}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const address=await app.start(),base=`http://127.0.0.1:${address.port}`,info=await(await fetch(base+'/api/info')).json();
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const scan=await api('/api/process-recovery?purpose=hook-repair');assert.equal(scan.status,200);assert.equal(scan.body.purpose,'hook-repair');assert.equal(scan.body.items.length,1);assert.deepEqual(probes[0].ports,[]);assert.equal(probes[0].matchingWeChatOnly,true);assert.equal(probes[0].includeMatchingWeChat,true);assert.equal(stops.length,0);
 const prepared=await api('/api/process-recovery/prepare',{scanId:scan.body.scanId,ids:[scan.body.items[0].id]});assert.equal(prepared.status,200);assert.equal(stops.length,0);
 const request={confirmation:prepared.body.confirmation};assert.equal((await api('/api/process-recovery/stop',request)).status,409);assert.equal(stops.length,0);
 assert.equal((await api('/api/process-recovery/stop',{...request,confirmed:true})).status,200);assert.equal(stops.length,1);assert.deepEqual(stops[0].items.map(i=>i.pid),[777]);
 assert.equal((await api('/api/process-recovery/stop',{...request,confirmed:true})).status,409);assert.equal(stops.length,1);
});
