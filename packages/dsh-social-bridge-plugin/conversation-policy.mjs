import {validateAssistantSettings} from './assistant-policy.mjs';
import {validateReplyLayout} from './reply-layout-policy.mjs';
import {validateTimeZone} from './time-zone-policy.mjs';
const KEY=/^wechat:(private|group):[1-9]\d{0,15}$/;
export const validChatKey=value=>typeof value==='string'&&KEY.test(value)&&Number.isSafeInteger(Number(value.split(':')[2]));
export const allowedConversation=(wechat,key)=>validChatKey(key)&&(wechat?.whitelist?.[key.split(':')[1]==='group'?'groups':'private']??[]).some(id=>String(id)===key.split(':')[2]);
const names=(value,tool=false)=>Array.isArray(value)&&value.length<=50&&value.every(name=>typeof name==='string'&&name.length>=1&&name.length<=120&&!/[\u0000-\u001f\u007f<>]/.test(name)&&(!tool||/^[\w.:-]+$/.test(name)))&&new Set(value).size===value.length;
export const validDshAccess=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['skills','tools','mode','preset','remoteApproval','timeoutMinutes','toolLimit'].includes(key))&&names(value.skills??[])&&names(value.tools??[],true)&&(value.preset===undefined||typeof value.preset==='string'&&/^[\w.:-]{1,120}$/.test(value.preset))&&(value.mode===undefined||['custom','native'].includes(value.mode))&&(value.remoteApproval===undefined||typeof value.remoteApproval==='boolean')&&(value.timeoutMinutes===undefined||Number.isInteger(value.timeoutMinutes)&&value.timeoutMinutes>=5&&value.timeoutMinutes<=120)&&(value.toolLimit===undefined||Number.isInteger(value.toolLimit)&&value.toolLimit>=10&&value.toolLimit<=1000);
export function validateConversationSettings(wechat){
  validateAssistantSettings(wechat);
  validateReplyLayout(wechat?.replyLayout);
  validateTimeZone(wechat?.time_zone);
  const workModes=wechat?.workModes;
  if(workModes!==undefined&&(!workModes||typeof workModes!=='object'||Array.isArray(workModes)||Object.entries(workModes).some(([key,mode])=>!validChatKey(key)||!['social','assistant'].includes(mode))))throw Error('Invalid per-chat work mode');
  const saved=wechat?.modeSettings;
  if(saved!==undefined&&(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.entries(saved).some(([key,modes])=>!validChatKey(key)||!modes||typeof modes!=='object'||Array.isArray(modes)||Object.entries(modes).some(([mode,value])=>!['social','assistant'].includes(mode)||!value||Object.keys(value).some(field=>!['settings','access'].includes(field))||value.settings?.workMode!==mode||!validDshAccess(value.access)))))throw Error('Invalid saved work-mode settings');
  const modes=wechat?.chatModes;
  if(modes!==undefined&&(!modes||typeof modes!=='object'||Array.isArray(modes)||Object.entries(modes).some(([key,mode])=>!validChatKey(key)||!key.startsWith('wechat:group:')||!['hybrid','mention'].includes(mode))))throw Error('Invalid per-chat wake_mode');
  const access=wechat?.dshAccess;
  if(access!==undefined&&(!access||typeof access!=='object'||Array.isArray(access)||Object.keys(access).some(key=>key!=='chats')||!access.chats||typeof access.chats!=='object'||Array.isArray(access.chats)||Object.entries(access.chats).some(([key,value])=>!validChatKey(key)||!value||typeof value!=='object'||Array.isArray(value)||!validDshAccess(value))))throw Error('Invalid DSH chat access');
}
export function conversationWorkMode(wechat,key){validateConversationSettings(wechat);return allowedConversation(wechat,key)?wechat?.workModes?.[key]??'social':'social';}
export function conversationMode(wechat,key){validateConversationSettings(wechat);return wechat?.chatModes?.[key]??(conversationWorkMode(wechat,key)==='assistant'?'mention':wechat?.wake_mode??'hybrid');}
export function conversationAccess(wechat,key){validateConversationSettings(wechat);if(!allowedConversation(wechat,key))return {skills:[],tools:[]};const value=wechat?.dshAccess?.chats?.[key]??{};return {...value,skills:[...value.skills??[]],tools:[...value.tools??[]]};}
