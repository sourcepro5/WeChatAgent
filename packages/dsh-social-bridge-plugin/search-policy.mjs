export const SEARCH_DEFAULTS=Object.freeze({enabled:false,cache:true,maxResults:3,maxSnippetChars:1200,
  maxSearchesPerTurn:1,timeoutMs:8000,cacheTtlSeconds:900});
const ranges={maxResults:[1,3],maxSnippetChars:[256,3000],maxSearchesPerTurn:[1,3],timeoutMs:[1000,12000],cacheTtlSeconds:[60,3600]};
export function validateSearchSettings(value){
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid search settings');
  for(const key of ['enabled','cache'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw Error('Invalid search '+key);
  for(const [key,[low,high]] of Object.entries(ranges))if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<low||value[key]>high))throw Error('Invalid search '+key);
  if(value.chats!==undefined && (!value.chats||typeof value.chats!=='object'||Array.isArray(value.chats)||Object.entries(value.chats)
    .some(([key,flag])=>!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||!Number.isSafeInteger(Number(key.split(':').at(-1)))||typeof flag!=='boolean')))throw Error('Invalid search chats');
}
export function searchPolicy(wechat,key){
  const settings=wechat?.search;validateSearchSettings(settings);
  return {...Object.fromEntries(Object.entries(SEARCH_DEFAULTS).map(([name,value])=>[name,settings?.[name]??value])),enabled:settings?.chats?.[key]??settings?.enabled??false};
}
export const searchCharCount=text=>[...String(text)].length;
export const searchPolicyKey=policy=>JSON.stringify(policy);
export function searchQuery(rows){
  for(const row of [...rows].reverse()){
    if(row.outgoing||row.interaction==='pat'||row.forwardedRecord)continue;
    let text=String(row.text??'').replace(/^@[\S]+[\s\u2005]+/,'').trim();
    if(!text||text.startsWith('['))continue;
    if(/不要(?:联网|搜索|查)|不用(?:联网|搜索|查)|别(?:联网|搜索|查)|^(?:你|您)(?:能|可以|会|支持)(?:联网搜索|联网|搜索)(?:吗|么|[？?])?$/.test(text))continue;
    const explicit=/(?:帮我|帮忙|请|麻烦)\s*(?:联网)?(?:搜索|查询|搜|查)(?:一下|一搜|一查)?|(?:联网搜索|上网查|网上查|搜索一下|搜一下|搜一搜|查一下|搜搜|搜索|查查)/;
    const fresh=/(?:最新|实时|最近).{0,25}(?:新闻|消息|进展|版本|价格|行情|比分|结果|情况)|(?:今天|明天|后天|现在|目前).{0,20}(?:天气|气温|汇率|股价|价格|比分)|(?:天气|气温|汇率|股价).{0,15}(?:多少|怎样|怎么样|如何|什么|[？?])/;
    if(!explicit.test(text)&&!(fresh.test(text)&&/[？?]|吗|呢|多少|什么|怎么样|如何|怎样|查|搜|^(?:最新|实时|今天|明天).{0,10}(?:新闻|天气|汇率|股价)$/.test(text)))continue;
    text=text.replace(explicit,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\[CQ:[^\]]*\]/gi,' ').replace(/https?:\/\/\S+/gi,' ').replace(/\s+/g,' ').trim();
    if(/这个|这句|这个词|刚才|上面|那个/.test(text)&&row.quoteReply?.reference.kind==='1'&&!row.quoteReply.reference.unavailable)
      text=String(row.quoteReply.reference.text).slice(0,80)+' '+text;
    text=text.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/https?:\/\/\S+/gi,' ').replace(/\s+/g,' ').trim();
    if(text.length<2)return null;
    return {query:[...text].slice(0,80).join(''),fresh:fresh.test(String(row.text))};
  }
  return null;
}
export function searchQueries(rows,limit=1){
  const queries=[];
  for(const row of [...rows].reverse()){
    const request=searchQuery([row]);
    if(request&&!queries.some(item=>item.query.toLowerCase()===request.query.toLowerCase()))queries.push(request);
    if(queries.length>=limit)break;
  }
  return queries;
}
