import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRoleText } from '../components/qq-bridge/src/role-card.js';
import { conversationId } from './hook-onebot.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const config=read('config/wechatagent.json'),io=read('state/wechat-io-config.json'),token=fs.readFileSync(path.join(root,'state/social-dsh-token.txt'),'utf8').trim();
const base=`http://127.0.0.1:${config.ports.dshPlugin}`, action=process.argv[2] ?? 'configure', target=process.argv[3];
if(!['configure','compact','status'].includes(action))throw new Error('Use configure, compact or status, optionally followed by a conversation key.');
async function request(route,body){
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(125000)});
  const result=await response.json();if(!response.ok)throw new Error(result.detail ?? result.error ?? 'DSH session request failed');return result;
}
const health=await request('/health');if(health.contextMode!=='native-session-v1')throw new Error('Fully exit and reopen DSH to load the native-session plugin.');
if(action==='status'){const result=await request('/sessions');for(const session of result.sessions)console.log(JSON.stringify(session));}
else{
  const response=await fetch(io.reader_base_url+'/api/v1/sessions?limit=500',{headers:{Authorization:'Bearer '+io.reader_token},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Start the NT reader before configuring session names.');
  const contacts=(await response.json()).sessions ?? [];
  const keys=target?[target]:[...config.wechat.whitelist.private.map(id=>'wechat:private:'+id),...config.wechat.whitelist.groups.map(id=>'wechat:group:'+id)];
  for(const key of keys){
    const [,kind,id]=key.split(':');
    if(!config.wechat.whitelist[kind==='group'?'groups':'private'].map(String).includes(id))throw new Error('Only whitelisted conversations can be managed by this command.');
    const matches=contacts.filter(c=>c.username && (c.username.includes('@chatroom')?'group':'private')===kind && String(conversationId(c.username,c.displayName))===id);
    if(matches.length!==1)throw new Error('Conversation mapping is missing or ambiguous.');
    const personaName=config.persona.chats?.[key] ?? config.persona.default;
    const persona=selectRoleText(fs.readFileSync(path.join(root,'roles',personaName+'.md'),'utf8'),'v2');
    const configured=await request('/configure',{conversationKey:key,conversationName:matches[0].displayName,personaName,persona});
    if(action==='compact')console.log(JSON.stringify({...await request('/compact',{conversationKey:key}),title:configured.title}));
    else console.log(JSON.stringify(configured));
  }
}
