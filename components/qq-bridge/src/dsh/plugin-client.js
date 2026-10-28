import {formatAssistantTask} from '../../../../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import {MAX_RPC_BYTES} from '../../../../packages/dsh-social-bridge-plugin/local-policy.mjs';

export class DshPluginClient {
  constructor({ url = 'http://127.0.0.1:11230', token = process.env.SOCIAL_DSH_TOKEN, timeoutMs = 125000, feedback } = {}, log = () => {}) {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
      throw new Error('DSH plugin URL must be loopback HTTP');
    }
    if (!token) throw new Error('SOCIAL_DSH_TOKEN is required');
    this.feedback=feedback;this.url = parsed.origin; this.token = token; this.timeoutMs = timeoutMs; this.log = log;
  }

  async connectionHealth({projectRoot,accountScope}={}){
    const response=await fetch(this.url+'/health',{headers:{authorization:'Bearer '+this.token},signal:AbortSignal.timeout(10000)});
    const health=await response.json();
    const sameRoot=!projectRoot||typeof health.projectRoot==='string'&&path.resolve(health.projectRoot).toLowerCase()===path.resolve(projectRoot).toLowerCase();
    return {ready:response.ok&&health.ok===true&&health.project==='WeChatAgent'&&health.contextMode==='native-session-v1'&&sameRoot&&(!accountScope||health.accountScope===accountScope),instanceId:health.instanceId,startedAt:health.instanceStartedAt};
  }

  async searchReady(){
    if(this.searchHealthAt && Date.now()-this.searchHealthAt<3000)return this.searchSupported;
    try{const response=await fetch(this.url+'/health',{headers:{authorization:'Bearer '+this.token},signal:AbortSignal.timeout(2000)});
      const health=await response.json();
      this.searchSupported=response.ok&&health.searchBudget==='per-turn-count-v1'&&health.searchReasoning==='model-default-v1';
      this.controllerSupported=response.ok&&health.assistantController==='durable-wechat-tasks-v1';
      this.modelSearchSupported=response.ok&&health.ok===true&&health.searchTool==='model-search-v1'&&health.searchRoute==='dsh-native-only-v1';
    }catch{this.searchSupported=false;this.modelSearchSupported=false;}
    this.searchHealthAt=Date.now();return this.searchSupported;
  }

  async modelSearchReady(){await this.searchReady();return this.modelSearchSupported===true;}

  async recognizeVoice(conversationKey,voice,senderWxid,{signal}={}){
    const response=await fetch(this.url+'/voice-input',{method:'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},
      body:JSON.stringify({conversationKey,id:voice.id,senderWxid}),signal:AbortSignal.any([AbortSignal.timeout(34000),...(signal?[signal]:[])])});
    const body=await response.json();
    if(!response.ok)return {ok:false,code:/^VOICE_[A-Z0-9_]+$/.test(body.code??'')?body.code:'VOICE_INPUT_UNAVAILABLE'};
    return body;
  }

  async followup(conversationKey, message, metadata = {}, {busyRetries=0}={}) {
    // The server reads the owner's persona locally. Send only its digest to
    // detect stale settings without duplicating up to 60 KB in every RPC.
    const {persona,...requestMetadata}=metadata;
    if(persona!==undefined&&typeof persona!=='string')throw Object.assign(Error('DSH plugin: invalid_persona'),{admitted:false});
    const requestBody=JSON.stringify({...requestMetadata,...(persona===undefined?{}:{personaDigest:crypto.createHash('sha256').update(persona).digest('hex')}),conversationKey,message});
    if(Buffer.byteLength(requestBody,'utf8')>MAX_RPC_BYTES)throw Object.assign(Error('DSH plugin: request_too_large (REQUEST_TOO_LARGE)'),{code:'REQUEST_TOO_LARGE',admitted:false,limitBytes:MAX_RPC_BYTES});
    if(metadata.fishNotebookRequest){
      try{const question=await fetch(this.url+'/fish-notebook/ask',{method:'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:requestBody,signal:AbortSignal.timeout(45000)});if(question.status!==404){const result=await question.json();if(!question.ok)return 'RESPOND: 小本本这页暂时没有整理好，稍后再来看看吧。';if(result.handled){metadata.fishNotebookDocument=result.document===true;return String(result.text);}}}
      catch{return 'RESPOND: 小本本这页还在整理，稍后再来看看吧。';}
    }
    const chatOnly=metadata.workMode==='assistant'&&metadata.assistantChatOnly===true;
    const remoteAssistant=metadata.workMode==='assistant'&&!chatOnly&&await this.controllerReady();
    const response = remoteAssistant ? await this.assistantFollowup(requestBody,metadata) : await fetch(`${this.url}/${chatOnly?'assistant-chat':'followup'}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: requestBody, signal: AbortSignal.timeout((metadata.workMode==='assistant'&&!chatOnly?Math.max(this.timeoutMs,605000):this.timeoutMs) + (metadata.images?.length ? 80000 : 0)),
    });
    const body = await response.json();
    if(!response.ok&&body.error==='agent_unavailable'&&body.detail==='session_busy'&&busyRetries>0){
      await new Promise(resolve=>setTimeout(resolve,100));return this.followup(conversationKey,message,metadata,{busyRetries:busyRetries-1});
    }
    const rejectedVision=!response.ok&&metadata.images?.length&&(body.error==='turn_failed'&&body.code==='INVALID_REQUEST'||body.error==='agent_unavailable'&&body.detail==='agent_timeout');
    if ((!response.ok && body.error === 'agent_unavailable' && body.detail === 'IMAGE_READER_NOT_READY'||rejectedVision) && metadata.images?.length) {
      // Before-admission read failures and explicitly failed/cancelled vision
      // turns can degrade once. A busy cancellation gets a bounded grace period.
      const reason = rejectedVision?'IMAGE_MODEL_REQUEST_FAILED':typeof body.imageError === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(body.imageError) ? body.imageError : 'IMAGE_READER_NOT_READY';
      this.log(`[Social] ${conversationKey} attachment_unavailable count=${metadata.images.length} reason=${reason}; continuing with text`);
      const notice = '\n附件状态：本批图片附件读取失败，本轮没有提供图片。不得猜测或声称看到图片内容；可回应其他文字，图片问题请明确说明未能读取。';
      if (message.length + notice.length > 18000) throw new Error('IMAGE_FALLBACK_MESSAGE_TOO_LARGE');
      const fallbackMetadata={...metadata,images:[],...(metadata.batchId?{batchId:crypto.createHash('sha256').update(metadata.batchId+'\0without-images-v1').digest('hex')}:{})};
      if(rejectedVision){delete fallbackMetadata.searchTicket;delete fallbackMetadata.searchContext;fallbackMetadata.searchOptOut=true;fallbackMetadata.memeLibraryDisabled=true;}
      const output=await this.followup(conversationKey,message.replace(/\n<sticker_label_request>[\s\S]*?<\/sticker_label_request>/g,'')+notice,fallbackMetadata,{busyRetries:rejectedVision?10:0});
      return output.split(/STICKER_LABELS:/)[0].trim();
    }
    if (!response.ok || body.error) {
      const budgetCode=typeof body.detail==='string'?/\bSEARCH_(?:TICKET_SPENT|MODEL_REQUEST_LIMIT|BUDGET_DENIED)\b/.exec(body.detail)?.[0]:null;
      const detail = budgetCode?` (${budgetCode})`:typeof body.detail === 'string' && /^[a-zA-Z_]{3,100}$/.test(body.detail) ? ` (${body.detail})` : '';
      throw Object.assign(new Error(`DSH plugin: ${body.error ?? response.status}${detail}`),{admitted:body.admitted===true});
    }
    if(Array.isArray(body.memeChoices))metadata.memeChoices=body.memeChoices.filter(item=>item?.source==='dsh-meme'&&/^[a-f0-9]{64}$/.test(item.id??'')&&typeof item.description==='string'&&item.description.length<=120&&Array.isArray(item.tags)&&item.tags.length<=6&&item.tags.every(tag=>typeof tag==='string'&&tag.length<=16)).slice(0,1);
    return String(body.text ?? '');
  }

  async controllerReady(){await this.searchReady();return this.controllerSupported===true;}

  async assistantFollowup(requestBody,metadata){
    const request=JSON.parse(requestBody),body={...request,senderWxid:request.assistantSender};
    let result=await this.assistantTask(body.conversationKey,'submit',body),job=result.task,lastState='',lastNotice=0;
    const deadline=Date.now()+125*60000;let feedbackWarned=false;
    const notify=async task=>{try{await this.feedback?.notify(task,metadata.onTaskUpdate);}catch(error){if(!feedbackWarned){this.log('[Assistant] feedback_unavailable; task execution continues');feedbackWarned=true;}if(['waiting_approval','waiting_input'].includes(task.state)&&metadata.onTaskUpdate)await Promise.resolve(metadata.onTaskUpdate(task,formatAssistantTask(task))).catch(()=>{});}};
    while(job&&['queued','running','waiting_approval','waiting_input','cancelling'].includes(job.state)){
      const stamp=job.state+'|'+(job.approval?.id??job.question?.id??'');
      if(this.feedback)await notify(job);
      else if(stamp!==lastState||Date.now()-lastNotice>=60000){
        if(metadata.onTaskUpdate)await Promise.resolve(metadata.onTaskUpdate(job,formatAssistantTask(job))).catch(()=>{});
        lastState=stamp;lastNotice=Date.now();
      }
      if(Date.now()>deadline)throw Object.assign(Error('ASSISTANT_RESULT_WAIT_EXPIRED'),{admitted:false});
      await new Promise(resolve=>setTimeout(resolve,this.taskPollMs??1000));
      result=await this.assistantTask(body.conversationKey,'result',{senderWxid:body.senderWxid,taskId:job.id});job=result.task;
    }
    if(!job)throw Error('ASSISTANT_TASK_NOT_FOUND');
    if(job.state==='completed'&&!job.output)job=(await this.assistantTask(body.conversationKey,'result',{senderWxid:body.senderWxid,taskId:job.id})).task;
    if(this.feedback)await notify(job);
    if(job.state==='completed')return new Response(JSON.stringify(job.output??{text:'RESPOND: 任务已完成。'}),{status:200});
    // Native vision failures still use the existing one-time text recovery.
    if(job.output?.error&&metadata.images?.length&&(job.output.code==='INVALID_REQUEST'||['IMAGE_READER_NOT_READY','agent_timeout'].includes(job.output.detail)))return new Response(JSON.stringify(job.output),{status:502});
    return new Response(JSON.stringify({text:'RESPOND: '+formatAssistantTask(job)+'\n可发送“继续任务 '+job.id+' 补充要求”继续处理。'}),{status:200});
  }

  async assistantTask(conversationKey,action,options={}){
    if(!/^[a-z-]{2,30}$/.test(action))throw Error('ASSISTANT_INVALID_ACTION');
    const response=await fetch(this.url+'/assistant-task/'+action,{method:'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify({...options,conversationKey}),signal:AbortSignal.timeout(action==='workspace-confirm'?25000:5000)});
    const body=await response.json();if(!response.ok)throw Object.assign(Error(body.error??'ASSISTANT_TASK_UNAVAILABLE'),{code:body.error,status:response.status});return body;
  }

  async maintainContext(conversationKey, bufferVersion) {
    const health = await fetch(this.url + '/health', { headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(2000) }).then(r => r.json());
    if (health.contextMaintenance !== 'idle-threshold-v1') throw Object.assign(Error('CONTEXT_PLUGIN_NOT_READY'), { code: 'CONTEXT_PLUGIN_NOT_READY' });
    const response = await fetch(this.url + '/context-maintenance', {
      method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationKey, bufferVersion }), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(Error('Context maintenance unavailable'), { code: /^[A-Z_]{3,100}$/.test(body.detail ?? '') ? body.detail : 'CONTEXT_MAINTENANCE_FAILED' });
    return body;
  }
}
