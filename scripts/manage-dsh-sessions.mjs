import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRoleText } from '../components/qq-bridge/src/role-card.js';
import { conversationId } from './hook-onebot.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=(message,code=1)=>{console.error('WeChatAgent 会话管理：'+message);process.exitCode=code;};
const read=(file,missing)=>{
  const target=path.join(root,file);
  if(!fs.existsSync(target))throw Object.assign(new Error(missing),{friendly:true});
  try{return JSON.parse(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,''));}
  catch{throw Object.assign(new Error(file+' 不是有效的 JSON，请重新保存配置后再试。'),{friendly:true});}
};
const describe=error=>{
  if(error.friendly)return error.message;
  const code=error.cause?.code??error.code;
  if(code==='ECONNREFUSED'||code==='ECONNRESET')return 'DSH 插件端口没有响应：请完整退出并重开 DSH，确认已启用本项目插件。';
  if(error.name==='TimeoutError')return 'DSH 没有在限定时间内响应：请确认 DSH 未卡住后重试。';
  if(/session ".*" not found|no such session/i.test(String(error.message)))return 'DSH 中已经没有这个会话，但本机映射还指向它。请完整退出 DSH，删除 state/accounts/<账号摘要>/dsh-sessions.json 中对应聊天的 conversations 与 profiles 条目，再重新初始化会话。';
  return String(error.message??error);
};
async function main(){
  const action=process.argv[2] ?? 'configure', target=process.argv[3];
  const usage='用法：node scripts/manage-dsh-sessions.mjs [configure|compact|status] [wechat:private:id 或 wechat:group:id]。configure 初始化或同步会话名称，compact 在同一会话内压缩上下文，status 输出 /sessions 结果。';
  if(!['configure','compact','status'].includes(action))throw Object.assign(new Error(usage),{friendly:true});
  const config=read('config/wechatagent.json','尚未完成首次配置：请先在控制台完成设置并启动一次服务，生成本机配置后再运行此命令。');
  const io=read('state/wechat-io-config.json','读取连接尚未准备：请先在控制台启动服务，生成本机连接配置后再运行此命令。');
  const tokenFile=path.join(root,'state/social-dsh-token.txt');
  if(!fs.existsSync(tokenFile))throw Object.assign(new Error('DSH 插件尚未加载：请完整退出并重开 DSH，确认已启用本项目插件。'),{friendly:true});
  const token=fs.readFileSync(tokenFile,'utf8').trim();
  const base=`http://127.0.0.1:${config.ports.dshPlugin}`;
  async function request(route,body){
    const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(125000)});
    const result=await response.json();if(!response.ok)throw new Error(result.detail ?? result.error ?? 'DSH session request failed');return result;
  }
  const health=await request('/health');if(health.contextMode!=='native-session-v1')throw Object.assign(new Error('DSH 仍在运行旧版插件：请从托盘完整退出 DSH 后重新打开。'),{friendly:true});
  if(action==='status'){const result=await request('/sessions');for(const session of result.sessions)console.log(JSON.stringify(session));}
  else{
    const response=await fetch(io.reader_base_url+'/api/v1/sessions?limit=500',{headers:{Authorization:'Bearer '+io.reader_token},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Object.assign(new Error('读取服务未就绪：请先在控制台启动服务并连接微信。'),{friendly:true});
    const contacts=(await response.json()).sessions ?? [];
    const keys=target?[target]:[...config.wechat.whitelist.private.map(id=>'wechat:private:'+id),...config.wechat.whitelist.groups.map(id=>'wechat:group:'+id)];
    for(const key of keys){
      const [,kind,id]=key.split(':');
      if(!config.wechat.whitelist[kind==='group'?'groups':'private'].map(String).includes(id))throw Object.assign(new Error(`只允许管理聊天范围中的会话，收到 ${key}。请先在“聊天”页保存允许范围。`),{friendly:true});
      const matches=contacts.filter(c=>c.username && (c.username.includes('@chatroom')?'group':'private')===kind && String(conversationId(c.username,c.displayName,c.conversationId))===id);
      if(matches.length!==1)throw Object.assign(new Error(`找不到唯一的聊天映射（${key}）：请刷新群资料或在“聊天”页使用“重新关联原群”；现有 DSH 会话未被删除。`),{friendly:true});
      const personaName=config.persona.chats?.[key] ?? config.persona.default;
      const personaFile=path.join(root,'roles',personaName+'.md');
      if(!fs.existsSync(personaFile))throw Object.assign(new Error(`找不到人格「${personaName}」：请先在“人格”页创建或改选人格。`),{friendly:true});
      const persona=selectRoleText(fs.readFileSync(personaFile,'utf8'),'v2');
      const configured=await request('/configure',{conversationKey:key,conversationName:matches[0].displayName,personaName,persona});
      if(action==='compact')console.log(JSON.stringify({...await request('/compact',{conversationKey:key}),title:configured.title}));
      else console.log(JSON.stringify(configured));
    }
  }
}
main().catch(error=>fail(describe(error)));
