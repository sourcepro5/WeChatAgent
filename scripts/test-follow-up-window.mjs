import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine, buildSocialPrompt } from '../components/qq-bridge/src/core/social-engine.js';

const KEY = 'wechat:group:1255066135';
const BOT = '99';
const WAKE = ['多尔'];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-follow-up-'));
  t.after(() => {
    assert(dir.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return new MessageBuffer(path.join(dir, 'messages.json'));
}

const message = (sender, text, id) => ({
  platform: 'wechat', kind: 'group', conversation_id: '1255066135', self_id: BOT,
  sender_id: String(sender), sender_name: `成员${sender}`, message_id: id, text,
  timestamp: Date.now() / 1000,
});

function create(t, buffer, options = {}) {
  const decided = [];
  const engine = new SocialEngine({
    buffer, mode: 'mention', modeFor: () => 'mention', wakeWords: WAKE,
    batchMs: 1, minIntervalMs: 0, privateMinIntervalMs: 0, maxPerMinute: 100, maxPerTenMinutes: 100,
    stickerPolicyFor: () => ({ enabled: false }),
    decide: async (_key, prompt) => { decided.push(prompt); return 'SILENT'; },
    send: async () => ({}),
    ...options,
  });
  t.after(() => engine.stop());
  return { engine, decided };
}

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('the member who called it can keep talking without a second @', async (t) => {
  const { engine, decided } = create(t, fixture(t), { followUpMs: 120000 });
  engine.receive(message(1, '多尔 晚上打不打', 'm1'));
  await until(() => decided.length === 1, 'direct dispatch');
  engine.receive(message(1, '那你几点上线', 'm2'));
  await until(() => decided.length === 2, 'follow-up dispatch');
  assert.match(decided[0], /有人直接@你|唤醒词/);
  assert.match(decided[1], /属于同一轮对话的延续/);
  assert.doesNotMatch(decided[1], /有人直接@你或使用唤醒词/);
});

test('a window of 0 keeps mention mode strict', async (t) => {
  const { engine, decided } = create(t, fixture(t), { followUpMs: 0 });
  engine.receive(message(1, '多尔 晚上打不打', 'm1'));
  await until(() => decided.length === 1, 'direct dispatch');
  engine.receive(message(1, '那你几点上线', 'm2'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(decided.length, 1);
});

test('another member in the window does not ride along', async (t) => {
  const { engine, decided } = create(t, fixture(t), { followUpMs: 120000 });
  engine.receive(message(1, '多尔 晚上打不打', 'm1'));
  await until(() => decided.length === 1, 'direct dispatch');
  engine.receive(message(2, '我也想知道几点', 'm2'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(decided.length, 1);
});

test('the window closes once it expires', async (t) => {
  const { engine, decided } = create(t, fixture(t), { followUpMs: 40 });
  engine.receive(message(1, '多尔 晚上打不打', 'm1'));
  await until(() => decided.length === 1, 'direct dispatch');
  await new Promise((resolve) => setTimeout(resolve, 90));
  engine.receive(message(1, '那你几点上线', 'm2'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(decided.length, 1);
});

test('the prompt tells a follow-up apart from a plain batch', () => {
  const rows = [{ sender_name: '华仔', sender_id: '539788581', text: '那你几点上线', timestamp: Date.now() / 1000, conversation_name: '芮宝小窝🐬🇨🇭' }];
  const followUp = buildSocialPrompt({ key: KEY, rows, role: '', direct: false, followUp: true });
  const plain = buildSocialPrompt({ key: KEY, rows, role: '', direct: false, followUp: false });
  assert.match(followUp, /属于同一轮对话的延续/);
  assert.match(plain, /这是一批普通群消息/);
  assert.doesNotMatch(plain, /属于同一轮对话的延续/);
});
