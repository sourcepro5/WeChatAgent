import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fork} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const projectRoot=path.resolve(process.env.WECHATAGENT_ENTRY_TEST_ROOT??path.join(import.meta.dirname,'..'));
const entry=path.join(projectRoot,'components/qq-bridge/src/social-bridge.js');

if(process.argv[2]==='--bridge-entry-fixture'){
  // Discover the real listener's ephemeral port without replacing entry callbacks.
  const config=process.argv[3];
  const {ReverseOneBotServer}=await import(pathToFileURL(path.join(projectRoot,'components/qq-bridge/src/onebot/reverse-ws-server.js')));
  const start=ReverseOneBotServer.prototype.start;let port;
  ReverseOneBotServer.prototype.start=async function(){await start.call(this);port=this.server.address().port;};
  process.argv=[process.execPath,entry,config];
  await import(pathToFileURL(entry));
  process.on('message',message=>{if(message==='stop')process.emit('SIGTERM');});
  process.send({ready:true,port});
}else{
  test('real bridge entry dispatches private and group text, reloads reply limits, and scopes notebook routing', {timeout:30000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechatagent-entry-'));
    const requests=[],sent=[];let child,ws,exited,logs='',ready;
    const configFile=path.join(root,'config/wechatagent.json');
    const server=http.createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
      requests.push({route:req.url,body});
      res.setHeader('Content-Type','application/json');
      if(req.url==='/health')res.end(JSON.stringify({ok:true,project:'WeChatAgent',projectRoot:root,contextMode:'native-session-v1',instanceId:'entry-fixture',instanceStartedAt:Date.now()}));
      else if(req.url==='/followup')res.end(JSON.stringify({text:'RESPOND: Fixture reply '+requests.length}));
      else if(req.url==='/diary-question')res.end(JSON.stringify({handled:true,text:'RESPOND: Fixture notebook reply'}));
      else{res.statusCode=404;res.end('{}');}
    });
    t.after(async()=>{
      ws?.close();
      if(child&&child.exitCode===null&&child.signalCode===null){
        if(child.connected)child.send('stop');
        const force=setTimeout(()=>child.kill(),3000);
        try{await exited;}finally{clearTimeout(force);}
      }
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    });
    const until=async(check,label)=>{
      const deadline=Date.now()+10000;
      while(!check()){
        assert(!/\berror=|ReferenceError|uncaughtException/.test(logs),logs);
        assert(!child||child.exitCode===null,'bridge exited: '+logs);
        assert(Date.now()<deadline,'Timed out: '+label+'\n'+logs);await delay(10);
      }
    };
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const wechat={enabled:true,whitelist:{private:['123'],groups:['456']},wake_mode:'hybrid',wake_words:['助手'],replyLayout:{maxMessages:0},search:{enabled:false},stickers:{enabled:false},proactive:{enabled:false},context:{enabled:false}};
    const save=()=>{const temporary=configFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify({version:1,wechat,persona:{default:'Fixture',chats:{}}}));fs.renameSync(temporary,configFile);};
    fs.mkdirSync(path.dirname(configFile),{recursive:true});save();
    const bridgeConfig=path.join(root,'bridge.json');
    fs.writeFileSync(bridgeConfig,JSON.stringify({project_root:root,platforms:{wechat:{...wechat,onebot:{server:{host:'127.0.0.1',port:0,path:'/ws'}}}},role:'Fixture persona',role_name:'',message_buffer:{path:path.join(root,'state/messages.json')},search_policy_file:configFile,sticker_policy_file:configFile,proactive_policy_file:configFile,context_policy_file:configFile,proactive_state_file:path.join(root,'state/proactive.json'),social:{batch_ms:1,min_interval_ms:0,private_min_interval_ms:0,max_per_minute:100,max_per_ten_minutes:100},dsh_plugin:{url:'http://127.0.0.1:'+server.address().port,token:'fixture-token'}}));
    child=fork(import.meta.filename,['--bridge-entry-fixture',bridgeConfig],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,SOCIAL_ONEBOT_TOKEN:''}});
    exited=new Promise(resolve=>child.once('exit',resolve));
    child.on('error',error=>{logs+='\nuncaughtException '+error.message;});
    child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
    child.on('message',message=>{if(message.ready)ready=message;});
    await until(()=>ready,'entry startup');
    ws=new WebSocket('ws://127.0.0.1:'+ready.port+'/ws');
    ws.addEventListener('error',event=>{logs+='\nuncaughtException '+String(event.error??'fixture WebSocket');});
    ws.addEventListener('message',event=>{
      const action=JSON.parse(event.data);let data={enabled:false,stickers:[],labels:[]};
      if(['send_private_msg','send_group_msg'].includes(action.action)){sent.push(action);data={receipt:'wechat-server-id',message_id:sent.length};}
      ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data}));
    });
    await until(()=>ws.readyState===WebSocket.OPEN,'OneBot connection');
    let sequence=0;
    const send=async(kind,text)=>{
      const count=sent.length;
      ws.send(JSON.stringify({post_type:'message',message_type:kind,self_id:999,user_id:123,...(kind==='group'?{group_id:456}:{}),sender:{user_id:123,nickname:'Fixture'},message_id:++sequence,time:Date.now()/1000,message:[{type:'text',data:{text}}]}));
      await until(()=>sent.length===count+1,'confirmed reply');
      await until(()=>logs.match(/delivery=confirmed/g)?.length===sent.length,'recorded delivery');
    };
    const turns=()=>requests.filter(item=>['/followup','/diary-question'].includes(item.route));
    await send('private','hello fixture');
    assert.equal(turns().at(-1).body.conversationKey,'wechat:private:123');
    assert.equal(turns().at(-1).body.replyMaxMessages,0);assert.equal(turns().at(-1).body.fishNotebookRequest,undefined);
    wechat.replyLayout.maxMessages=1;save();await send('group','助手 hello group');
    assert.equal(turns().at(-1).body.conversationKey,'wechat:group:456');assert.equal(turns().at(-1).body.replyMaxMessages,1);
    const manifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'optional-extensions/fish-notebook/plugin.json'),'utf8'));
    fs.mkdirSync(path.join(root,'plugins/fish-notebook'),{recursive:true});
    fs.writeFileSync(path.join(root,'plugins/fish-notebook/plugin.json'),JSON.stringify(manifest));
    fs.writeFileSync(path.join(root,'config/plugins.json'),JSON.stringify({version:1,plugins:{'fish-notebook':{enabled:true,permissions:manifest.permissions,chats:['wechat:private:123']}}}));
    wechat.replyLayout.maxMessages=4;save();await send('private','看看你的日记');
    assert.equal(turns().at(-1).route,'/diary-question');assert.equal(turns().at(-1).body.replyMaxMessages,4);
    assert.match(turns().at(-1).body.fishNotebookRequest.viewer,/^[a-f0-9]{64}$/);
    await send('group','助手 看看你的日记');
    assert.equal(turns().at(-1).route,'/followup');assert.equal(turns().at(-1).body.fishNotebookRequest,undefined);
    assert.equal(turns().length,4);assert.deepEqual(sent.map(item=>item.action),['send_private_msg','send_group_msg','send_private_msg','send_group_msg']);
  });
}
