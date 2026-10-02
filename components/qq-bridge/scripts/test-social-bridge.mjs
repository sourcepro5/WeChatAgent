import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConversationKey } from '../src/core/conversation-key.js';
import { MessageBuffer } from '../src/core/message-buffer.js';
import { SocialEngine, parseSocialDecision } from '../src/core/social-engine.js';
import { ReverseOneBotServer } from '../src/onebot/reverse-ws-server.js';
import { WechatOneBotAdapter } from '../src/adapters/wechat/wechat-onebot-adapter.js';
import { normalizeOneBotEvent } from '../src/onebot/normalize.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeMessage = (id, text = '你好') => ({ platform: 'wechat', kind: 'group',
  conversation_id: id, sender_id: '42', sender_name: '张三', self_id: '99',
  message_id: `${id}-${Date.now()}`, message_type: 'text', text,
  timestamp: Date.now() / 1000, segments: [{ type: 'text', data: { text } }] });

test('conversation keys isolate platforms and groups', () => {
  assert.notEqual(buildConversationKey('qq', 'group', 1), buildConversationKey('wechat', 'group', 1));
  assert.notEqual(buildConversationKey('wechat', 'group', 1), buildConversationKey('wechat', 'group', 2));
});

test('QQ and WeChat OneBot events normalize into the same message fields', () => {
  const event = { post_type: 'message', message_type: 'group', group_id: 7,
    user_id: 8, self_id: 9, sender: { nickname: '李四' }, time: 100,
    message: [{ type: 'text', data: { text: '你好' } }] };
  const qq = normalizeOneBotEvent('qq', 'snowluma', event);
  const wechat = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
  for (const message of [qq, wechat]) {
    assert.equal(message.kind, 'group');
    assert.equal(message.conversation_id, '7');
    assert.equal(message.sender_id, '8');
    assert.equal(message.text, '你好');
  }
  assert.notEqual(qq.platform, wechat.platform);
});

test('buffer survives restart and keeps conversations isolated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-buffer-'));
  const file = path.join(dir, 'messages.json');
  try {
    const buffer = new MessageBuffer(file);
    buffer.append(fakeMessage('group-a', 'A'));
    buffer.append(fakeMessage('group-b', 'B'));
    const restored = new MessageBuffer(file);
    assert.deepEqual(restored.recent('wechat:group:group-a').map((m) => m.text), ['A']);
    assert.deepEqual(restored.recent('wechat:group:group-b').map((m) => m.text), ['B']);
    restored.markProcessed('wechat:group:group-a');
    assert.equal(restored.unread('wechat:group:group-a').length, 0);
    assert.equal(restored.unread('wechat:group:group-b').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt persisted buffer is not replaced with an empty history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-corrupt-'));
  const file = path.join(dir, 'messages.json');
  try {
    fs.writeFileSync(file, '{broken');
    assert.throws(() => new MessageBuffer(file));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('social engine batches messages and never sends SILENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-engine-'));
  try {
    const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
    let calls = 0; const sent = [];
    const engine = new SocialEngine({ buffer, batchMs: 20, minIntervalMs: 0,
      decide: async () => { calls++; return 'SILENT'; }, send: async (_m, text) => sent.push(text) });
    for (let i = 0; i < 10; i++) engine.receive(fakeMessage('group-a', `消息${i}`));
    await tick(100);
    assert.equal(calls, 1);
    assert.deepEqual(sent, []);
    assert.equal(parseSocialDecision('RESPOND: 可以试试').text, '可以试试');
    engine.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('direct mention bypasses batch delay, and a second send respects cooldown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-mention-'));
  try {
    const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
    let calls = 0; const sent = [];
    const engine = new SocialEngine({ buffer, batchMs: 500, minIntervalMs: 60000,
      decide: async () => { calls++; return 'RESPOND: 在'; },
      send: async (_m, text) => sent.push(text) });
    const at = fakeMessage('group-a', '你好');
    at.segments.unshift({ type: 'at', data: { qq: '99' } });
    engine.receive(at);
    await tick(70);
    assert.equal(calls, 1);
    assert.deepEqual(sent, ['在']);
    engine.receive({ ...at, message_id: 'next' });
    await tick(70);
    assert.equal(calls, 1);
    assert.deepEqual(sent, ['在']);
    engine.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('whitelisted private message enters a separate session and replies immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-private-'));
  try {
    const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
    const calls = [], sent = [];
    const engine = new SocialEngine({ buffer, batchMs: 500,
      decide: async (key, prompt) => { calls.push(key); assert.match(prompt, /微信好友私聊/); return 'RESPOND: 你好'; },
      send: async (message, content) => sent.push({ kind: message.kind, content }) });
    engine.receive({ ...fakeMessage('42', '你好'), kind: 'private', conversation_id: '42' });
    await tick(80);
    assert.deepEqual(calls, ['wechat:private:42']);
    assert.deepEqual(sent, [{ kind: 'private', content: '你好' }]);
    engine.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native-session requests contain only unread messages and pass persona as initialization metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-delta-'));
  const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
  const calls = [];
  const engine = new SocialEngine({ buffer, privateMinIntervalMs: 0, roleFor: () => '固定人格哨兵', personaNameFor: () => '测试人格',
    decide: async (key, prompt, metadata) => { calls.push({key,prompt,metadata}); return 'SILENT'; }, send: async () => {} });
  try {
    engine.receive({ ...fakeMessage('42', '第一条'), kind: 'private' }); await tick(40);
    engine.receive({ ...fakeMessage('42', '第二条'), kind: 'private' }); await tick(40);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].prompt, /固定人格哨兵/); assert.doesNotMatch(calls[1].prompt, /第一条/);
    assert.match(calls[1].prompt, /第二条/); assert.equal(calls[1].metadata.persona, '固定人格哨兵');
    assert.equal(calls[1].metadata.personaName, '测试人格'); assert.notEqual(calls[0].metadata.batchId, calls[1].metadata.batchId);
  } finally { engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed sending retries its completed decision without another model request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-send-retry-'));
  const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
  let decisions = 0, sends = 0;
  const engine = new SocialEngine({ buffer, batchMs: 5, privateMinIntervalMs: 0,
    decide: async () => { decisions++; return 'RESPOND: 测试回复'; },
    send: async () => { if (++sends === 1) throw new Error('fixture send failure'); } });
  try {
    engine.receive({ ...fakeMessage('42', '测试消息'), kind: 'private' }); await tick(40);
    const key = 'wechat:private:42'; assert.equal(buffer.unread(key).length, 1);
    engine.replay(key); await tick(50);
    assert.equal(decisions, 1); assert.equal(sends, 2); assert.equal(buffer.unread(key).length, 0);
  } finally { engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buffer does not mark arrivals during an in-flight decision as processed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-race-'));
  try {
    const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const prompts = [];
    const engine = new SocialEngine({ buffer, batchMs: 10,
      decide: async (_key, prompt) => { prompts.push(prompt); await gate; return 'SILENT'; }, send: async () => {} });
    engine.receive(fakeMessage('group-a', '第一条'));
    await tick(35);
    engine.receive(fakeMessage('group-a', '第二条'));
    release();
    await tick(80);
    const rows = buffer.recent('wechat:group:group-a');
    assert.equal(rows[0].processed, true);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /第二条/);
    engine.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reverse OneBot server matches action echo and survives reconnect', async () => {
  const server = new ReverseOneBotServer({ port: 0, timeoutMs: 500 });
  await server.start();
  const url = `ws://127.0.0.1:${server.server.address().port}/ws`;
  const connect = async () => {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    return ws;
  };
  try {
    let ws = await connect();
    ws.addEventListener('message', (event) => {
      const action = JSON.parse(event.data);
      ws.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 42, receipt: 'wechat-server-id' } }));
    });
    const response = await server.action('send_group_msg', { group_id: 1, message: [{ type: 'text', data: { text: 'Hi' } }] });
    assert.equal(response.status, 'ok');
    ws.close(); await tick(30);
    assert.equal(server.connected, false);
    ws = await connect();
    assert.equal(server.connected, true);
    ws.close();
  } finally { await server.stop(); }
});

test('OneBot pending action rejects on timeout and disconnect', async () => {
  const server = new ReverseOneBotServer({ port: 0, timeoutMs: 60 });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.server.address().port}/ws`);
  try {
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    await assert.rejects(server.action('send_group_msg', {}), /timeout/);
    const pending = server.action('send_group_msg', {});
    ws.close();
    await assert.rejects(pending, /disconnected/);
    assert.equal(server.pending.size, 0);
  } finally { await server.stop(); }
});

test('WeChat OneBot adapter ignores self message and accepts text group event', async () => {
  const adapter = new WechatOneBotAdapter({ server: { port: 0 } });
  await adapter.start();
  const url = `ws://127.0.0.1:${adapter.server.server.address().port}/ws`;
  const ws = new WebSocket(url);
  const messages = [];
  adapter.onMessage((message) => messages.push(message));
  try {
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const base = { post_type: 'message', message_type: 'group', group_id: 123,
      group_name: '实验群', self_id: 99, time: Date.now() / 1000,
      message: [{ type: 'text', data: { text: '你好' } }],
      sender: { user_id: 42, nickname: '张三' } };
    ws.send(JSON.stringify({ ...base, user_id: 99 }));
    ws.send(JSON.stringify({ ...base, user_id: 42 }));
    await tick(40);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, '你好');
  } finally { ws.close(); await adapter.stop(); }
});

test('WeChat outgoing fingerprint blocks echoed self text even with a wrong sender id', async () => {
  const adapter = new WechatOneBotAdapter({ server: { port: 0 } });
  await adapter.start();
  const ws = new WebSocket(`ws://127.0.0.1:${adapter.server.server.address().port}/ws`);
  const messages = [];
  adapter.onMessage((message) => messages.push(message));
  try {
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    ws.addEventListener('message', (event) => {
      const action = JSON.parse(event.data);
      ws.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 42, receipt: 'wechat-server-id' } }));
    });
    await adapter.sendText({ kind: 'group', target: 123, text: '我来看看' });
    ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 123,
      self_id: 99, user_id: 42, sender: { user_id: 42, nickname: '未知' },
      message: [{ type: 'text', data: { text: '我来看看' } }] }));
    await tick(30);
    assert.equal(messages.length, 0);
  } finally { ws.close(); await adapter.stop(); }
});

test('failed DSH decision leaves buffered messages unread for replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-replay-'));
  try {
    const buffer = new MessageBuffer(path.join(dir, 'messages.json'));
    let available = false; let calls = 0;
    const engine = new SocialEngine({ buffer, batchMs: 10,
      decide: async () => { calls++; if (!available) throw new Error('plugin offline'); return 'SILENT'; },
      send: async () => {} });
    const key = 'wechat:group:group-a';
    engine.receive(fakeMessage('group-a'));
    await tick(40);
    assert.equal(buffer.unread(key).length, 1);
    available = true;
    engine.replay(key);
    await tick(40);
    assert.equal(calls, 2);
    assert.equal(buffer.unread(key).length, 0);
    engine.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
