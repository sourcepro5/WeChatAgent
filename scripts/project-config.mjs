import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectRoleText } from '../components/qq-bridge/src/role-card.js';
import { migrateConnections } from './migrate-io-config.mjs';
import { validateStickerSettings } from '../components/qq-bridge/src/core/sticker-policy.js';
import { validateSearchSettings } from '../packages/dsh-social-bridge-plugin/search-policy.mjs';
import {validateProactiveSettings} from '../components/qq-bridge/src/core/proactive-policy.js';
import { validateContextSettings } from '../packages/dsh-social-bridge-plugin/context-policy.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
};
export function validateConfig(config) {
  validateStickerSettings(config.wechat?.stickers);
  validateSearchSettings(config.wechat?.search);
  validateProactiveSettings(config.wechat?.proactive);
  validateContextSettings(config.wechat?.context);
  if (config.version !== 1) throw new Error('Unsupported WeChatAgent config version');
  if (!['nt', 'bundled', 'existing'].includes(config.runtime?.weflowMode ?? 'nt')) throw new Error('weflowMode must be nt, bundled or existing');
  if (config.runtime?.sender !== 'wechat-hook') throw new Error('sender must be wechat-hook; the UIA sender has been removed');
  if (config.runtime.sender === 'wechat-hook') {
    if ((config.runtime.weflowMode ?? 'nt') !== 'nt') throw new Error('WeChat-Hook requires the NT reader for account and receipt checks');
    const url = new URL(config.hook?.baseUrl ?? '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Hook API must be an HTTP loopback base URL');
    if (config.hook.expectedVersion !== '4.1.10.27' || !config.hook.wechatExecutable || /[\r\n"\0]/.test(config.hook.wechatExecutable)) throw new Error('Configure the matching WeChat-Hook executable and version 4.1.10.27');
    for (const [key, low, high] of [['requestTimeoutMs',1000,5000],['receiptTimeoutMs',1000,18000],['maxConcurrentSends',1,4]]) {
      const value = config.hook[key];
      if (!Number.isInteger(value) || value < low || value > high) throw new Error('Invalid Hook ' + key);
    }
    const port = Number(url.port || 80);
    if (Object.values(config.ports ?? {}).includes(port)) throw new Error('Hook port must be distinct from the four project ports');
  }
  const ports = Object.values(config.ports ?? {});
  if (ports.length !== 4 || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== 4) throw new Error('Configure four distinct service ports between 1024 and 65535');
  if (!['weflow','onebot','adapter','dshPlugin'].every(key => Number.isInteger(config.ports[key]))) throw new Error('Required ports: weflow, onebot, adapter, dshPlugin');
  if (!config.runtime?.python || !Array.isArray(config.account?.nicknames) || !config.account.nicknames.length) throw new Error('Python and account nicknames are required');
  for (const kind of ['groups', 'private']) {
    if (!Array.isArray(config.wechat?.whitelist?.[kind]) || config.wechat.whitelist[kind].some(id => !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error(`Invalid ${kind} OneBot IDs; use the numeric IDs in Bridge logs`);
  }
  const role = value => typeof value === 'string' && /^[^\\/\0.][^\\/\0]{0,60}$/.test(value) && !value.includes('..');
  if (!role(config.persona?.default) || Object.values(config.persona?.chats ?? {}).some(value => !role(value))) throw new Error('Invalid persona name');
  if (!['hybrid', 'mention'].includes(config.wechat.wake_mode)) throw new Error('wake_mode must be hybrid or mention');
  if (!config.dsh?.provider || !config.dsh?.model || /[\r\n]/.test(config.dsh.provider + config.dsh.model)) throw new Error('Configure DSH provider and model IDs');
  return config;
}
export function prepare(root = projectRoot) {
  const configFile = path.join(root, 'config', 'wechatagent.json');
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(root, 'config', 'wechatagent.example.json'), configFile);
  migrateConnections(root);
  const config = validateConfig(read(configFile));
  const state = path.join(root, 'state');
  for (const dir of ['logs', 'weflow', 'attachments']) fs.mkdirSync(path.join(state, dir), { recursive: true });
  if (config.runtime.sender === 'wechat-hook') {
    const hookDir = path.join(state, 'hook');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookToken = path.join(hookDir, 'native-token.txt');
    if (!fs.existsSync(hookToken)) fs.writeFileSync(hookToken, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    if (!/^[a-f0-9]{64}$/.test(fs.readFileSync(hookToken, 'utf8').trim())) throw new Error('Invalid native Hook token');
  }
  const tokenFile = path.join(state, 'social-dsh-token.txt');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  for (const name of [config.persona.default, ...Object.values(config.persona.chats ?? {})]) {
    if (!fs.existsSync(path.join(root, 'roles', `${name}.md`))) throw new Error(`Persona file missing: ${name}.md`);
  }
  const ioFile = path.join(state, 'wechat-io-config.json');
  const previousIo = fs.existsSync(ioFile) ? read(ioFile) : {};
  write(ioFile, { reader_base_url: `http://127.0.0.1:${config.ports.weflow}`,
    reader_token: previousIo.reader_token || crypto.randomBytes(32).toString('hex'),
    self_wxid: previousIo.self_wxid || '', onebot_ws_url: `ws://127.0.0.1:${config.ports.onebot}/ws` });
  const roleText = name => selectRoleText(fs.readFileSync(path.join(root, 'roles', `${name}.md`), 'utf8'), 'v2');
  write(path.join(state, 'bridge-config.json'), {
    platforms: { wechat: { enabled: true, adapter: 'wechat-onebot', onebot: { server: { host: '127.0.0.1', port: config.ports.onebot, path: '/ws', timeoutMs: 45000 } }, ...config.wechat } },
    dsh_plugin: { url: `http://127.0.0.1:${config.ports.dshPlugin}`, timeoutMs: 125000 },
    sticker_policy_file: configFile,
    search_policy_file: configFile,
    search_state_file: path.join(state,'search/state.json'),
    proactive_policy_file:configFile,
    proactive_state_file:path.join(state,'proactive/state.json'),
    context_policy_file:configFile,
    message_buffer: { path: path.join(state, 'social-messages.json'), max_messages_per_chat: 300 },
    // Original Bridge accepts inline persona text; it needs no source/path changes.
    persona_name: config.persona.default,
    role: roleText(config.persona.default), roles: Object.fromEntries(Object.entries(config.persona.chats ?? {}).map(([key, name]) => [key, { name, persona: roleText(name) }])), social: config.social,
  });
  const bufferFile = path.join(state, 'social-messages.json');
  if (fs.existsSync(bufferFile)) {
    const buffer = read(bufferFile);
    let changed = false;
    for (const [key, rows] of Object.entries(buffer.chats ?? {})) {
      const match = /^wechat:(private|group):(\d+)$/.exec(key);
      if (match && !config.wechat.whitelist[match[1] === 'group' ? 'groups' : 'private'].map(String).includes(match[2])) {
        for (const row of rows) if (!row.processed) { row.processed = true; changed = true; }
      }
    }
    if (changed) write(bufferFile, buffer);
  }
  // Bundle config is read again when DSH fully restarts. Secrets stay in state.
  const patchFile = path.join(root, 'packages', 'dsh-social-bridge-plugin', 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const before = fs.readFileSync(patchFile, 'utf8');
    let after = before.replace(/^(        provider:).*/m, `$1 ${JSON.stringify(config.dsh.provider)}`).replace(/^(        model:).*/m, `$1 ${JSON.stringify(config.dsh.model)}`);
    const moduleDir=path.dirname(patchFile),sources=['native-context.mjs','search-budget.mjs','search-policy.mjs','social-tool-policy.mjs','social-tool-restrict.mjs','context-policy.mjs'].map(name=>path.join(moduleDir,name));
    if(sources.every(file=>fs.existsSync(file))){
      const revision=crypto.createHash('sha256').update(Buffer.concat(sources.map(file=>fs.readFileSync(file)))).digest('hex').slice(0,16);
      const entry=pathToFileURL(sources[0]).href+'?wechatagent='+revision;
      after=after.replace(/(    - id: dsh-social-bridge-plugin\r?\n      name:).*/,'$1 '+JSON.stringify(entry));
    }
    after = /^        port:/m.test(after) ? after.replace(/^        port:.*/m, `        port: ${config.ports.dshPlugin}`) : after.replace(/^(        model:.*)$/m, `$1\n        port: ${config.ports.dshPlugin}`);
    if (before !== after) fs.writeFileSync(patchFile, after);
  }
  // Original WeFlow owns its encrypted configuration in every provider mode.
  return config;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare(); console.log('WeChatAgent configuration prepared; secrets were not printed.');
}
