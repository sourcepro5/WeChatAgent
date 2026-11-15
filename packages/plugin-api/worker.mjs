import {pathToFileURL} from 'node:url';
import {API_VERSION,HOOKS,hostContract} from './contract.mjs';

const tools=new Map(),actions=new Map(),services=new Map(),calls=new Map();let module,scheduled,ready=false,serial=0;
const send=value=>{if(process.connected&&Buffer.byteLength(JSON.stringify(value))<=2*1024*1024)process.send(value);};
const service=(call,method,args)=>new Promise((resolve,reject)=>{const id=String(++serial);services.set(id,{resolve,reject});send({type:'service',id,call,method,args});});
function context(call,data,signal){
  const storage=scope=>Object.freeze(Object.fromEntries(['get','set','delete'].map(method=>[method,(...args)=>service(call,'storage.'+method,[scope,...args])])));
  return Object.freeze({...data,apiVersion:API_VERSION,signal,config:()=>structuredClone(data.settings),
    storage:storage('chat'),actorStorage:storage('actor'),
    audio:Object.freeze({
      read:(id,options)=>service(call,'audio.read',[id,options??{}]),
      write:base64=>service(call,'audio.write',[base64]),
    }),
    documents:Object.freeze({get:id=>service(call,'documents.get',[id]),put:(id,value)=>service(call,'documents.put',[id,value]),list:options=>service(call,'documents.list',[options??{}])}),
    persona:()=>service(call,'persona',[]),
    model:Object.freeze({generate:options=>service(call,'model.generate',[options])}),
    history:Object.freeze({recent:options=>service(call,'history.recent',[options??{}]),today:options=>service(call,'history.today',[options??{}])}),
    reply:text=>service(call,'reply',[text]),
    fetch:async(url,options)=>{const result=await service(call,'fetch',[url,options??{}]);return new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:result.headers});},
  });
}
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
  if(message?.type==='service-result'){
    const pending=services.get(message.id);if(!pending)return;services.delete(message.id);
    if(message.error)pending.reject(Error(message.error));else pending.resolve(message.value);return;
  }
  if(message?.type==='dispose'){
    try{await module?.deactivate?.();await module?.dispose?.();}finally{process.exit(0);}return;
  }
  if(message?.type!=='call'||!ready||typeof message.id!=='string')return;
  const controller=new AbortController();calls.set(message.id,controller);
  try{
    const ctx=context(message.id,message.context,controller.signal);
    const action=message.kind==='tool'?tools.get(message.name)?.execute:message.kind==='action'?actions.get(message.name)?.execute:message.kind==='schedule'?scheduled:module.hooks?.[message.name];
    if(typeof action!=='function')throw Error('PLUGIN_ACTION_UNAVAILABLE');
    const value=['tool','action'].includes(message.kind)?await action(ctx,message.args):await action(Object.freeze({...ctx,...message.args}));
    if(Buffer.byteLength(JSON.stringify(value??null))>64*1024)throw Error('PLUGIN_OUTPUT_TOO_LARGE');
    send({type:'result',id:message.id,value:value??null});
  }catch(error){send({type:'result',id:message.id,error:String(error.message??'PLUGIN_EXECUTION_FAILED').slice(0,500)});}
  finally{controller.abort();calls.delete(message.id);}
});
try{
  module=await import(pathToFileURL(process.argv[2]).href);
  const api=Object.freeze({apiVersion:API_VERSION,registerTool(def){
    if(!def||!/^[a-z][a-z0-9-]{0,19}$/.test(def.id??'')||tools.has(def.id)||tools.size>=16||typeof def.execute!=='function'||typeof def.description!=='string'||!def.description.trim()||def.description.length>2000)throw Error('PLUGIN_TOOL_DEFINITION_INVALID');
    tools.set(def.id,def);return process.argv[3]+'__'+def.id;
  },registerAction(def){
    if(!def||!/^[a-z][a-z0-9-]{0,19}$/.test(def.id??'')||actions.has(def.id)||actions.size>=16||typeof def.execute!=='function'||typeof def.description!=='string'||!def.description.trim()||def.description.length>2000)throw Error('PLUGIN_ACTION_DEFINITION_INVALID');
    actions.set(def.id,def);return def.id;
  },onSchedule(fn){if(typeof fn!=='function'||scheduled)throw Error('PLUGIN_SCHEDULE_INVALID');scheduled=fn;}});
  if(typeof module.setup!=='function')throw Error('PLUGIN_SETUP_REQUIRED');
  await module.setup(api);await module.activate?.();
  const hooks=Object.keys(module.hooks??{});if(hooks.some(name=>!HOOKS.includes(name)||typeof module.hooks[name]!=='function'))throw Error('PLUGIN_HOOK_INVALID');
  if(!tools.size&&!hooks.length&&!actions.size&&!scheduled)throw Error('PLUGIN_HAS_NO_ACTIONS');
  ready=true;send({type:'ready',contract:hostContract(),tools:[...tools.values()].map(({id,description,parameters})=>({id,description,parameters})),actions:[...actions.values()].map(({id,description,parameters})=>({id,description,parameters})),scheduled:!!scheduled,hooks});
}catch(error){send({type:'fatal',error:String(error.message??'PLUGIN_LOAD_FAILED').slice(0,500)});setTimeout(()=>process.exit(1),20);}
