import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const {searchPolicy,searchPolicyKey,searchCharCount}=await import(new URL('./search-policy.mjs'+new URL(import.meta.url).search,import.meta.url));

export function admittedSearch(root,key,body){
  if(body.searchTicket===undefined&&body.searchContext===undefined)return null;
  if(!/^[a-f0-9]{64}$/.test(body.searchTicket??'')||typeof body.searchContext!=='string')throw Error('SEARCH_TICKET_INVALID');
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  const policy=searchPolicy(config.wechat,key);
  const state=JSON.parse(fs.readFileSync(path.join(root,'state/search/state.json'),'utf8'));
  const record=state.batches?.[body.searchTicket];
  if(!policy.enabled||state.version!==3||record?.key!==key||record.status!=='ready'||record.policyKey!==searchPolicyKey(policy)||
    !Number.isSafeInteger(record.searches)||record.searches<0||record.searches>policy.maxSearchesPerTurn||record.maxSearches!==policy.maxSearchesPerTurn||
    record.createdAt>Date.now()||Date.now()-record.createdAt>15*60000||record.context!==body.searchContext||
    record.contextDigest!==crypto.createHash('sha256').update(body.searchContext).digest('hex')||
    searchCharCount(body.searchContext)>policy.maxSnippetChars)throw Error('SEARCH_BUDGET_DENIED');
  if(fs.existsSync(path.join(root,'state/search/used',body.searchTicket+'.json')))throw Error('SEARCH_TICKET_SPENT');
  return {ticket:body.searchTicket,text:body.searchContext,requests:0};
}

export function consumeSearchRequest(root,key,search){
  admittedSearch(root,key,{searchTicket:search.ticket,searchContext:search.text});
  const directory=path.join(root,'state/search/used');fs.mkdirSync(directory,{recursive:true});
  try{fs.writeFileSync(path.join(directory,search.ticket+'.json'),JSON.stringify({consumedAt:Date.now()}),{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')throw Error('SEARCH_TICKET_SPENT');throw error;}
}

/** Remove full search snippets from future effective context, retain durable history. */
export function retireSearchContext(session){
  const nodes=new Set(session.surface.nodes);
  for(const event of session.snapshotEvents()){
    if(!nodes.has(event.seq)||event.type!=='user/message'||event.data.source?.socialSearch?.retired!==false)continue;
    session.append('user/message',{...event.data,content:[{type:'text',text:'上一轮联网摘要已释放；历史结论参考该轮 AI 回复，不能把旧摘要当成当前实时信息。'}],
      source:{...event.data.source,socialSearch:{...event.data.source.socialSearch,retired:true}}},
      {surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]});
  }
}
