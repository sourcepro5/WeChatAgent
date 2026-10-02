import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {imageBlocks,offloadCompletedImages} from '../packages/dsh-social-bridge-plugin/image-input.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';

test('image references stay typed through OneBot and reject arbitrary paths',()=>{
  const event={post_type:'message',message_type:'private',user_id:123,message:[{type:'image',data:{file:'wechatagent://image/'+'a'.repeat(64),media_id:'a'.repeat(64)}}]};
  const message=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.equal(message.message_type,'image');assert.equal(message.text,'[图片]');assert.deepEqual(message.images,[{id:'a'.repeat(64)}]);
  assert.equal(normalizeOneBotEvent('wechat','wechat-onebot',{...event,message:[{type:'image',data:{file:'C:/private/file.png'}}]}).images.length,0);
});
test('native image admission verifies authenticated source, integrity and conversation binding',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent image '));fs.mkdirSync(path.join(dir,'state'));
  const bytes=Buffer.from('fixture image bytes'),id='a'.repeat(64), key='wechat:private:123',saved=[];
  let target=key;
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-reader-token');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({imageId:id,conversationKey:target,b64:bytes.toString('base64'),mime:'image/jpeg',sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  fs.writeFileSync(path.join(dir,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:`http://127.0.0.1:${server.address().port}`,reader_token:'fixture-reader-token'}));
  const services={llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})},attachments:{saveImage:async image=>{saved.push(image);return {attachmentId:'sha256:fixture',mediaType:image.mediaType};}}};
  const ctx={get:name=>services[name]};
  const blocks=await imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model');
  assert.equal(blocks[0].type,'image');assert.equal(saved[0].data.compare(bytes),0);
  target='wechat:private:456';await assert.rejects(imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model'),/CONVERSATION_MISMATCH/);
  services.llm.resolveModelInfo=async()=>({inputModalities:['text']});await assert.rejects(imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model'),/UNSUPPORTED/);
});
test('completed image turns retain durable attachment references but stop rebilling image bytes',()=>{
  const events=[{seq:4,type:'user/message',data:{content:[{type:'text',text:'fixture'},{type:'image',attachment:{attachmentId:'sha256:fixture'}},{type:'image',attachment:{attachmentId:'sha256:previous'},offloaded:true}]}}];let appended;
  offloadCompletedImages({eventAt:seq=>events.find(e=>e.seq===seq),append:(type,data)=>{appended={type,data};}},[4]);
  assert.deepEqual(appended,{type:'image/offload',data:{targets:[{seq:4,imageIndexes:[0]}]}});
});
