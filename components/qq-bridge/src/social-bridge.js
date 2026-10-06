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
  stickerChoicesFor: message=>adapter.stickerChoices({kind:message.kind,target:message.conversation_id}),
  stickerPolicyFor: message=>stickerPolicy(config.sticker_policy_file?JSON.parse(fs.readFileSync(config.sticker_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,buildConversationKey(message.platform,message.kind,message.conversation_id)),
  stickerLabelsFor: (message,ids)=>adapter.stickerLabels({kind:message.kind,target:message.conversation_id,ids}),
  saveStickerLabels: (message,labels)=>adapter.saveStickerLabels({kind:message.kind,target:message.conversation_id,labels}),
  sendSticker: (message,id)=>adapter.sendSticker({kind:message.kind,target:message.conversation_id,id}),
  send: (message, text) => adapter.sendText({ kind: message.kind, target: message.conversation_id, text }), log });

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
    text: '这是微信助手的 AI 接入测试。收到后请回复“测试”，我会尝试自动回应。' })
    .then(() => log('[WeChat] private test confirmed by server receipt'))
    .catch((error) => log(`[WeChat] private test failed=${error?.message ?? error}`));
});
await adapter.start();
log(`[Social] reverse OneBot listening on 127.0.0.1:${wechat.onebot?.server?.port ?? 11229}${wechat.onebot?.server?.path ?? '/ws'}`);
const replayTimer = setInterval(() => {
  for (const key of buffer.keys()) engine.replay(key);
}, 30000);
const stop = async () => { clearInterval(replayTimer); engine.stop(); await adapter.stop(); process.exit(0); };
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
