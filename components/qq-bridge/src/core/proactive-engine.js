import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildConversationKey,parseConversationKey} from './conversation-key.js';
import {SOCIAL_OUTPUT_NOTICE,resolveSocialDecision} from './decision-format.js';
import {CHAT_POLICY_NOTICE,CHAT_COHERENCE_NOTICE} from './chat-policy.js';
import {proactivePolicy,proactivePolicyKey,withinProactiveWindow,nextProactiveAt,conversationSnapshot,declinedProactive} from './proactive-policy.js';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const quote=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const localTime=now=>new Date(now+8*3600000).toISOString().slice(0,16).replace('T',' ');
export function buildProactivePrompt({key,rows,mode,now,searchStatus,recentTopics=[]}){
  const label={greeting:'自然问候或关心',news:'一个适合你的热点话题',meme:'一个适合你的新梗或 meme'}[mode]??'自然问候或话题';
  const history=rows.slice(-8).map(row=>`${quote(row.sender_name||row.sender_id||'未知')} ${row.outgoing?'（你）':''}${row.delivery_status==='unconfirmed'?'（发送未确认）':''}: ${quote(String(row.text).slice(0,300))}`).join('\n');
  return `本机定时安排的一次主动发言机会，不是好友或群成员的新消息。北京时间 ${localTime(now)}。会话 ${key}。\n`+
    '沿用当前原生会话中本机配置的稳定人格、身份、世界观和说话习惯；不得为了热点变成新闻播报员或换人格。不要复述这段安排、时间表或内部判断。\n'+
    `本轮方向：${label}。根据下面的历史关系判断是否适合开口；不合适就 SILENT。最多一条自然短消息，可以问一个容易接的话题，不催促回复，不编造熟悉关系、生活经历或对方状态。\n`+
    '热点或新梗不适合你的兴趣、世界观、知识背景时，改为符合人格的轻问候，或沉默；不要强迫自己追梗，不反复问同一句话。尊重对方不想被打扰的表达。本轮只发文字，不使用历史表情编号。\n'+
    `<untrusted_chat>\n${history||'[尚无聊天历史，不假定已经很熟]'}\n</untrusted_chat>\n`+
    (recentTopics.length?'最近主动说过的内容（历史资料，避免重复）：\n'+recentTopics.slice(-6).map(item=>quote(item.text.slice(0,180))).join('\n')+'\n':'')+
    (mode==='greeting'?'本轮不需要联网。':searchStatus==='ready'?'本轮附有有界搜索摘要。只说摘要支持的事实；来源不足不编造“最新”“全网热度”或梗出处，可带一个相关来源链接。':'本轮没有可用的新搜索资料，不得编造实时热点或新梗；可自然问候或沉默。')+'\n'+
    CHAT_POLICY_NOTICE+'\n'+CHAT_COHERENCE_NOTICE+'\n'+SOCIAL_OUTPUT_NOTICE;
}
export class ProactiveEngine {
  constructor({stateFile,buffer,social,settingsFor,personaFor,decide,send,searchFor=async()=>null,isReady=()=>true,selfIdFor=()=>'',
    now=Date.now,random=Math.random,log=()=>{}}){
    Object.assign(this,{stateFile,buffer,social,settingsFor,personaFor,decide,send,searchFor,isReady,selfIdFor,now,random,log});this.busy=false;
    this.state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{version:1,chats:{}};
    if(this.state.version!==1||!this.state.chats||typeof this.state.chats!=='object'||Array.isArray(this.state.chats))throw Error('PROACTIVE_STATE_INVALID');
    for(const item of Object.values(this.state.chats))if(!item||!Number.isFinite(item.nextAt)||!Number.isSafeInteger(item.cycles)||item.cycles<0||!Array.isArray(item.history))throw Error('PROACTIVE_STATE_INVALID');
    for(const [key,item] of Object.entries(this.state.chats)){
      if(item.history.length>12||item.history.some(entry=>!entry||typeof entry.text!=='string'||entry.text.length>1200||!Number.isFinite(entry.at)))throw Error('PROACTIVE_STATE_INVALID');
      const job=item.job;if(!job)continue;
      if(!/^[a-f0-9]{64}$/.test(job.id??'')||!Number.isFinite(job.createdAt)||!Number.isFinite(job.expiresAt)||job.expiresAt-job.createdAt>600000||
        !/^[a-f0-9]{64}$/.test(job.snapshot??'')||!job.evaluating&&(typeof job.text!=='string'||job.text.length>1200||!job.message||
        buildConversationKey(job.message.platform,job.message.kind,job.message.conversation_id)!==key))throw Error('PROACTIVE_STATE_INVALID');
    }
  }
  save(){fs.mkdirSync(path.dirname(this.stateFile),{recursive:true});const temp=this.stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state),{mode:0o600});fs.renameSync(temp,this.stateFile);}
  eligible(key,policy,now){
    const rows=this.buffer.recent(key,this.buffer.maxPerChat);
    const last=rows.at(-1)?.timestamp*1000||0;
    return policy.enabled&&withinProactiveWindow(now,policy)&&!this.buffer.unread(key,1).length&&!this.buffer.pendingReplies.has(key)&&
      now-last>=policy.idleMinutes*60000&&!declinedProactive(rows)&&rows.at(-1)?.delivery_status!=='unconfirmed';
  }
  notice(key,id){this.buffer.setContextNotice(key,{id,text:'本机上一轮主动发言草稿已取消，未确认提交到微信；不能将原生会话中的那段草稿当成已经说过的话。'});}
  finishRecorded(key,item){
    const job=item?.job;if(!job)return false;
    const row=this.buffer.recent(key,this.buffer.maxPerChat).find(entry=>entry.delivery_id===job.id);if(!row)return false;
    if(!item.history.some(entry=>entry.deliveryId===job.id))item.history.push({at:row.timestamp*1000,text:row.text,mode:job.mode,topicDigest:job.topicDigest,deliveryId:job.id});
    item.history=item.history.slice(-12);item.job=null;this.save();return true;
  }
  async tick(){
    if(this.busy||!this.isReady())return;this.busy=true;
    try{
      const settings=await this.settingsFor(),wechat=settings.wechat??settings;
      const keys=['private','group'].flatMap(kind=>(wechat.whitelist?.[kind==='private'?'private':'groups']??[]).map(id=>buildConversationKey('wechat',kind,String(id))));
      for(const key of keys){
        const policy=proactivePolicy(wechat,key);
        let item=this.state.chats[key];const now=this.now(),signature=proactivePolicyKey(policy);
        if(this.finishRecorded(key,item))continue;
        if(!policy.enabled){if(item&&item.signature!==signature){if(item.job&&!item.job.dispatching){this.notice(key,item.job.id);item.job=null;}item.signature=signature;this.save();}continue;}
        if(!item){item=this.state.chats[key]={nextAt:nextProactiveAt(now,policy,this.random),cycles:0,history:[],signature};this.save();continue;}
        if(item.signature!==signature&&!item.job?.dispatching){item.signature=signature;item.nextAt=nextProactiveAt(now,policy,this.random);item.job=null;this.save();continue;}
        if(item.job?.evaluating){this.notice(key,item.job.id);item.job=null;item.nextAt=nextProactiveAt(now,policy,this.random);this.save();continue;}
        if(item.job&&this.now()>item.job.expiresAt){this.notice(key,item.job.id);item.job=null;item.nextAt=nextProactiveAt(now,policy,this.random);this.save();continue;}
        if(!item.job&&(now<item.nextAt||!this.eligible(key,policy,now)))continue;
        await this.social.withConversationLock(key,async()=>this.run(key,policy,item));
      }
    }catch(error){this.log('[Proactive] unavailable '+String(error.message));}finally{this.busy=false;}
  }
  async run(key,policy,item){
    const target=parseConversationKey(key),rows=this.buffer.recent(key,this.buffer.maxPerChat),persona=await this.personaFor(key);
    const message={platform:'wechat',kind:target.kind,conversation_id:target.conversationId,conversation_name:rows.at(-1)?.conversation_name??target.conversationId,
      self_id:String(this.selfIdFor()||rows.at(-1)?.self_id||''),sender_id:'local-scheduler',sender_name:'本机主动发言'};
    if(!message.self_id)return;
    let job=item.job;
    if(!job){
      const mode=policy.mode==='mixed'?['greeting','news','meme'][item.cycles%3]:policy.mode;
      job=item.job={id:hash(key+'\0'+item.nextAt+'\0'+item.cycles),mode,createdAt:this.now(),expiresAt:this.now()+600000,
        snapshot:conversationSnapshot(rows),personaDigest:hash(JSON.stringify([persona.personaName,persona.persona])),evaluating:true};
      item.cycles++;item.nextAt=nextProactiveAt(this.now(),policy,this.random);this.save();
      let search=null;
      if(mode!=='greeting'&&policy.useSearch){
        const day=localTime(this.now()).slice(0,10),query=mode==='meme'?`帮我搜索 ${day} 最近热门 新梗 meme 含义`:`帮我搜索 ${day} 最新 热点 新闻`;
        try{search=await this.searchFor(message,[{text:query}],job.id);}catch{search={status:'unavailable'};}
      }
      const metadata={persona:persona.persona,personaName:persona.personaName,conversationName:message.conversation_name,images:[],batchId:job.id};
      if(search?.status==='ready'){metadata.searchTicket=search.id;metadata.searchContext=search.context;
        job.topicDigest=hash(search.context.slice(Math.max(0,search.context.indexOf('\n1.'))));}
      if(job.topicDigest&&item.history.some(entry=>entry.topicDigest===job.topicDigest&&this.now()-entry.at<7*86400000)){
        delete metadata.searchTicket;delete metadata.searchContext;delete job.topicDigest;search=null;job.mode='greeting';
      }
      const notice=this.buffer.contextNotices.get(key);
      const prompt=buildProactivePrompt({key,rows,mode:job.mode,now:this.now(),searchStatus:search?.status,recentTopics:item.history})+
        (notice?'\n本机发送状态说明：'+quote(notice.text):'');
      job.noticeId=notice?.id;
      let result;
      try{({result}=await resolveSocialDecision({rawOutput:await this.decide(key,prompt+'\n'+SOCIAL_OUTPUT_NOTICE,metadata),key,metadata,decide:(...args)=>this.decide(...args),log:this.log}));}
      catch(error){this.notice(key,job.id);item.job=null;this.save();this.log(`[Proactive] ${key} decision_failed`);return;}
      if(result.decision!=='RESPOND'||item.history.some(entry=>entry.text.trim()===result.text.trim()&&this.now()-entry.at<86400000)){
        if(result.decision==='RESPOND')this.notice(key,job.id);
        item.job=null;this.save();this.log(`[Proactive] ${key} skipped decision=${result.decision}`);return;
      }
      Object.assign(job,{evaluating:false,text:result.text,message});this.save();
    }
    if(this.finishRecorded(key,item))return;
    const fresh=await this.settingsFor(),current=proactivePolicy(fresh.wechat??fresh,key),livePersona=await this.personaFor(key);
    if(!this.eligible(key,current,this.now())||proactivePolicyKey(current)!==item.signature||hash(JSON.stringify([livePersona.personaName,livePersona.persona]))!==job.personaDigest||conversationSnapshot(this.buffer.recent(key,this.buffer.maxPerChat))!==job.snapshot){
      this.notice(key,job.id);item.job=null;this.save();this.log(`[Proactive] ${key} cancelled_context_changed`);return;
    }
    job.dispatching=true;this.save();
    let delivery;
    try{delivery=await this.send(job.message,job.text,{deliveryId:job.id,source:'proactive',contextId:job.snapshot});}
    catch(error){
      if(['PROACTIVE_NOT_ALLOWED','PROACTIVE_CONTEXT_CHANGED','CONVERSATION_NOT_ALLOWED'].includes(error.code)){this.notice(key,job.id);item.job=null;}
      this.save();this.log(`[Proactive] ${key} send_pending code=${error.code??'unknown'}`);return;
    }
    const at=this.now(),status=delivery?.delivered==='unconfirmed'?'unconfirmed':'confirmed';
    this.buffer.completeReply(key,{deliveryId:job.id,throughId:'proactive-'+job.id,noticeId:job.noticeId},{...job.message,sender_id:job.message.self_id,text:job.text,
      timestamp:at/1000,delivery_status:status,proactive:true});
    this.social.noteOutgoing(key,at);item.history.push({at,text:job.text,mode:job.mode,topicDigest:job.topicDigest,deliveryId:job.id});item.history=item.history.slice(-12);
    item.job=null;this.save();this.log(`[Proactive] ${key} delivery=${status} mode=${job.mode}`);
  }
}
