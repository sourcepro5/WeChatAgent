import fs from 'node:fs';
import path from 'node:path';
import { prepare, projectRoot } from './project-config.mjs';
const file = path.join(projectRoot, 'config', 'wechatagent.json');
const backup = path.join(projectRoot, 'config', 'wechatagent.pre-hook.json');
if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
config.runtime.sender = 'wechat-hook';
config.runtime.weflowMode = 'nt';
config.hook = { baseUrl: 'http://127.0.0.1:30001', expectedVersion: '4.1.10.27',
  wechatExecutable: 'state/hook/wechat-4.1.10.27/Weixin.exe', requestTimeoutMs: 5000,
  receiptTimeoutMs: 18000, maxConcurrentSends: 4, ...(config.hook ?? {}) };
fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2) + '\n');
fs.renameSync(file + '.tmp', file);
prepare();
console.log('WeChat-Hook selected. Personas, whitelists and DSH configuration preserved; prior configuration backed up.');
