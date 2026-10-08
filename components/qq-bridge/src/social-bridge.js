import fs from 'node:fs';
import path from 'node:path';
import { WechatOneBotAdapter } from './adapters/wechat/wechat-onebot-adapter.js';
import { MessageBuffer } from './core/message-buffer.js';
import { SocialEngine } from './core/social-engine.js';
import { DshPluginClient } from './dsh/plugin-client.js';
import { buildConversationKey } from './core/conversation-key.js';
import { selectRoleText } from './role-card.js';
import { socialPersona } from './core/social-persona.js';
import { stickerPolicy } from './core/sticker-policy.js';
import { WebSearch } from './core/web-search.js';
import {ProactiveEngine} from './core/proactive-engine.js';
import { ContextMaintenance } from './core/context-maintenance.js';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(process.argv[2] ?? path.join(root, 'config.social.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const wechat = config.platforms?.wechat ?? config.wechat ?? {};
if (wechat.enabled !== true) throw new Error('wechat.enabled must be true in config.social.json');
const allowedGroups = new Set((wechat.whitelist?.groups ?? []).map(String));
const allowedPrivate = new Set((wechat.whitelist?.private ?? []).map(String));
const sendPrivateTest = process.argv.slice(3).includes('--test-private');
if (sendPrivateTest && (allowedGroups.size !== 0 || allowedPrivate.size !== 1)) {
  throw new Error('private test requires exactly one allowed friend and an empty group whitelist');
}
if (allowedGroups.size + allowedPrivate.size === 0) console.warn('[Social] WeChat whitelist is empty; all messages will be denied');
const log = (line) => console.log(new Date().toISOString(), line);
const buffer = new MessageBuffer(path.resolve(root, config.message_buffer?.path ?? 'state/social-messages.json'),
  { maxPerChat: config.message_buffer?.max_messages_per_chat ?? 300 });
const plugin = new DshPluginClient(config.dsh_plugin ?? {}, log);
const search=new WebSearch({configFile:config.search_policy_file,stateFile:path.resolve(config.search_state_file??path.join(root,'state/search/state.json')),settings:wechat,log});
const adapter = new WechatOneBotAdapter({ server: { host: '127.0.0.1', ...(wechat.onebot?.server ?? {}),
  token: process.env.SOCIAL_ONEBOT_TOKEN ?? '' } }, log);
const personaFor = (key) => socialPersona(config, key, (roleName) => {
  if (!/^[^\\/\0.][^\\/\0]{0,60}$/.test(roleName) || roleName.includes('..')) throw new Error('invalid role name');
  return selectRoleText(fs.readFileSync(path.join(root, 'roles', `${roleName}.md`), 'utf8'), 'v2');
});
const engine = new SocialEngine({ buffer, roleFor: key => personaFor(key).persona,
  personaNameFor: key => personaFor(key).personaName,
  wakeWords: wechat.wake_words ?? [],
  mode: wechat.wake_mode ?? 'hybrid', batchMs: config.social?.batch_ms ?? 3000,
  minIntervalMs: config.social?.min_interval_ms ?? 15000,
  privateMinIntervalMs: config.social?.private_min_interval_ms ?? 1000,
  maxPerMinute: config.social?.max_per_minute ?? 3,
  maxPerTenMinutes: config.social?.max_per_ten_minutes ?? 10,
  decide: (key, prompt, metadata) => plugin.followup(key, prompt, metadata),
  searchFor:async(message,rows,batchId)=>await plugin.searchReady()?search.prepare(buildConversationKey(message.platform,message.kind,message.conversation_id),rows,batchId):{status:'unavailable'},
  searchPolicyFor:message=>search.policy(buildConversationKey(message.platform,message.kind,message.conversation_id)),
  stickerChoicesFor: message=>adapter.stickerChoices({kind:message.kind,target:message.conversation_id}),
  stickerPolicyFor: message=>stickerPolicy(config.sticker_policy_file?JSON.parse(fs.readFileSync(config.sticker_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,buildConversationKey(message.platform,message.kind,message.conversation_id)),
  stickerLabelsFor: (message,ids)=>adapter.stickerLabels({kind:message.kind,target:message.conversation_id,ids}),
  saveStickerLabels: (message,labels)=>adapter.saveStickerLabels({kind:message.kind,target:message.conversation_id,labels}),
  sendSticker: (message,id,options)=>adapter.sendSticker({kind:message.kind,target:message.conversation_id,id,deliveryId:options?.deliveryId}),
  send: (message, text, options) => adapter.sendText({ kind: message.kind, target: message.conversation_id, text,deliveryId:options?.deliveryId }), log });
const proactive=new ProactiveEngine({stateFile:path.resolve(config.proactive_state_file??path.join(root,'state/proactive/state.json')),
  buffer,social:engine,settingsFor:()=>config.proactive_policy_file?JSON.parse(fs.readFileSync(config.proactive_policy_file,'utf8').replace(/^\uFEFF/,'')):{wechat},
  personaFor,decide:(key,prompt,metadata)=>plugin.followup(key,prompt,metadata),
  searchFor:async(message,rows,batchId)=>await plugin.searchReady()?search.prepare(buildConversationKey(message.platform,message.kind,message.conversation_id),rows,batchId):{status:'unavailable'},
  send:(message,text,options)=>adapter.sendText({kind:message.kind,target:message.conversation_id,text,...options}),
  isReady:()=>adapter.stats.connected&&!!adapter.selfId,selfIdFor:()=>adapter.selfId,log});
const contextMaintenance = new ContextMaintenance({ buffer, social: engine,
  settingsFor: () => config.context_policy_file ? JSON.parse(fs.readFileSync(config.context_policy_file, 'utf8').replace(/^\uFEFF/, '')) : { wechat },
  maintain: (key, version) => plugin.maintainContext(key, version),
  proactivePending: key => !!proactive.state.chats[key]?.job,
  isReady: () => adapter.stats.connected && !!adapter.selfId, log });

adapter.onMessage((message) => {
  try {
    const list = message.kind === 'group' ? allowedGroups : allowedPrivate;
    if (!list.has(String(message.conversation_id))) {
      log(`[WeChat] denied ${message.kind}:${message.conversation_id}`); return;
    }
    log(`[WeChat] accepted ${buildConversationKey(message.platform, message.kind, message.conversation_id)}`);
    engine.receive(message);
  } catch (error) { log(`[Social] inbound error=${error?.message ?? error}`); }
});
adapter.on('open', () => log('[WeChat] OneBot adapter connected'));
adapter.on('close', () => log('[WeChat] OneBot adapter disconnected'));
adapter.on('error', (error) => log(`[WeChat] adapter error=${error?.message ?? error}`));
if (sendPrivateTest) adapter.once('open', () => {
  const target = [...allowedPrivate][0];
  void adapter.sendText({ kind: 'private', target,
    text: '这是蓝色大肥鱼的 AI 接入测试。收到后请回复“测试”，我会尝试自动回应。' })
    .then(() => log('[WeChat] private test confirmed by server receipt'))
    .catch((error) => log(`[WeChat] private test failed=${error?.message ?? error}`));
});
await adapter.start();
log(`[Social] reverse OneBot listening on 127.0.0.1:${wechat.onebot?.server?.port ?? 11229}${wechat.onebot?.server?.path ?? '/ws'}`);
const replayTimer = setInterval(() => {
  for (const key of buffer.keys()) engine.replay(key);
}, 30000);
const proactiveTimer=setInterval(()=>void proactive.tick(),60000);void proactive.tick();
const contextTimer = setInterval(() => void contextMaintenance.tick(), 30000); void contextMaintenance.tick();
const stop = async () => { clearInterval(contextTimer);contextMaintenance.stop();clearInterval(proactiveTimer);clearInterval(replayTimer); engine.stop(); await adapter.stop(); process.exit(0); };
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
