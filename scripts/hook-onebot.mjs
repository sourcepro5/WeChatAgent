import fs from 'node:fs';
import path from 'node:path';
import { PAT_TYPE, FORWARD_TYPE, QUOTE_TYPE, CARD_TYPE, CARD_TYPES, normalizeForwardedRecord, normalizeQuoteReply, normalizeSharedCard, sharedCardText } from '../components/qq-bridge/src/core/wechat-events.js';
import { stickerPolicy, cleanStickerLabel } from '../components/qq-bridge/src/core/sticker-policy.js';
import {FileDeliveryWorker} from './file-delivery-worker.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';
import {proactivePolicy,withinProactiveWindow,conversationSnapshot,declinedProactive} from '../components/qq-bridge/src/core/proactive-policy.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const onebotId = value => Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
export const conversationId = (wxid, name, mappedId) => {
  if(mappedId!==undefined){
    if(!/^[1-9]\d*$/.test(String(mappedId))||!Number.isSafeInteger(Number(mappedId)))throw new Error('INVALID_CONVERSATION_ID');
    return Number(mappedId);
  }
  return onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
};
class AdapterError extends Error { constructor(code,data) { super(code); this.name = 'AdapterError';this.data=data; } }
const fail = code => { throw new AdapterError(code); };
const cleanAccountId = value => String(value ?? '').replace(/_[a-zA-Z0-9]{4}$/, '');
const systemErrorCode = error => {
  for(let current=error,depth=0;current&&depth<4;current=current.cause,depth++)if(typeof current.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(current.code))return current.code;
  return undefined;
};
function startupError(code,cause,stage,port){
  const error=new AdapterError(code);error.cause=cause;error.startup={stage,...(Number.isInteger(port)?{port}:{})};return error;
}
function healthError(error,prefix,stage,endpoint){
  let port;try{port=Number(new URL(endpoint).port||80);}catch{}
  if(error instanceof AdapterError){error.startup??={stage,...(Number.isInteger(port)?{port}:{})};return error;}
  const code=systemErrorCode(error);
  const reason=code==='ECONNREFUSED'?'NOT_LISTENING':error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ABORT_ERR'].includes(code)?'HEALTH_TIMEOUT':error instanceof SyntaxError?'HEALTH_INVALID_RESPONSE':['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code)?'CONNECTION_RESET':'HEALTH_FAILED';
  return startupError(prefix+'_'+reason,error,stage,port);
}
export function adapterStartupMessage(error,{checkOnly=false,stage='configuration',port}={}){
  const code=error instanceof AdapterError&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)?error.message:'ADAPTER_START_FAILED';
  const details=error?.startup??{},phase=details.stage??stage,number=details.port??(phase==='adapter-port-bind'?port:undefined),system=systemErrorCode(error);
  return (checkOnly?'WeChat-Hook check failed: ':'Adapter startup failed: ')+code+' stage='+phase+(Number.isInteger(number)?' port='+number:'')+(system?' system='+system:'');
}

export function textSegments(message) {
  if (typeof message === 'string') {
    // Raw OneBot strings may contain CQ segments. This sender only accepts text.
    if (/\[CQ:/i.test(message)) fail('TEXT_SEGMENTS_REQUIRED');
    message = [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message) || !message.length || message.some(s => s?.type !== 'text' || typeof s.data?.text !== 'string')) fail('TEXT_ONLY');
  const text = message.map(s => s.data.text).join('');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 16000) fail('INVALID_TEXT');
  return text;
}

export class HookOneBot {
  constructor({ directory = root, fetchImpl = fetch, receiptTimeoutMs, pollMs = 400 } = {}) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.receiptOverride = receiptTimeoutMs;
    this.pollMs = pollMs;
    this.socket = null;
    this.stopped = false;
    this.controllers = new Set();
    this.pending = [];
    this.seen = new Map();
    this.targetsSending = new Set();
    this.textDeliveries=new TextDeliveryStore(path.join(directory,'state/text-deliveries'));
    this.stickerPending = new Map();
    this.stickerStateFile=path.join(directory,'state/sticker-delivery-pending.json');
    if(fs.existsSync(this.stickerStateFile)){
      const state=read(this.stickerStateFile);
      if(state.version!==1 || !Array.isArray(state.attempts))fail('STICKER_DELIVERY_STATE_INVALID');
      for(const [key,attempt] of state.attempts)this.stickerPending.set(key,{...attempt,baseline:new Set(attempt.baseline)});
    }
    this.activeActions = 0;this.fileWorker=new FileDeliveryWorker(this,{log:line=>console.log(new Date().toISOString(),line)});
    this.status = { backend: 'wechat-hook', project:'WeChatAgent',component:'adapter',statusVersion:1,pid:process.pid,projectRoot:path.resolve(directory),ready:false,ob_connected: false, reader_connected: false,
      hook_connected: false, hook_account_verified: false, received: 0, confirmed_sends: 0,
      failed_sends: 0, last_error: '', version: '' };
    this.reload();
  }
  reload() {
    this.project = read(path.join(this.directory, 'config', 'wechatagent.json'));
    this.api = read(path.join(this.directory, 'state', 'wechat-io-config.json'));
    this.hook = this.project.hook;
    if (this.project.runtime.sender !== 'wechat-hook' || !this.hook || this.project.runtime.weflowMode !== 'nt') fail('HOOK_NT_CONFIG_REQUIRED');
    const url = new URL(this.hook.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('HOOK_LOOPBACK_REQUIRED');
    this.nativeToken = fs.readFileSync(path.join(this.directory, 'state', 'hook', 'native-token.txt'), 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(this.nativeToken)) fail('HOOK_TOKEN_MISSING');
  }
  allowed(kind, target) { return this.project.wechat.whitelist[kind === 'group' ? 'groups' : 'private'].map(String).includes(String(target)); }
  async json(base, route, options = {}, timeout = 4000) {
    const response = await this.fetch(base.replace(/\/$/, '') + route, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) fail('API_HTTP_' + response.status);
    const result = await response.json();
    if (result?.success === false) fail('READER_NOT_READY');
    return result;
  }
  reader(route) { return this.json(this.api.reader_base_url, route, { headers: { Authorization: 'Bearer ' + this.api.reader_token } }); }
  native(route, body, account) {
    return this.json(this.hook.baseUrl, route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + this.nativeToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(account ? { 'X-WeChatAgent-Account': account } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.hook.requestTimeoutMs ?? 5000);
  }
  async checkNative() {
    this.status.hook_connected = false; this.status.hook_account_verified = false;
    this.startupStage='reader-status';
    const reader = await this.reader('/api/v1/reader/status').catch(error=>{throw healthError(error,'READER','reader-status',this.api.reader_base_url);});
    if (!reader || reader.backend !== 'weflow-cli-nt' || !reader.ownWxid || !reader.accountDirectory) fail('READER_ACCOUNT_METADATA_REQUIRED');
    this.ownWxid = reader.ownWxid;
    this.startupStage='hook-health';
    const native = await this.native('/WeChatAgent/health').catch(error=>{throw healthError(error,'HOOK','hook-health',this.hook.baseUrl);});
    if(!native || typeof native!=='object')fail('HOOK_HEALTH_INVALID_RESPONSE');
    this.status.native_sticker_send = native.nativeStickerSend===true;this.status.native_file_send=native.nativeFileSend===true;this.status.fileTransfer='durable-outbox-v1';
    this.status.hook_connected = true; this.status.version = native.version ?? '';
    const accountProblem=hookAccountProblem(native,reader.accountDirectory,this.hook.expectedVersion);
    if(accountProblem)fail(accountProblem);
    this.status.hook_account_verified = true;
    return { account: reader.accountDirectory.toLowerCase(), selfId: onebotId(reader.ownWxid) };
  }
  async waitForNative({timeoutMs=35000,intervalMs=250,onWaiting=()=>{}}={}) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isFinite(intervalMs)||intervalMs<1)fail('INVALID_HOOK_WAIT');
    const deadline=Date.now()+timeoutMs;let notified=false;
    for(;;){
      try{return await this.checkNative();}
      catch(error){
        if(!(error instanceof AdapterError)||!['HOOK_NOT_LISTENING','HOOK_HEALTH_TIMEOUT','HOOK_LOGIN_REQUIRED','HOOK_INITIALIZATION_PENDING'].includes(error.message))throw error;
        if(Date.now()>=deadline){if(error.message==='HOOK_LOGIN_REQUIRED')throw error;fail('HOOK_INITIALIZATION_TIMEOUT');}
        if(!notified){notified=true;onWaiting(error.message);}
        await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(1,deadline-Date.now()))));
      }
    }
  }
  async resolveTarget(kind, target) {
    const data = await this.reader('/api/v1/sessions?limit=500');
    const matches = (data.sessions ?? []).filter(s => s.username &&
      (s.username.includes('@chatroom') ? 'group' : 'private') === kind &&
      String(conversationId(s.username, s.displayName, s.conversationId)) === String(target));
    if (matches.length !== 1 || matches[0].username === this.ownWxid) fail('TARGET_MAPPING_AMBIGUOUS_OR_MISSING');
    return matches[0].username;
  }
  async messages(wxid) {
    const result = await this.reader('/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=100');
    if (!Array.isArray(result.messages)) fail('INVALID_RECEIPT_RESPONSE');
    return result.messages;
  }
  async send(kind, target, text, deliveryId, proactive) {
    const key = `${kind}:${target}`;
    if (this.targetsSending.has(key) || this.targetsSending.size >= (this.hook.maxConcurrentSends ?? 4)) fail('SENDER_BUSY');
    this.targetsSending.add(key);
    try {
      const identity = await this.checkNative();
      const wxid = await this.resolveTarget(kind, target);
      const operation=this.textDeliveries.key(kind,target,deliveryId,text);
      let attempt=this.textDeliveries.get(operation);
      if(attempt&&(attempt.account!==identity.account||attempt.wxid!==wxid))fail('TEXT_DELIVERY_ACCOUNT_MISMATCH');
      if(attempt&&attempt.text!==text)fail('TEXT_DELIVERY_ID_CONFLICT');
      if(attempt?.state==='confirmed'&&(deliveryId||Date.now()-attempt.confirmedAt<60000)){
        this.status.last_error='';return {...attempt.response,reused:true};
      }
      // Rejections are definitive pre-submission failures. Legacy records do
      // not carry the original reason, so never blindly resubmit those.
      let rejectedBusy;
      if(attempt?.state==='rejected'){
        if(attempt.rejection?.code==='API_HTTP_429'){rejectedBusy=attempt;attempt=null;}
        else throw new AdapterError(attempt.rejection?.code??'NATIVE_SEND_REJECTED',{rejected:true,attempted:false,delivery_id:deliveryId??operation});
      }
      if(attempt?.state==='confirmed')attempt=null;
      this.reload();
      if (!this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
      if(!attempt){
        const currentRows=await this.messages(wxid);
        if(proactive)this.assertProactive(kind,target,currentRows,proactive,identity,wxid);
        const baseline=currentRows.map(row=>String(row.localId)).filter(id=>/^\d+$/.test(id));
        attempt={version:1,key:operation,deliveryId:deliveryId??'',account:identity.account,wxid,text,baseline,
          startedAt:Date.now(),state:'dispatching',...(rejectedBusy?{rejection:rejectedBusy.rejection,firstRejection:rejectedBusy.firstRejection??rejectedBusy.rejection}:{})};
        this.textDeliveries.put(attempt); // Persist before submission; replay must never submit it twice.
        const reject=(code,nativeRet)=>{
          const rejection={code,at:Date.now(),...(Number.isSafeInteger(nativeRet)?{nativeRet}:{})};
          attempt.state='rejected';attempt.rejection=rejection;attempt.firstRejection??=rejection;
          this.textDeliveries.put(attempt);
        };
        let accepted;
        try{accepted=await this.native('/SendTextMsg',{wxidorgid:wxid,msg:text},identity.account);}
        catch(error){
          if(/^API_HTTP_(400|401|403|409|429)$/.test(error.message)){
            reject(error.message);
            throw new AdapterError(error.message==='API_HTTP_429'?'SENDER_BUSY':error.message,{rejected:true,attempted:false,delivery_id:deliveryId??operation});
          }
          attempt.state='unconfirmed';this.textDeliveries.put(attempt);
          throw new AdapterError('TEXT_DELIVERY_UNCONFIRMED',{attempted:true,delivery_id:deliveryId??operation});
        }
        if(accepted?.ret!==0){reject('NATIVE_SEND_REJECTED',accepted?.ret);throw new AdapterError('NATIVE_SEND_REJECTED',{rejected:true,attempted:false,delivery_id:deliveryId??operation});}
        attempt.state='accepted';this.textDeliveries.put(attempt);
      }
      const deadline = Date.now() + (this.receiptOverride ?? this.hook.receiptTimeoutMs ?? 18000);
      try{
        do {
          const rows=await this.messages(wxid);
          const candidates=rows.filter(row=>row.isSend&&(row.localType===1||row.localType===undefined)&&Number.isSafeInteger(Number(row.localId))&&Number(row.localId)>0&&
            !attempt.baseline.includes(String(row.localId))&&Number(row.createTime)>=Math.floor(attempt.startedAt/1000)-30&&
            String(row.fullText??row.content??row.parsedContent??'').trim()===text.trim())
            .sort((a,b)=>Number(a.createTime)-Number(b.createTime)||Number(a.localId)-Number(b.localId));
          if(!attempt.candidateId&&candidates.length){attempt.candidateId=String(candidates[0].localId);this.textDeliveries.put(attempt);}
          const row=candidates.find(item=>String(item.localId)===attempt.candidateId);
          if(row&&/^\d{1,32}$/.test(String(row.serverId))&&BigInt(row.serverId)>0n){
            attempt.state='confirmed';attempt.confirmedAt=Date.now();
            attempt.response={message_id:Number(row.localId),receipt:'wechat-server-id',delivered:'database-confirmed'};
            this.textDeliveries.put(attempt);this.status.confirmed_sends++;this.status.last_error='';
            return attempt.response;
          }
          await sleep(this.pollMs);
        }while(Date.now()<deadline&&!this.stopped);
      }catch(error){if(error instanceof AdapterError&&error.message==='TEXT_DELIVERY_STATE_INVALID')throw error;}
      attempt.state='unconfirmed';this.textDeliveries.put(attempt);
      throw new AdapterError('TEXT_DELIVERY_UNCONFIRMED',{attempted:true,delivery_id:deliveryId??operation});
    } finally { this.targetsSending.delete(key); }
  }
  assertProactive(kind,target,currentRows,proactive,identity,wxid){
    this.reload();const conversation='wechat:'+kind+':'+target,policy=proactivePolicy(this.project.wechat,conversation);
    if(!policy.enabled||!withinProactiveWindow(Date.now(),policy))fail('PROACTIVE_NOT_ALLOWED');
    const saved=fs.existsSync(path.join(this.directory,'state/social-messages.json'))?read(path.join(this.directory,'state/social-messages.json')):{chats:{}};
    let preceding;
    if(proactive.precedingDeliveryId){
      preceding=this.textDeliveries.get(this.textDeliveries.key(kind,target,proactive.precedingDeliveryId,''));
      if(preceding?.state!=='confirmed'||preceding.account!==identity.account||preceding.wxid!==wxid||preceding.text.startsWith('[STICKER:'))fail('INVALID_PROACTIVE_CONTEXT');
    }
    const rows=saved.chats?.[conversation]??[];
    if(saved.pendingReplies?.[conversation]||declinedProactive(rows)||conversationSnapshot(rows)!==proactive.contextId||
      currentRows.some(row=>Number(row.createTime)*1000>Date.now()-policy.idleMinutes*60000&&
        !(preceding&&row.isSend&&String(row.localId)===String(preceding.response.message_id)&&String(row.fullText??row.content??row.parsedContent??'').trim()===preceding.text.trim())))fail('PROACTIVE_CONTEXT_CHANGED');
  }
  async stickerList(kind,target,query){
    this.reload();
    if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    if(!stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target).enabled)return {enabled:false,stickers:[]};
    await this.checkNative();
    if(!this.status.native_sticker_send)return {enabled:false,stickers:[]};
    const key='wechat:'+kind+':'+target;
    const result=await this.reader('/api/v1/stickers?conversationKey='+encodeURIComponent(key)+(typeof query==='string'&&query.trim()?'&query='+encodeURIComponent(query.slice(0,500)):''));
    return {enabled:true,stickers:(result.stickers??[]).filter(item=>/^[a-f0-9]{64}$/.test(item?.id??'')).slice(0,20).map(item=>({id:item.id,receivedAt:item.receivedAt,...(cleanStickerLabel(item)??{})}))};
  }
  async stickerLabels(kind,target,params){
    this.reload();if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    const policy=stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target);
    if(!policy.labelCache)return {labels:[],saved:0};
    const result=await this.json(this.api.reader_base_url,'/api/v1/stickers/labels',{method:'POST',headers:{Authorization:'Bearer '+this.api.reader_token,'Content-Type':'application/json'},body:JSON.stringify({...params,conversationKey:'wechat:'+kind+':'+target})});
    return result;
  }
  persistStickerPending(){
    const temp=this.stickerStateFile+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({version:1,attempts:[...this.stickerPending].map(([key,item])=>[key,{...item,baseline:[...item.baseline]}])}),{mode:0o600});
    fs.renameSync(temp,this.stickerStateFile);
  }
  async sendSticker(kind,target,id,deliveryId,proactive,receiptOnly=false,deferReceipt=false,deadlineAt,abandon=false){
    if(abandon&&(!deliveryId||!receiptOnly))fail('INVALID_RECEIPT_QUERY');
    this.reload();
    if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
    if(!/^[a-f0-9]{64}$/.test(id))fail('INVALID_STICKER_REFERENCE');
    const operation=deliveryId?this.textDeliveries.key(kind,target,deliveryId,'[STICKER:'+id+']'):null;
    const completed=operation?this.textDeliveries.get(operation):null;
    if(completed&&completed.text!=='[STICKER:'+id+']')fail('TEXT_DELIVERY_ID_CONFLICT');
    if(abandon){
      const key=`${kind}:${target}`,attempt=this.stickerPending.get(key);
      if(this.targetsSending.has(key))fail('SENDER_BUSY');
      if(attempt?.deliveryId===deliveryId&&attempt.id===id){
        if(completed?.state!=='confirmed')this.textDeliveries.put({version:1,key:operation,deliveryId,account:attempt.account,wxid:attempt.wxid,text:'[STICKER:'+id+']',baseline:[],startedAt:attempt.started*1000,state:'unconfirmed'});
        this.stickerPending.delete(key);this.persistStickerPending();
      }
      return {released:true};
    }
    if(!stickerPolicy(this.project.wechat,'wechat:'+kind+':'+target).enabled&&!this.stickerPending.has(`${kind}:${target}`)&&completed?.state!=='confirmed')fail('STICKER_SENDING_DISABLED');
    const key=`${kind}:${target}`;
    if(this.targetsSending.has(key)||this.targetsSending.size>=(this.hook.maxConcurrentSends??4))fail('SENDER_BUSY');
    this.targetsSending.add(key);
    try{
      const identity=await this.checkNative();if(!this.status.native_sticker_send)fail('NATIVE_STICKER_UNAVAILABLE');
      const wxid=await this.resolveTarget(kind,target),conversationKey='wechat:'+key;
      const stale=this.stickerPending.get(key);
      if(stale&&Date.now()-stale.started*1000>60000){
        if(stale.deliveryId){
          const oldKey=this.textDeliveries.key(kind,target,stale.deliveryId,'[STICKER:'+stale.id+']');
          if(this.textDeliveries.get(oldKey)?.state!=='confirmed')this.textDeliveries.put({version:1,key:oldKey,deliveryId:stale.deliveryId,account:stale.account,wxid:stale.wxid,text:'[STICKER:'+stale.id+']',baseline:[],startedAt:stale.started*1000,state:'unconfirmed'});
        }
        this.stickerPending.delete(key);this.persistStickerPending();
      }
      if(completed?.state==='confirmed'){
        if(completed.account!==identity.account||completed.wxid!==wxid)fail('TEXT_DELIVERY_ACCOUNT_MISMATCH');
        if(this.stickerPending.get(key)?.id===id){this.stickerPending.delete(key);this.persistStickerPending();}
        return {...completed.response,reused:true};
      }
      const keyOf=row=>JSON.stringify([row.localId,row.createTime]);
      let attempt=this.stickerPending.get(key);
      // A persisted uncertain operation without its receipt state is terminal:
      // allow a new delivery ID, but never submit the old one a second time.
      const prior=operation?this.textDeliveries.get(operation):null;
      if(!attempt&&prior&&prior.state!=='confirmed')fail('STICKER_RECEIPT_STATE_UNAVAILABLE');
      if(attempt && attempt.id!==id)fail('STICKER_PREVIOUS_DELIVERY_UNCONFIRMED');
      if(attempt && (attempt.account!==identity.account || attempt.wxid!==wxid))fail('STICKER_DELIVERY_ACCOUNT_MISMATCH');
      if(receiptOnly&&(!attempt||attempt.deliveryId&&attempt.deliveryId!==deliveryId))fail('STICKER_RECEIPT_STATE_UNAVAILABLE');
      if(!attempt){
      if(deadlineAt!==undefined&&Date.now()>=deadlineAt)fail('STICKER_DELIVERY_EXPIRED');
      const sticker=await this.reader('/api/v1/stickers/'+id+'?conversationKey='+encodeURIComponent(conversationKey));
      if(sticker.id!==id || sticker.conversationKey!==conversationKey || !/^[a-f0-9]{32}$/.test(sticker.fields?.md5??''))fail('STICKER_BINDING_INVALID');
        const currentRows=await this.messages(wxid);
        if(proactive)this.assertProactive(kind,target,currentRows,proactive,identity,wxid);
        attempt={id,md5:sticker.fields.md5,account:identity.account,wxid,deliveryId,baseline:new Set(currentRows.map(keyOf)),started:Math.floor(Date.now()/1000)-1};
        this.reload();if(!this.allowed(kind,target))fail('CONVERSATION_NOT_ALLOWED');
        if(!stickerPolicy(this.project.wechat,conversationKey).enabled)fail('STICKER_SENDING_DISABLED');
        if(deadlineAt!==undefined&&Date.now()>=deadlineAt)fail('STICKER_DELIVERY_EXPIRED');
        this.stickerPending.set(key,attempt);
        this.persistStickerPending();
        let accepted;
        try{accepted=await this.native('/SendStickerMsg',{wxidorgid:wxid,sticker:sticker.fields,path:sticker.path},identity.account);}
        catch(error){if(/^API_HTTP_(400|401|403|409|429)$/.test(error.message)){this.stickerPending.delete(key);this.persistStickerPending();}throw error;}
        if(accepted?.ret!==0){this.stickerPending.delete(key);this.persistStickerPending();fail('NATIVE_STICKER_REJECTED');}
      }
      const deadline=Date.now()+(this.receiptOverride??this.hook.receiptTimeoutMs??18000);
      do{
        for(const row of await this.messages(wxid)){
          const nativeSticker=row.localType===47 || row.localType===34359738417 || row.localType===49&&row.stickerKind==='appmsg-8';
          if(row.isSend && nativeSticker && !attempt.baseline.has(keyOf(row)) && row.createTime>=attempt.started-29 &&
            Number.isSafeInteger(Number(row.localId)) && Number(row.localId)>0 && /^\d+$/.test(String(row.serverId)) && BigInt(row.serverId)>0n &&
            row.stickerMd5===attempt.md5){
            const response={message_id:Number(row.localId),receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-sticker'};
            if(operation)this.textDeliveries.put({version:1,key:operation,deliveryId,account:identity.account,wxid,text:'[STICKER:'+id+']',
              baseline:[],startedAt:attempt.started*1000,state:'confirmed',confirmedAt:Date.now(),response});
            this.stickerPending.delete(key);this.persistStickerPending();this.status.confirmed_sends++;this.status.last_error='';
            return response;
          }
        }
        if(receiptOnly||deferReceipt)break;
        await sleep(this.pollMs);
      }while(Date.now()<deadline&&!this.stopped);
      throw new AdapterError('STICKER_DELIVERY_UNCONFIRMED',{attempted:true,delivery_id:deliveryId??''});
    }finally{this.targetsSending.delete(key);}
  }
  async action(request) {
    const response = { status: 'failed', retcode: 1407, data: {}, ...(request?.echo === undefined ? {} : { echo: request.echo }) };
    this.activeActions++;
    try {
      if (this.activeActions > 8) fail('SENDER_BUSY');
      this.reload();
      const action = request?.action, params = request?.params ?? {};
      let data;
      if (['send_msg', 'send_private_msg', 'send_group_msg'].includes(action)) {
        const kind = action === 'send_group_msg' || (action === 'send_msg' && params.message_type === 'group') ? 'group' : 'private';
        if (action === 'send_msg' && !['group', 'private'].includes(params.message_type)) fail('MESSAGE_TYPE_REQUIRED');
        const target = String(params[kind === 'group' ? 'group_id' : 'user_id'] ?? '');
        if (!/^\d+$/.test(target) || !this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
        const deliveryId=params.wechatagent_delivery_id;
        if(deliveryId!==undefined&&!/^[a-f0-9]{64}$/.test(deliveryId))fail('INVALID_DELIVERY_ID');
        if(params.wechatagent_receipt_only!==undefined&&typeof params.wechatagent_receipt_only!=='boolean')fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_defer_receipt!==undefined&&typeof params.wechatagent_defer_receipt!=='boolean')fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_abandon_delivery!==undefined&&(typeof params.wechatagent_abandon_delivery!=='boolean'||params.wechatagent_abandon_delivery&&(!deliveryId||params.wechatagent_receipt_only!==true)))fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_deadline_at!==undefined&&(!Number.isSafeInteger(params.wechatagent_deadline_at)||params.wechatagent_deadline_at<0||params.wechatagent_deadline_at>Date.now()+60000))fail('INVALID_DELIVERY_DEADLINE');
        if(params.wechatagent_receipt_only===true&&(!deliveryId||!Array.isArray(params.message)||params.message.length!==1||params.message[0]?.type!=='wechat_sticker'))fail('INVALID_RECEIPT_QUERY');
        if(params.wechatagent_source!==undefined&&params.wechatagent_source!=='proactive')fail('INVALID_SEND_SOURCE');
        if(params.wechatagent_source==='proactive'&&(!deliveryId||!/^[a-f0-9]{64}$/.test(params.wechatagent_context_id??'')||
          params.wechatagent_preceding_delivery_id!==undefined&&!/^[a-f0-9]{64}$/.test(params.wechatagent_preceding_delivery_id)))fail('INVALID_PROACTIVE_CONTEXT');
        const proactive=params.wechatagent_source==='proactive'?{contextId:params.wechatagent_context_id,...(params.wechatagent_preceding_delivery_id?{precedingDeliveryId:params.wechatagent_preceding_delivery_id}:{})}:null;
        if(Array.isArray(params.message)&&params.message.length===1&&params.message[0]?.type==='wechat_sticker'){
          data=await this.sendSticker(kind,target,String(params.message[0].data?.id??''),deliveryId,proactive,params.wechatagent_receipt_only===true,params.wechatagent_defer_receipt===true,params.wechatagent_deadline_at,params.wechatagent_abandon_delivery===true);
        }else{
          const text=textSegments(params.message);
          data=await this.send(kind,target,text,deliveryId,proactive);
        }
      } else if(['get_sticker_list','get_sticker_labels','save_sticker_labels'].includes(action)){
        const kind=params.kind,target=String(params.target??'');
        if(!['group','private'].includes(kind)||!/^\d+$/.test(target))fail('INVALID_STICKER_TARGET');
        data=action==='get_sticker_list'?await this.stickerList(kind,target,params.query):await this.stickerLabels(kind,target,{operation:action==='get_sticker_labels'?'read':'save',...(action==='get_sticker_labels'?{ids:params.ids}:{labels:params.labels})});
      } else if (action === 'get_status') {
        data = { online: this.status.hook_account_verified, good: this.status.hook_account_verified && this.status.reader_connected };
      } else if (action === 'get_version_info') {
        data = { app_name: 'WeChatAgent-WeChat-Hook', app_version: '1', protocol_version: 'v11' };
      } else if (action === 'get_login_info') {
        data = { user_id: (await this.checkNative()).selfId, nickname: this.project.account.nicknames[0] };
      } else if (['get_friend_list', 'get_group_list'].includes(action)) {
        const kind = action === 'get_group_list' ? 'group' : 'private';
        const sessions = (await this.reader('/api/v1/sessions?limit=500')).sessions ?? [];
        data = sessions.filter(s => s.username && (s.username.includes('@chatroom') ? 'group' : 'private') === kind)
          .map(s => ({ id: conversationId(s.username, s.displayName, s.conversationId), name: s.displayName ?? s.username }))
          .filter(s => this.allowed(kind, s.id)).map(s => kind === 'group' ? { group_id: s.id, group_name: s.name } : { user_id: s.id, nickname: s.name, remark: s.name });
      } else fail('ACTION_UNSUPPORTED');
      return { ...response, status: 'ok', retcode: 0, data };
    } catch (error) {
      const code = error instanceof AdapterError ? error.message : error?.message==='TEXT_DELIVERY_STATE_INVALID'?'TEXT_DELIVERY_STATE_INVALID':'BACKEND_UNAVAILABLE';
      this.status.last_error = code;
      if (String(request?.action).startsWith('send_')) this.status.failed_sends++;
      return { ...response, data:error instanceof AdapterError&&error.data?error.data:{},retcode: code === 'ACTION_UNSUPPORTED' ? 1404 : 1407, message: code };
    } finally { this.activeActions--; }
  }
  incoming(payload) {
    this.reload();
    if (payload?.event !== 'message.new' || ![1,3,34,47,PAT_TYPE,49,FORWARD_TYPE,QUOTE_TYPE,25769803825,...CARD_TYPES].includes(payload.type) || typeof payload.content !== 'string' || !payload.content.trim() || !payload.sessionId || !payload.talkerId || payload.isSend || payload.talkerId === this.ownWxid) return null;

    const forwardedRecord=[49,FORWARD_TYPE].includes(payload.type)?normalizeForwardedRecord(payload.forwardedRecord):null;
    const quoteReply=[49,QUOTE_TYPE].includes(payload.type)?normalizeQuoteReply(payload.quoteReply):null;
    const sharedCard=payload.type===CARD_TYPE||CARD_TYPES.includes(payload.type)?normalizeSharedCard(payload.sharedCard):null;
    if([49,FORWARD_TYPE,QUOTE_TYPE,...CARD_TYPES].includes(payload.type) && (!forwardedRecord && !quoteReply && !sharedCard || forwardedRecord && quoteReply))return null;
    if ([3,47].includes(payload.type) && !/^[a-f0-9]{64}$/.test(payload.image?.id ?? '')) return null;
    if(payload.type===34&&(!/^[a-f0-9]{64}$/.test(payload.voice?.id??'')||!Number.isFinite(payload.voice.durationSeconds)||payload.voice.durationSeconds<=0||payload.voice.durationSeconds>60))return null;
    if(payload.type===25769803825&&(!/^[a-f0-9]{64}$/.test(payload.file?.id??'')||typeof payload.file?.name!=='string'||!Number.isSafeInteger(payload.file?.size)||payload.file.size<0||payload.file.size>50*1024*1024))return null;
    if (payload.type === PAT_TYPE && (!this.ownWxid || payload.pat?.target !== cleanAccountId(this.ownWxid) || payload.pat?.actor !== payload.talkerId || payload.pat.actor === cleanAccountId(this.ownWxid))) return null;
    const group = payload.sessionId.includes('@chatroom'), kind = group ? 'group' : 'private';
    const target = conversationId(payload.sessionId, payload.groupName, payload.conversationId);
    if (!this.allowed(kind, target)) return null;
    if(!group && payload.talkerId!==payload.sessionId)return null;
    const selfId = onebotId(this.ownWxid), userId = onebotId(group ? payload.talkerId : payload.sessionId);
    if(quoteReply){
      const ref=quoteReply.reference;
      const sameChat=group?ref.conversationId===payload.sessionId:!ref.conversationId;
      ref.senderRelation=sameChat && ref.senderId && this.ownWxid
        ? cleanAccountId(ref.senderId)===cleanAccountId(this.ownWxid)?'self':'other':'unknown';
    }
    const content=quoteReply?(quoteReply.reply||'[引用回复，正文为空]'):payload.content;
    const segments = [{ type: 'text', data: { text: content } }];
    if(payload.type===34)segments.push({type:'record',data:{file:'wechatagent://voice/'+payload.voice.id,voice_id:payload.voice.id,duration:payload.voice.durationSeconds}});
    if(payload.type===25769803825)segments.push({type:'file',data:{id:payload.file.id,name:payload.file.name,size:payload.file.size}});
    if ([3,47].includes(payload.type)) segments.push({type:'image',data:{file:'wechatagent://image/'+payload.image.id,media_id:payload.image.id,...(payload.type===47?{media_kind:'sticker'}:{})}});
    if (group && this.project.account.nicknames.some(n => content.includes('@' + n + '\u2005') || content.endsWith('@' + n))) segments.unshift({ type: 'at', data: { qq: String(selfId) } });
    return { time: payload.timestamp || Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'message',
      message_type: kind, sub_type: group ? 'normal' : 'friend', message_id: payload.rawid,
      user_id: userId, message: segments, raw_message: content,
      sender: { user_id: userId, nickname: payload.sourceName || payload.senderName || String(userId) },
      ...({wechatagent:{senderWxid:payload.talkerId,...(group?{memberId:crypto.createHash('sha256').update('wechat-member:'+payload.talkerId).digest('hex')}:{}),...(payload.type===PAT_TYPE?{interaction:'pat'}:forwardedRecord?{forwardedRecord}:quoteReply?{quoteReply}:sharedCard?{sharedCard}:{})}}),
      ...(group ? { group_id: target, group_name: payload.groupName || String(target) } : {}) };
  }
  enqueue(payload) {
    const event = this.incoming(payload);
    if (!event || !event.message_id || this.seen.has(event.message_id)) return;
    if (this.pending.length >= 200) fail('EVENT_QUEUE_FULL');
    this.pending.push(event); this.seen.set(event.message_id, true);
    while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    this.status.received++; this.flush();
  }
  flush() {
    while (this.socket?.readyState === WebSocket.OPEN && this.pending.length) {
      const event = this.pending[0];
      // Recheck removed whitelist entries before forwarding buffered events.
      this.reload();
      if (this.allowed(event.message_type, event.message_type === 'group' ? event.group_id : event.user_id)) {
        try { this.socket.send(JSON.stringify(event)); } catch { return; }
      }
      this.pending.shift();
    }
  }
  async connectOneBot() {
    while (!this.stopped) {
      const socket = new WebSocket(this.api.onebot_ws_url);
      this.socket = socket;
      await new Promise(resolve => {
        const connectTimer = setTimeout(() => socket.close(), 8000);
        socket.addEventListener('open', () => {
          clearTimeout(connectTimer); this.status.ob_connected = true;
          socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: onebotId(this.ownWxid), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
          try { this.flush(); } catch { this.status.last_error = 'CONFIG_INVALID'; }
        });
        socket.addEventListener('message', async event => {
          let request;
          try { request = JSON.parse(String(event.data)); } catch { return; }
          if (!request || typeof request !== 'object' || Array.isArray(request)) return;
          const response = await this.action(request);
          if (socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify(response)); } catch {} }
        });
        socket.addEventListener('error', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
      });
      socket.close(); this.status.ob_connected = false;
      if (!this.stopped) await sleep(1500);
    }
  }
  async receiveSse() {
    while (!this.stopped) {
      const controller = new AbortController(); this.controllers.add(controller);
      let watchdog = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await this.fetch(this.api.reader_base_url + '/api/v1/push/messages', {
          headers: { Authorization: 'Bearer ' + this.api.reader_token }, signal: controller.signal, redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) fail('READER_STREAM_UNAVAILABLE');
        this.status.reader_connected = true;
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 35000);
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 256000) fail('READER_EVENT_TOO_LARGE');
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).trimEnd(); buffer = buffer.slice(at + 1);
            if (line.startsWith('data:')) this.enqueue(JSON.parse(line.slice(5)));
          }
          if (this.stopped) break;
        }
      } catch { if (!this.stopped) this.status.last_error = 'READER_STREAM_UNAVAILABLE'; }
      finally { clearTimeout(watchdog); controller.abort(); this.controllers.delete(controller); this.status.reader_connected = false; }
      if (!this.stopped) await sleep(1500);
    }
  }
  async start() {
    await this.checkNative();
    this.server = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(this.status));
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>WeChatAgent</title><h1>WeChatAgent · WeChat-Hook</h1><p>OneBot v11 · 后台文字发送</p><pre id="status">加载中</pre><script>async function update(){try{document.getElementById("status").textContent=JSON.stringify(await(await fetch("/status")).json(),null,2)}catch{document.getElementById("status").textContent="状态服务未连接"}}update();setInterval(update,2000)</script>');
      } else { res.writeHead(404); res.end(); }
    });
    this.startupStage='adapter-port-bind';
    try{await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.project.ports.adapter, '127.0.0.1', resolve); });}
    catch(error){const code=systemErrorCode(error);throw startupError(code==='EADDRINUSE'?'ADAPTER_PORT_IN_USE':['EACCES','EPERM'].includes(code)?'ADAPTER_PORT_DENIED':'ADAPTER_LISTEN_FAILED',error,'adapter-port-bind',this.project.ports.adapter);}
    this.status.ready=true;
    this.tasks = [this.connectOneBot(), this.receiveSse()];
    this.fileTimer=setInterval(()=>{try{this.fileWorker.tick();}catch{}},1000);this.fileTimer.unref();
    let checking = false;
    this.healthTimer = setInterval(async () => {
      if (checking || this.stopped) return;
      checking = true;
      try { await this.checkNative(); }
      catch (error) { this.status.last_error = error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE'; }
      finally { checking = false; }
    }, 5000);
    console.log('WeChat-Hook OneBot v11 adapter ready; native account/version verified.');
  }
  async stop() {
    this.stopped = true;this.status.ready=false; for (const controller of this.controllers) controller.abort();
    clearInterval(this.healthTimer);clearInterval(this.fileTimer);this.fileWorker.stop();
    this.socket?.close();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await Promise.allSettled(this.tasks ?? []);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let adapter;
  try {
    adapter = new HookOneBot();
    if (process.argv.includes('--check')) {
      await adapter.waitForNative({onWaiting:()=>console.log('WeChat-Hook: waiting for the matching client initialization...')}); console.log('WeChat-Hook: matching version and selected account database verified.');
    } else {
      await adapter.start();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await adapter.stop(); process.exit(0); });
    }
  } catch (error) { console.error(adapterStartupMessage(error,{checkOnly:process.argv.includes('--check'),stage:adapter?.startupStage,port:adapter?.project?.ports?.adapter})); process.exitCode = 1; }
}
