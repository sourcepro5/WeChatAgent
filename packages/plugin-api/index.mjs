import fs from 'node:fs';
import path from 'node:path';
import {PluginProcess} from './process.mjs';
import {configuration,scanPlugins,allowedChat,validateValue,atomicJson,directory,hash,json,fail} from './catalog.mjs';
import {safeFetch} from '../../components/qq-bridge/src/safe-fetch.js';
import {PluginDocuments} from './documents.mjs';
import {createAudioReader} from './audio.mjs';
import {boundedTask} from '../dsh-social-bridge-plugin/deadline.mjs';
import {FEATURE_ENTRIES} from './contract.mjs';
export {createPluginModelUtility} from './model-utility.mjs';
export const TOOL_POLICY=Symbol.for('wechatagent.extension-tools.v1');

const text=value=>String(value??'').slice(0,12000);
export class PluginRuntime{
  constructor({root,accountScope='unbound',isAllowed=()=>true,historyFor=()=>[],rowsForDate=()=>[],personaFor=()=>{throw fail('PLUGIN_PERSONA_UNAVAILABLE');},generateText,readAudio,isBusy=()=>false,canSchedule=()=>true,now=Date.now,log=()=>{},fetchText=safeFetch,toolTimeoutMs=8000}){
    this.root=path.resolve(root);this.accountScope=hash(accountScope);this.isAllowed=isAllowed;this.historyFor=historyFor;this.log=log;this.fetchText=fetchText;
    this.records=new Map();this.dirty=true;this.revision='';this.closed=false;
    this.readAudio=readAudio??createAudioReader(root);
    this.accountBound=accountScope!=='unbound'&&!!accountScope;this.accountId=/^[a-f0-9]{64}$/.test(accountScope)?accountScope:hash(accountScope);Object.assign(this,{rowsForDate,personaFor,generateText,isBusy,canSchedule,now});this.utilityCalls=0;this.scheduleRetry=new Map();
    this.toolTimeoutMs=Math.max(20,Math.min(8000,toolTimeoutMs));
    const base=directory(root,'plugins');try{this.watcher=fs.watch(base,{recursive:true},()=>{this.dirty=true;});this.watcher.on('error',()=>{this.dirty=true;});this.watcher.unref();}catch{}
  }
  policy(){return configuration(this.root);}
  active(record,key,permission){
    try{
      const saved=this.policy().config.plugins[record.id];
      return !this.closed&&this.isAllowed()&&(!record.requiresAccount||this.accountBound)&&!!saved?.enabled&&saved.generation===record.generation&&!record.invalid&&!record.failure&&!record.process?.closed&&!!record.process&&record.permissions.every(p=>saved.permissions?.includes(p))
        &&(!permission||record.permissions.includes(permission)&&saved.permissions.includes(permission))&&(!key||allowedChat(this.root,key)&&(saved.chats===null||saved.chats?.includes(key)));
    }catch{return false;}
  }
  isActive(id,key){const record=this.records.get(id);return !!record&&this.active(record,key);}
  async sync(){
    if(this.closed)return;
    if(this.syncing)return this.syncing;
    this.syncing=this.reconcile().finally(()=>{this.syncing=null;});return this.syncing;
  }
  async reconcile(){
    const saved=this.policy(),changed=saved.revision!==this.revision;
    if(!this.dirty&&!changed)return;
    const catalog=this.dirty||changed||!this.catalog?scanPlugins(this.root):this.catalog;this.catalog=catalog;this.dirty=false;this.revision=saved.revision;
    for(const [id,record]of this.records){
      const next=catalog.find(item=>item.id===id),setting=saved.config.plugins[id];
      if(!next||next.revision!==record.revision||record.generation!==setting?.generation||!setting?.enabled){await record.process?.dispose();this.records.delete(id);}
    }
    const deadline=Date.now()+6000;let started=[...this.records.values()].filter(item=>item.process&&!item.process.closed).length;
    for(const item of catalog){
      if(this.closed)break;
      const setting=saved.config.plugins[item.id];if(this.records.has(item.id))continue;
      const record={...item,generation:setting?.generation};this.records.set(item.id,record);
      if(item.invalid||!setting?.enabled||item.requiresAccount&&!this.accountBound||item.permissions.some(p=>!setting.permissions?.includes(p)))continue;
      if(started>=8||Date.now()>=deadline){record.failure='启用的插件过多或加载超时，请停用部分插件后重新保存。';continue;}
      started++;
      try{
        const worker=new PluginProcess(item,{onFailure:reason=>{if(reason!=='PLUGIN_DISABLED'){record.failure=reason;this.log(`[plugin:${item.id}] ${reason}`);}}});
        record.process=worker;await worker.start(Math.max(1,Math.min(2000,deadline-Date.now())));
      }catch(error){record.failure=error.message;}
    }
  }
  list(){
    return [...this.records.values()].map(record=>({id:record.id,actions:record.process?.actions??[],loaded:!!record.process&&!record.process.closed,active:this.active(record),reason:record.invalid?record.reason:record.failure??(!this.policy().config.plugins[record.id]?.enabled?'已关闭':record.requiresAccount&&!this.accountBound?'请先绑定微信账号':!this.active(record)?'权限未授予或等待加载':'已生效')}));
  }
  toolDefinitions(key){if(typeof key!=='string'||!/^wechat:(private|group):[1-9]\d*$/.test(key))return [];return [...this.records.values()].filter(record=>this.active(record,key)).flatMap(record=>(record.process.tools??[]).map(tool=>({...tool,name:record.id+'__'+tool.id,pluginId:record.id})));}
  bindingRevision(key){return this.toolDefinitions(key).map(tool=>tool.name+':'+this.records.get(tool.pluginId).revision+':'+this.records.get(tool.pluginId).generation).join('|');}
  instructions(){return '';}
  context(record,turn){return {chat:{key:turn.conversationKey,platform:'wechat',kind:turn.conversationKey.split(':')[1],id:turn.conversationKey.split(':')[2],name:turn.conversationName??turn.conversationKey},account:{id:this.accountId},now:this.now(),actor:{id:turn.actorId??''},sessionId:turn.sessionId??'',settings:structuredClone({...record.settings,...this.policy().config.plugins[record.id]?.settings})};}
  service(record,turn,signal,readOnly=false){
    const check=permission=>{if(signal.aborted||!this.active(record,turn.conversationKey,permission))throw fail('PLUGIN_PERMISSION_DENIED');};
    return async(method,args)=>{
      const limit=method.startsWith('documents.')?1100000:method==='model.generate'?128*1024:64*1024;
      if(!Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>limit)throw fail('PLUGIN_SERVICE_ARGUMENT_INVALID');
      if(method==='audio.read'){
        check('audio_read');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        const [id,options]=args;
        if(!this.accountBound||!turn.voiceIds?.includes(id)||!options||Object.keys(options).some(key=>key!=='format')||!['wav','silk'].includes(options.format??'wav'))throw fail('VOICE_REFERENCE_NOT_ALLOWED');
        const result=await this.readAudio(id,turn.conversationKey,record.id,{...options,signal});
        check('audio_read');return result;
      }
      if(method.startsWith('documents.')){
        check('documents');const documents=new PluginDocuments(this.root,this.accountScope,this.accountId,record);
        if(method==='documents.get')return documents.get(turn.conversationKey,args[0]);
        if(method==='documents.list')return documents.list(turn.conversationKey,args[0]);
        if(method==='documents.put'){if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');check('documents');return documents.put(turn.conversationKey,args[0],args[1]);}
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      if(method==='persona'){check('persona_read');const persona=this.personaFor(turn.conversationKey),name=String(persona.personaName??'').slice(0,80),body=String(persona.persona??'');return {personaName:name,persona:body.slice(0,8000),digest:hash(body),signature:hash(name+'\0'+body)};}
      if(method==='history.today'){
        check('history_read');const {date,limit=200,maxChars=14000,...extra}=args[0]??{};
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()),get=name=>parts.find(part=>part.type===name).value,current=get('year')+'-'+get('month')+'-'+get('day');
        if(Object.keys(extra).length||date!==current||!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(maxChars)||maxChars<1||maxChars>14000)throw fail('PLUGIN_HISTORY_DAY_INVALID');
        const rows=await this.rowsForDate(turn.conversationKey,date);check('history_read');const selected=[];let chars=0;
        for(const row of rows.slice(-limit)){if(row.forwardedRecord||row.quoteReply||row.outgoing&&row.delivery_status!=='confirmed')continue;const body=String(row.text??'').slice(0,400);if(!body.trim())continue;if(chars+body.length>maxChars)break;chars+=body.length;selected.push({who:String(row.who??row.sender_name??'群友').slice(0,100),text:body});}
        return selected;
      }
      if(method==='model.generate'){
        check('model_generate');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(!this.generateText)throw fail('PLUGIN_MODEL_UNAVAILABLE');if(this.utilityCalls>=2||(turn.modelCalls=(turn.modelCalls??0)+1)>3)throw fail('PLUGIN_MODEL_BUSY');
        const options=args[0];if(!options||Object.keys(options).some(key=>!['prompt','maxTokens','maxChars','timeoutMs'].includes(key)))throw fail('PLUGIN_MODEL_OPTIONS_INVALID');
        if(typeof options.prompt!=='string'||!options.prompt.trim()||options.prompt.length>32000||[['maxTokens',16,2200],['maxChars',1,4000],['timeoutMs',1000,25000]].some(([key,min,max])=>options[key]!==undefined&&(!Number.isInteger(options[key])||options[key]<min||options[key]>max)))throw fail('PLUGIN_MODEL_OPTIONS_INVALID');
        this.utilityCalls++;try{const value=await boundedTask(()=>this.generateText({...options,pluginId:record.id,key:turn.conversationKey,signal,allowed:()=>!signal.aborted&&this.active(record,turn.conversationKey,'model_generate')}),{signal,timeoutMs:options.timeoutMs??25000});check('model_generate');return value;}finally{this.utilityCalls--;}
      }
      if(method.startsWith('storage.')){
        check('storage');const [scope,key,value]=args;
        if(!['chat','actor'].includes(scope)||typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(key)||scope==='actor'&&!turn.actorId)throw fail('PLUGIN_STORAGE_KEY_INVALID');
        const file=path.join(directory(this.root,'state/plugins/'+this.accountScope+'/'+record.id),'data.json'),data=fs.existsSync(file)?json(file):{};
        const storeKey=hash(turn.conversationKey+'\0'+(scope==='actor'?turn.actorId:'chat'))+'|'+key;
        if(method==='storage.get')return structuredClone(data[storeKey]??null);
        if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        if(method==='storage.set')data[storeKey]=structuredClone(value);else if(method==='storage.delete')delete data[storeKey];else throw fail('PLUGIN_SERVICE_UNAVAILABLE');
        if(Buffer.byteLength(JSON.stringify(data))>256*1024)throw fail('PLUGIN_STORAGE_LIMIT');
        check('storage');atomicJson(file,data);return {ok:true};
      }
      if(method==='history.recent'){
        check('history_read');const {limit=20,...extra}=args[0]??{};if(Object.keys(extra).length||!Number.isInteger(limit)||limit<1||limit>100)throw fail('PLUGIN_HISTORY_LIMIT');
        const rows=[];let bytes=0;
        for(const row of this.historyFor(turn.conversationKey,limit).slice(-limit).reverse()){
          const item={id:String(row.id??'').slice(0,200),text:text(row.text),senderId:String(row.sender_wxid??row.sender_id??'').slice(0,200),senderName:String(row.sender_name??'').slice(0,100),timestamp:row.timestamp,outgoing:!!row.outgoing};
          const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>48*1024)break;bytes+=size;rows.unshift(item);
        }
        return rows;
      }
      if(method==='reply'){
        check('reply');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.replyDisabled)throw fail('PLUGIN_ACTION_REPLY_UNAVAILABLE');if(typeof args[0]!=='string'||!args[0].trim()||turn.replies.reduce((sum,item)=>sum+item.text.length+1,0)+args[0].length>12000||turn.replies.length>=3)throw fail('PLUGIN_REPLY_LIMIT');
        turn.replies.push({id:record.id,text:args[0].trim()});return {queued:true};
      }
      if(method==='fetch'){
        check('web_fetch');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.networkOptOut)throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');
        const [url,options]=args;if(typeof url!=='string'||!options||Object.keys(options).some(key=>!['maxChars','timeoutMs'].includes(key)))throw fail('PLUGIN_FETCH_OPTIONS_INVALID');
        const {maxChars=12000,timeoutMs=6000}=options;
        if(!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>32000||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>7000)throw fail('PLUGIN_FETCH_OPTIONS_INVALID');
        const response=await this.fetchText(url,maxChars,{signal,timeoutMs});check('web_fetch');
        return {status:response.statusCode??200,body:response.body??response.text??'',headers:{'X-WeChatAgent-Truncated':response.truncated?'true':'false'}};
      }
      throw fail('PLUGIN_SERVICE_UNAVAILABLE');
    };
  }
  async execute(name,args,turn,signal){
    const tool=this.toolDefinitions(turn.conversationKey).find(tool=>tool.name===name);if(!tool)throw fail('PLUGIN_TOOL_UNAVAILABLE');
    validateValue(args,tool.parameters);if(++turn.toolCalls>3)throw fail('PLUGIN_TOOL_LIMIT');
    const record=this.records.get(tool.pluginId),controller=new AbortController(),before=turn.replies.length;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      const result=await record.process.call('tool',tool.id,structuredClone(args),this.context(record,turn),this.service(record,turn,controller.signal),{signal:controller.signal,timeoutMs:this.toolTimeoutMs});
      if(!this.active(record,turn.conversationKey))throw fail('PLUGIN_TOOL_UNAVAILABLE');
      if(result?.isError)turn.replies.splice(before);
      return {content:text(typeof result==='string'?result:result?.content??JSON.stringify(result)),isError:result?.isError===true};
    }catch(error){turn.replies.splice(before);throw error;}
    finally{controller.abort();signal?.removeEventListener('abort',abort);}
  }
  async hooks(name,value,turn,signal){
    const results=[],deadline=Date.now()+2000;
    for(const record of this.records.values()){
      if(!this.active(record,turn.conversationKey)||!record.process.hooks?.includes(name))continue;
      const timeoutMs=Math.min(800,deadline-Date.now());if(timeoutMs<=0)break;
      const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      try{const result=await record.process.call('hook',name,value,this.context(record,turn),this.service(record,turn,controller.signal,true),{signal:controller.signal,timeoutMs});
        if(name==='after-response'&&result?.text!==undefined&&!this.active(record,turn.conversationKey,'reply'))delete result.text;
        results.push(result);
      }
      catch(error){this.log(`[plugin:${record.id}] hook ${name}: ${error.message}`);}
      finally{controller.abort();signal?.removeEventListener('abort',abort);}
    }
    return results;
  }
  async invokeAction(id,name,args,turn,{signal,timeoutMs=35000,requireReply=false}={}){
    if(!allowedChat(this.root,turn.conversationKey))throw fail('PLUGIN_CHAT_UNAVAILABLE');await this.sync();const record=this.records.get(id);
    if(!record||!this.active(record,turn.conversationKey))return {handled:false};
    const action=record.process.actions.find(action=>action.id===name);if(!action)throw fail('PLUGIN_ACTION_UNAVAILABLE');validateValue(args,action.parameters);
    return this.invoke(record,'action',name,args,turn,{signal,timeoutMs,requireReply});
  }
  // FEATURE_ENTRIES routing: active plugins for this chat that declare the
  // feature, hold its permission and register its action.
  featureHandlers(feature,key){
    const entry=FEATURE_ENTRIES[feature];if(!entry)return [];
    return [...this.records.values()].filter(record=>this.active(record,key,entry.permission)&&record.requiresHostFeatures?.includes(feature)&&record.process.actions?.some(action=>action.id===entry.action)).sort((a,b)=>a.id.localeCompare(b.id));
  }
  async invokeFeature(feature,args,turn,options={}){
    const entry=FEATURE_ENTRIES[feature];if(!entry)throw fail('PLUGIN_FEATURE_UNAVAILABLE');
    if(!allowedChat(this.root,turn.conversationKey))throw fail('PLUGIN_CHAT_UNAVAILABLE');await this.sync();
    const handlers=this.featureHandlers(feature,turn.conversationKey);
    if(!handlers.length)return {handled:false};
    // Two handlers for one chat is a configuration conflict; never pick one silently.
    if(handlers.length>1)throw Object.assign(fail('PLUGIN_FEATURE_CONFLICT'),{plugins:handlers.map(record=>record.id)});
    const [record]=handlers,action=record.process.actions.find(action=>action.id===entry.action);validateValue(args,action.parameters);
    const result=await this.invoke(record,'action',action.id,args,turn,options);
    if(!this.active(record,turn.conversationKey,entry.permission))throw fail('PLUGIN_PERMISSION_DENIED');
    return {handled:true,plugin:record.id,generation:record.generation,result};
  }
  async invoke(record,kind,name,args,turn,{signal,timeoutMs=35000,requireReply=false}={}){
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const scoped={...turn,replies:[],toolCalls:0,modelCalls:0,replyDisabled:true};
    try{const result=await record.process.call(kind,name,args,this.context(record,scoped),this.service(record,scoped,controller.signal),{signal:controller.signal,timeoutMs:Math.min(35000,timeoutMs)});
      if(!this.active(record,turn.conversationKey)||requireReply&&!this.active(record,turn.conversationKey,'reply'))throw fail('PLUGIN_PERMISSION_DENIED');return result;
    }finally{controller.abort();signal?.removeEventListener('abort',abort);}
  }
  async tick(){
    if(this.closed||this.ticking||!this.isAllowed()||!this.canSchedule()||this.isBusy())return;this.ticking=true;
    try{await this.sync();const settings=json(path.join(this.root,'config/wechatagent.json')),parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(this.now()),value=name=>parts.find(part=>part.type===name).value,date=value('year')+'-'+value('month')+'-'+value('day'),time=value('hour')+':'+value('minute');
      for(const record of this.records.values()){
        if(!record.schedule||!record.process?.scheduled||!this.active(record,undefined,'schedule'))continue;
        const local=this.policy().config.plugins[record.id],at=local.settings?.[record.schedule.timeSetting]??record.settings[record.schedule.timeSetting];if(time<at)continue;
        const folder=directory(this.root,'state/plugin-schedules/'+this.accountScope),file=path.join(folder,record.id+'.json');
        if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>512*1024))throw fail('PLUGIN_SCHEDULE_STATE_INVALID');
        const receipts=fs.existsSync(file)?json(file):{};
        const keys=['private','groups'].flatMap(kind=>(settings.wechat?.whitelist?.[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group':'private')+':'+id));
        for(const key of keys){const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()),get=name=>day.find(part=>part.type===name).value;if(get('year')+'-'+get('month')+'-'+get('day')!==date)return;if(!this.active(record,key,'schedule')||this.isBusy(key))continue;let identity=date;if(record.schedule.personaScoped){const persona=this.personaFor(key);identity+=':'+hash(persona.personaName+'\0'+persona.persona);}if(receipts[key]===identity||(this.scheduleRetry.get(record.id+'|'+key)??0)>this.now())continue;
          try{const result=await this.invoke(record,'schedule','daily',{date},{conversationKey:key},{timeoutMs:35000});if(!result?.retryLater){receipts[key]=identity;atomicJson(file,receipts);}}
          catch(error){this.scheduleRetry.set(record.id+'|'+key,this.now()+15*60000);this.log(`[plugin:${record.id}] schedule: ${error.message}`);}
        }
      }
    }finally{this.ticking=false;}
  }
  start(){if(!this.closed&&!this.timer){this.timer=setInterval(()=>{void this.tick().catch(error=>this.log('plugin scheduler: '+error.message));},60000);this.timer.unref?.();}}
  async dispose(){this.closed=true;clearInterval(this.timer);this.watcher?.close();await Promise.allSettled([...this.records.values()].map(record=>record.process?.dispose()));await this.syncing?.catch(()=>{});this.records.clear();}
}

export function bindAgentTools(agentCtx,runtime,key,turnFor){
  const disposers=[];
  const policy={names:()=>new Set(runtime.toolDefinitions(key).map(tool=>tool.name)),check:name=>!!turnFor()&&runtime.toolDefinitions(key).some(tool=>tool.name===name),definitions:()=>runtime.toolDefinitions(key)};
  try{Object.defineProperty(agentCtx,TOOL_POLICY,{value:policy,configurable:true});}
  catch{runtime.log('plugin tool policy could not be bound; continuing without plugin tools');return()=>{};}
  const groups=new Map();for(const tool of runtime.toolDefinitions(key)){if(!groups.has(tool.pluginId))groups.set(tool.pluginId,[]);groups.get(tool.pluginId).push(tool);}
  for(const [id,tools]of groups){
    const own=[];
    try{
      for(const tool of tools)own.push(agentCtx.tools.register({name:tool.name,description:tool.description,parameters:tool.parameters,
        output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,result)=>[{type:'text',text:result.content}]},
        async execute(args,execution){const turn=turnFor();if(!turn)throw fail('PLUGIN_TURN_UNAVAILABLE');const result=await runtime.execute(tool.name,args,turn,execution?.signal);if(result.isError)throw fail(result.content);return result;},
      }));
      disposers.push(...own);
    }catch{
      for(const dispose of own)if(typeof dispose==='function')dispose();
      const record=runtime.records.get(id);if(record){record.failure='PLUGIN_TOOL_REGISTRATION_CONFLICT';record.process?.dispose().catch(()=>{});}
      runtime.log(`[plugin:${id}] PLUGIN_TOOL_REGISTRATION_CONFLICT`);
    }
  }
  return()=>{for(const dispose of disposers)if(typeof dispose==='function')dispose();if(agentCtx[TOOL_POLICY]===policy)delete agentCtx[TOOL_POLICY];};
}
