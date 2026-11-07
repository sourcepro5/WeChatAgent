import fs from 'node:fs';
import {effectiveSpeechSettings} from './presets.mjs';
import {endpointUrl,resolveApi,requestHeaders,limitedBody,validateConfig,requestFor,transcribeAudio,voiceErrorCode} from './recognize.mjs';

export const EXPECTED_SAMPLE = '语音识别测试';
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f<>"'`]/.test(value) && !/^https?:\/\//i.test(value);
const clean = value => String(value??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,200);
export const errorMessages = Object.freeze({
  VOICE_API_NOT_CONFIGURED:'请先填写完整的识别接口地址。',VOICE_API_ENDPOINT_INVALID:'接口地址需要 HTTPS；本机服务也可使用 HTTP。',
  VOICE_API_KEY_INVALID:'请粘贴原始 API Key，不要带 Bearer、引号、环境变量名或换行。',
  VOICE_MODEL_REQUIRED:'请先选择或填写识别模型 ID，不能将空模型配置启用。',
  VOICE_API_PROTOCOL_MISMATCH:'完整接口路径与所选协议不一致，请填写对应的服务基础地址或完整识别路径。',
  VOICE_API_AUDIO_PROTOCOL_UNSUPPORTED:'当前是 Anthropic Messages 协议。它的标准消息格式不提供本插件所需的音频输入；请改用服务商的语音转写或 Chat 音频入口。私有音频协议可选自定义请求。',
  VOICE_API_AUDIO_FORMAT_UNSUPPORTED:'Chat 音频协议需要 WAV，请将上传音频格式设为 wav。',
  VOICE_MODEL_IS_URL:'模型名填写了网址，请选择或填写模型 ID。',VOICE_MODEL_INVALID:'模型 ID 格式不正确。',
  VOICE_API_CONFIG_INVALID:'请求头或请求设置不是有效格式。',VOICE_API_TEMPLATE_INVALID:'JSON 模板含未知占位符。',
  VOICE_API_TEMPLATE_AUDIO_MISSING:'JSON 请求模板没有包含当前音频，请加入音频占位符。',
  VOICE_API_HTTP_401:'接口鉴权失败，请检查密钥和所选协议的鉴权方式。',VOICE_API_HTTP_403:'识别接口拒绝访问（HTTP 403），请核对协议、地址及密钥的模型权限。',
  VOICE_API_HTTP_404:'平台未提供此语音入口，请核对服务类型与地址。能读取模型列表不代表能识别语音。',VOICE_API_HTTP_405:'接口不接受当前请求方式。',
  VOICE_API_HTTP_429:'服务限流，请稍后重试。',VOICE_API_TIMEOUT:'接口响应超时。',
  VOICE_API_EMPTY_TRANSCRIPT:'接口没有返回可用转写文字，请核对模型和结果路径。',
  VOICE_API_RESPONSE_INVALID:'找不到转写结果，请核对 JSON 结果路径。',
  VOICE_API_RESPONSE_TOO_LARGE:'接口响应超过大小限制。',VOICE_API_REQUEST_FAILED:'接口请求失败，请检查连接、请求格式和服务协议。',
  VOICE_MODELS_RESPONSE_INVALID:'返回内容不是模型列表，请调整模型列表地址或结果路径。',
  VOICE_MODELS_UNSUPPORTED:'此接口没有提供可读取的模型列表，可以手动填写模型 ID。',
  VOICE_DECODER_MISSING:'WAV 转换组件未就绪，当前微信语音无法转换为 WAV。',
});
export const errorMessage = code => errorMessages[code]??(/^VOICE_API_HTTP_\d+$/.test(code)?'服务返回错误（HTTP '+code.split('_').at(-1)+'），请核对接口配置。':'操作未完成，请检查接口配置。');

export function modelsCandidates(config) {
  config=effectiveSpeechSettings(config,{forModels:true});
  if (config.modelsEndpoint?.trim()) return [endpointUrl(config.modelsEndpoint)];
  const {protocol,baseUrl}=resolveApi(config),url=new URL(baseUrl);
  url.pathname=baseUrl.pathname.replace(/\/+$/,'')+(protocol==='anthropic-messages'?'/v1/models':'/models');
  if(protocol==='anthropic-messages')url.searchParams.set('limit','1000');
  return [url];
}

function atPath(value,path){for(const key of path.split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key)||!value||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
export function modelTransport(item){
  const protocol=String(item?.transport??item?.protocol??'').toLowerCase();
  if(/websocket|\bwss?\b/.test(protocol))return 'websocket';
  if(/https?|rest/.test(protocol))return 'http';
  return 'unknown';
}
export function normalizeModels(body,path='data') {
  let values=Array.isArray(body)?body:atPath(body,path);
  if (!Array.isArray(values)) values = ['data','models','result.models','result.data'].map(name=>atPath(body,name)).find(Array.isArray);
  if(!Array.isArray(values)){
    const mapped=atPath(body,path)??body?.models;
    if(mapped&&typeof mapped==='object'&&!Array.isArray(mapped))values=Object.entries(mapped).slice(0,1000).filter(([,value])=>value&&typeof value==='object'&&!Array.isArray(value)).map(([alias,value])=>({...value,id:alias||value.id}));
  }
  if (!Array.isArray(values)) throw Error('VOICE_MODELS_RESPONSE_INVALID');
  const models=[],seen=new Set();
  for(const raw of values.slice(0,1000)){
    const item=typeof raw==='string'?{id:raw}:raw;
    const id=item?.id??item?.model??item?.name;
    if(!safeId(id)||seen.has(id))continue;
    seen.add(id);
    const input=item.input_modalities??item.inputModalities??item.modalities?.input??item.input;
    const audioDeclared=Array.isArray(input)?input.some(name=>['audio','speech'].includes(String(name).toLowerCase())):undefined;
    const transportHint=modelTransport(item);
    // Standard model lists often contain only IDs. Keep opaque aliases visible;
    // only explicit modality/transport metadata can exclude them.
    const audioCandidate=transportHint!=='websocket'&&audioDeclared!==false;
    models.push({id,name:clean(item.display_name??item.displayName??item.name??id),audioCandidate,audioDeclared:audioDeclared??null,transportHint});
    if(models.length>=256)break;
  }
  return models.sort((a,b)=>Number(b.audioCandidate)-Number(a.audioCandidate)||a.id.localeCompare(b.id));
}

export async function discoverModels(config,{signal,fetchImpl=fetch}={}){
  try{
    config=effectiveSpeechSettings(config,{forModels:true});
    const urls=modelsCandidates(config),combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.min(config.timeoutMs??20000,12000))]);
    const headers=requestHeaders(config);headers.delete('content-type');
    for(const url of urls){
      const response=await fetchImpl(url,{method:'GET',headers,redirect:'error',signal:combined});
      if([404,405,501].includes(response.status)){await response.body?.cancel();continue;}
      if(!response.ok){await response.body?.cancel();throw Error('VOICE_API_HTTP_'+response.status);}
      let body;try{body=JSON.parse(await limitedBody(response,512*1024));}catch(error){if(error instanceof SyntaxError)throw Error('VOICE_MODELS_RESPONSE_INVALID');throw error;}
      const models=normalizeModels(body,config.modelsResponsePath??'data');
      return {ok:true,models,count:models.length,audioCandidates:models.filter(item=>item.audioCandidate).length,source:config.modelsEndpoint?.trim()?'explicit':'auto'};
    }
    return {ok:false,code:'VOICE_MODELS_UNSUPPORTED',message:errorMessage('VOICE_MODELS_UNSUPPORTED'),models:[]};
  }catch(error){const code=voiceErrorCode(error);return {ok:false,code,message:errorMessage(code),models:[]};}
}

export function sampleAudio(){
  const data=fs.readFileSync(new URL('../assets/config-test.wav',import.meta.url));
  return {id:'configuration-test',b64:data.toString('base64'),mime:'audio/wav',filename:'config-test.wav',sampleRate:16000,durationSeconds:(data.length-44)/32000};
}

export function inspectConfiguration(config,capabilities={},models=[]){
  const checks=[];let configurationValid=true;
  try{config=effectiveSpeechSettings(config);validateConfig(config);requestFor(config,sampleAudio());checks.push({id:'configuration',state:'ok',message:'接口与请求设置格式有效。'});}
  catch(error){configurationValid=false;const code=voiceErrorCode(error);checks.push({id:'configuration',state:'error',code,message:errorMessage(code)});}
  const decoderReady=config.audioFormat==='silk'||capabilities.decoder===true;
  checks.push({id:'decoder',state:decoderReady?'ok':capabilities.checked?'error':'pending',code:decoderReady?undefined:'VOICE_DECODER_MISSING',message:config.audioFormat==='silk'?'原始 SILK 无需 WAV 转换组件。':decoderReady?'微信语音转 WAV 组件已就绪。':capabilities.checked?errorMessage('VOICE_DECODER_MISSING'):'WAV 转换组件尚未检查。'});
  const selected=models.find(item=>item.id===config.model);
  checks.push({id:'model',state:selected?'ok':config.model?'warning':'pending',message:selected?'所选模型由接口模型列表返回；仍需测试确认音频能力。':config.model?'模型 ID 尚未由接口列表确认，可测试识别验证。':'请填写模型 ID；标准协议不能留空，自定义请求可按平台默认模型规则处理。'});
  if(selected?.audioDeclared!==true)checks.push({id:'audio-model',state:'warning',message:selected?.audioDeclared===false?'模型列表声明此模型不接受音频，请选择支持音频输入的模型。':'模型目录未提供音频能力信息，请用内置短句测试确认。'});
  if((selected?.transportHint??modelTransport(config.model))==='websocket')checks.push({id:'model-transport',state:'warning',message:'所选模型可能使用 WebSocket 实时协议；当前插件使用 HTTP POST。请确认服务提供兼容网关，或改选 HTTP 文件识别模型。'});
  let endpoint;try{endpoint=endpointUrl(config.endpoint);}catch{}
  if(endpoint&&/\/(?:anthropic|messages)\/?$/i.test(endpoint.pathname))checks.push({id:'protocol',state:'warning',message:'当前地址看起来是消息接口，请确认支持音频并核对请求协议。'});
  if(endpoint&&/\/chat\/completions\/?$/i.test(endpoint.pathname)&&config.requestMode==='multipart')checks.push({id:'request-protocol',state:'warning',message:'当前地址看起来是聊天补全接口，通常需要 JSON 音频请求；请核对模板、请求格式和转写结果路径。'});
  try{const route=resolveApi(config);checks.push({id:'route',state:'ok',message:'请求协议：'+route.protocol+'；调用路径：'+route.url.pathname+'。'});}catch{}
  return {configurationValid,decoderReady,checks};
}

export async function probeTranscription(config,options={}){
  try{
    const text=await transcribeAudio(config,sampleAudio(),options),normalized=text.replace(/[^\p{L}\p{N}]/gu,'');
    const matched=normalized.includes(EXPECTED_SAMPLE);
    return {ok:true,verified:matched,sampleFormat:'wav',message:matched?'识别接口已成功转写内置测试短句。':'接口返回了文字，但没有匹配测试短句，请核对模型和结果路径。',text:text.slice(0,500)};
  }catch(error){const code=voiceErrorCode(error),inconclusive=config.audioFormat==='silk'&&/^VOICE_API_HTTP_(400|415|422)$/.test(code);return {ok:false,verified:false,code,sampleFormat:'wav',inconclusive,message:errorMessage(code)+(inconclusive?' 内置测试音频为 WAV；仅支持 SILK 的接口需要实际 SILK 输入验证。':'')};}
}
