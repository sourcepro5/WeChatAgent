import {ask,generate,list} from './lib/notebook.mjs';
export function setup(api){
  api.registerAction({id:'ask',description:'处理已验证的微信日记询问，按询问者计数。',parameters:{type:'object',properties:{id:{type:'string',minLength:64,maxLength:64},viewer:{type:'string',minLength:64,maxLength:64}},required:['id','viewer'],additionalProperties:false},execute:ask});
  api.registerAction({id:'write-today',description:'由前端提前写下今天的日记；已写成时返回原篇。',parameters:{type:'object',properties:{},additionalProperties:false},execute:ctx=>generate(ctx,{allowEmpty:true})});
  api.registerAction({id:'list',description:'本机插件页面按页读取所选聊天的日记；查看不计入询问次数。',parameters:{type:'object',properties:{offset:{type:'integer',minimum:0,maximum:10000}},additionalProperties:false},execute:list});
  api.onSchedule(ctx=>generate(ctx));
}
