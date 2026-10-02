import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function waitFor(check, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(check()); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('timed out')); }
    }, 10);
  });
}

test('OneBot group batch reaches plugin and only RESPOND sends a OneBot action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-e2e-'));
  const port = await freePort();
  const token = 'local-test-token';
  const prompts = [];
  let answer = 'SILENT';
  const plugin = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    prompts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: answer }));
  });
  await new Promise((resolve) => plugin.listen(0, '127.0.0.1', resolve));
  const config = {
    platforms: { wechat: { enabled: true, whitelist: { groups: ['123'], private: ['42'] },
      onebot: { server: { port, path: '/ws' } }, wake_mode: 'hybrid', wake_words: ['@小助手'] } },
    dsh_plugin: { url: `http://127.0.0.1:${plugin.address().port}`, timeoutMs: 3000 },
    message_buffer: { path: path.join(dir, 'messages.json') }, social: { batch_ms: 30 }, role: '普通群友',
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, ['src/social-bridge.js', configPath], {
    cwd: root, env: { ...process.env, SOCIAL_DSH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let ws;
  try {
    await waitFor(() => output.includes('reverse OneBot listening'));
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const actions = [];
    ws.addEventListener('message', (event) => {
      const action = JSON.parse(event.data); actions.push(action);
      ws.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 42, receipt: 'wechat-server-id' } }));
    });
    const sendEvent = (groupId, value) => ws.send(JSON.stringify({ post_type: 'message', message_type: 'group',
      self_id: 99, user_id: 42, group_id: groupId, group_name: '实验群', time: Date.now() / 1000,
      sender: { user_id: 42, nickname: '张三' }, message: [{ type: 'text', data: { text: value } }] }));
    sendEvent(999, '不在白名单');
    sendEvent(123, '今天训练怎么样');
    sendEvent(123, '跑到 0.42');
    await waitFor(() => prompts.length === 1);
    assert.equal(actions.length, 0);
    assert.match(prompts[0].message, /今天训练怎么样/);
    assert.match(prompts[0].message, /跑到 0.42/);
    answer = 'RESPOND: 可以再跑一轮看看';
    sendEvent(123, '@小助手 你怎么看');
    await waitFor(() => actions.length === 1);
    assert.equal(actions[0].action, 'send_group_msg');
    assert.equal(actions[0].params.group_id, 123);
    assert.equal(actions[0].params.message[0].data.text, '可以再跑一轮看看');
    assert.equal(prompts.length, 2);
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'private',
      self_id: 99, user_id: 42, time: Date.now() / 1000,
      sender: { user_id: 42, nickname: '联系人A' },
      message: [{ type: 'text', data: { text: '你好' } }] }));
    await waitFor(() => actions.length === 2);
    assert.equal(actions[1].action, 'send_private_msg');
    assert.equal(actions[1].params.user_id, 42);
    assert.equal(prompts[2].conversationKey, 'wechat:private:42');
    assert.equal(fs.existsSync(config.message_buffer.path), true);
  } finally {
    ws?.close(); child.kill();
    await new Promise((resolve) => plugin.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
