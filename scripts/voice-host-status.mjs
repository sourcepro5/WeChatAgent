import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {configuration} from '../packages/plugin-api/catalog.mjs';
import {readVoiceAttempt} from '../packages/plugin-api/voice-status.mjs';

// voice-input-v1 host facts for plugins that request audio_read: whether the
// configured runtime can convert WeChat SILK to WAV, and the latest real voice
// attempt for the plugin's current settings generation. No plugin code runs.
export function voiceDecoderCapabilities(root,{spawnImpl=spawn}={}){
  return new Promise(resolve=>{
    let python;
    try{python=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')).runtime.python;}catch{return resolve({checked:false,decoder:false,reason:'未配置运行环境。'});}
    let child,output='',settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child?.kill();finish({checked:false,decoder:false,reason:'运行环境检测超时。'});},4000);
    try{
      child=spawnImpl(python,['-B',path.join(root,'scripts/decode-wechat-voice.py'),'--probe'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
      child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>4096){child.kill();finish({checked:false,decoder:false});}});
      child.once('error',()=>finish({checked:false,decoder:false,reason:'无法启动已配置的运行环境。'}));
      child.once('exit',code=>{try{const value=JSON.parse(output.trim());finish({checked:code===0,decoder:code===0&&value.decoder===true});}catch{finish({checked:false,decoder:false,reason:'运行环境检测未完成。'});}});
    }catch{finish({checked:false,decoder:false,reason:'无法启动已配置的运行环境。'});}
  });
}

export function createVoiceHostStatus({root,readCapabilities=()=>voiceDecoderCapabilities(root),now=Date.now}){
  let cache,at=0;
  const generation=id=>{try{return configuration(root).config.plugins[id]?.generation;}catch{return undefined;}};
  const lastAttempt=id=>{const value=generation(id);return value?readVoiceAttempt(root,id,value):null;};
  async function decoder(){if(!cache||now()-at>=30000){cache=await readCapabilities();at=now();}return cache;}
  return {
    lastAttempt,
    async status(id){return {decoder:await decoder(),lastAttempt:lastAttempt(id)};},
    // Catalog badge: only real voice traffic, never a synthetic test result.
    card(id){
      const attempt=lastAttempt(id);if(!attempt)return undefined;
      if(attempt.code==='VOICE_PLUGIN_CONFLICT')return {state:'error',label:'语音插件冲突',message:'同一聊天启用了多个语音插件，请只为该聊天保留一个。'};
      return attempt.ok?{state:'ok',label:'最近语音转写成功',message:'微信语音已收到并完成转写。'}:{state:'error',label:'语音已收到，转写失败',message:'错误码 '+attempt.code+'，请打开配置测试识别。'};
    },
  };
}
