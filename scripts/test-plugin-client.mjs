import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DshPluginClient } from '../components/qq-bridge/src/dsh/plugin-client.js';

async function fixture(t, results) {
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const result=results[Math.min(requests.length-1,results.length-1)];
    res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const logs=[];
  return {requests,logs,client:new DshPluginClient({url:`http://127.0.0.1:${server.address().port}`,token:'fixture-token',timeoutMs:1000},line=>logs.push(line))};
}

test('reader preparation failure falls back once with explicit unavailable-image notice',async t=>{
  const f=await fixture(t,[{status:503,body:{error:'agent_unavailable',detail:'IMAGE_READER_NOT_READY'}},{status:200,body:{text:'RESPOND: fixture'}}]);
  const meta={images:[{id:'a'.repeat(64)}],batchId:'b'.repeat(64),persona:'fixture'};
  assert.equal(await f.client.followup('wechat:private:123','fixture text',meta),'RESPOND: fixture');
  assert.equal(f.requests.length,2);assert.deepEqual(f.requests[1].images,[]);
  assert.equal(f.requests[1].batchId,meta.batchId);assert.equal(meta.images.length,1);
  assert.match(f.requests[1].message,/不得猜测/);assert.match(f.requests[1].message,/fixture text/);
  assert.equal(f.logs.length,1);
});

test('binding, integrity and model-turn errors are never retried without images',async t=>{
  for(const failure of [{error:'agent_unavailable',detail:'IMAGE_CONVERSATION_MISMATCH'},{error:'agent_unavailable',detail:'IMAGE_INTEGRITY_FAILED'},{error:'turn_failed',detail:'IMAGE_READER_NOT_READY'}]){
    const f=await fixture(t,[{status:503,body:failure}]);
    await assert.rejects(f.client.followup('wechat:private:123','fixture',{images:[{id:'a'.repeat(64)}]}));
    assert.equal(f.requests.length,1);
  }
});

test('a failed text fallback is not retried in a loop',async t=>{
  const f=await fixture(t,[{status:503,body:{error:'agent_unavailable',detail:'IMAGE_READER_NOT_READY'}}]);
  await assert.rejects(f.client.followup('wechat:private:123','fixture',{images:[{id:'a'.repeat(64)}]}));
  assert.equal(f.requests.length,2);
});
