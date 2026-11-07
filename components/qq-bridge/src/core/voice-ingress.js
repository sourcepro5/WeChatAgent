import {buildConversationKey} from './conversation-key.js';

/** Per-chat ordering, bounded API concurrency, and no automatic upload retries. */
export class VoiceIngress {
  constructor({recognize, deliver, canRecognize=()=>true, generationFor=()=>'',onResult=()=>{},log=()=>{}}) {
    Object.assign(this,{recognize,deliver,canRecognize,generationFor,onResult,log});
    this.queues=new Map();this.ids=new Set();this.active=0;this.pending=0;this.closed=false;this.controllers=new Set();
    this.waiters=[];
  }
  async acquire(){while(!this.closed&&this.active>=2)await new Promise(resolve=>this.waiters.push(resolve));if(this.closed)return false;this.active++;return true;}
  release(){this.active--;this.waiters.shift()?.();}
  push(message) {
    if(this.closed)return Promise.resolve();
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id),identity=key+'\0'+message.message_id;
    if(!message.voice&&!this.queues.has(key))return Promise.resolve().then(()=>{if(!this.closed)return this.deliver(message);});
    if(this.ids.has(identity))return Promise.resolve();
    if(this.pending>=64){this.log('[Voice] inbound_queue_full');return Promise.resolve();}
    this.ids.add(identity);this.pending++;
    const previous=this.queues.get(key)??Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      if(this.closed)return;
      const controller=new AbortController();this.controllers.add(controller);
      try{
        let prepared=message;
        if(message.voice){
          let generation='';try{generation=this.generationFor(message);}catch{}
          let result;
          const allowed=await this.canRecognize(message);
          if(this.closed||controller.signal.aborted)return;
          if(!allowed)result={ok:false,code:'VOICE_INPUT_UNAVAILABLE',stage:'host'};
          else if(await this.acquire()){
            try{
              if(!await this.canRecognize(message))result={ok:false,code:'VOICE_INPUT_UNAVAILABLE',stage:'host'};
              else result=await this.recognize(message,{signal:controller.signal});
            }catch(error){result={ok:false,code:/^VOICE_[A-Z0-9_]+$/.test(error.message??'')?error.message:'VOICE_INPUT_FAILED',stage:'host'};}
            finally{this.release();}
          }else return;
          if(this.closed||controller.signal.aborted)return;
          if(!await this.canRecognize(message))result={ok:false,code:'VOICE_INPUT_UNAVAILABLE'};
          const success=result?.ok===true&&typeof result.text==='string'&&!!result.text.trim()&&result.text.length<=4000;
          const code=/^VOICE_[A-Z0-9_]{3,80}$/.test(result?.code??'')?result.code:'VOICE_INPUT_FAILED';
          const plugin=/^[a-z][a-z0-9-]{0,39}$/.test(result?.plugin??'')?{plugin:result.plugin}:{};
          try{await this.onResult(message,{ok:success,code,stage:success?'complete':result?.stage??(/^VOICE_(API|MODEL)_/.test(code)?'api':/^VOICE_DECODE/.test(code)?'audio':'host'),...plugin},generation);}catch{this.log('[Voice] diagnostic_write_failed');}
          prepared={...message,message_type:'text',text:success?'[语音转写，可能存在识别误差] '+result.text.trim():'[语音消息已收到，但语音未能识别，错误代码：'+code+'。这是转写失败，本轮未提供语音内容；不要猜测或声称没有收到消息，可以请对方改发文字，并提示检查语音识别插件配置。]'};
          this.log('[Voice] '+key+' '+(success?'transcribed':/^VOICE_[A-Z0-9_]+$/.test(result?.code??'')?result.code:'VOICE_INPUT_FAILED'));
        }
        if(!this.closed)await this.deliver(prepared);
      }finally{controller.abort();this.controllers.delete(controller);}
    }).finally(()=>{this.pending--;this.ids.delete(identity);if(this.queues.get(key)===next)this.queues.delete(key);});
    this.queues.set(key,next);return next;
  }
  stop(){this.closed=true;for(const controller of this.controllers)controller.abort();for(const resolve of this.waiters.splice(0))resolve();}
}
