// Explicit diagnostic send through a real OneBot WebSocket. No DSH generation.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HookOneBot, root } from './hook-onebot.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';

const target = process.argv[2], text = process.argv.slice(3).join(' ');
if (!/^\d+$/.test(target ?? '') || !text.trim()) throw new Error('Usage: node scripts/check-hook-live.mjs PRIVATE_ONEBOT_ID TEST_TEXT');
const adapter = new HookOneBot(), peer = new ReverseOneBotServer({ port: 0, timeoutMs: 45000 });
let connected;
const connection = new Promise(resolve => { connected = resolve; });
peer.on('open', connected); peer.on('error', () => {});
try {
  await peer.start();
  adapter.api.onebot_ws_url = `ws://127.0.0.1:${peer.server.address().port}/ws`;
  adapter.project.ports.adapter = 0;
  await adapter.start();
  await Promise.race([connection, sleep(10000).then(() => { throw new Error('Diagnostic OneBot connection timeout'); })]);
  const response = await peer.action('send_private_msg', {
    user_id: Number(target), message: [{ type: 'text', data: { text } }],
  });
  if (response.data?.receipt !== 'wechat-server-id') throw new Error('Diagnostic has no new server receipt');
  const file = path.join(root, 'state', 'hook', 'deployment.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  Object.assign(result, { outcome: 'native-private-send-verified', hookAccountVerified: true,
    realSendVerified: true, onebotWebSocketVerified: true, diagnosticSends: 1 });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log('Live native private send passed: real OneBot WebSocket response, new selected-conversation server receipt.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await adapter.stop(); await peer.stop(); }
