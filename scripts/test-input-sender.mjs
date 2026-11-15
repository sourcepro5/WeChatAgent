import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { InputSender, inputSettings, inputAccountProblem, uniqueSearchName, INPUT_BACKEND } from './input-sender.mjs';
import { HookOneBot } from './hook-onebot.mjs';

function fixture(t, input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const config = JSON.parse(fs.readFileSync('config/wechatagent.example.json', 'utf8'));
  config.runtime.sender = INPUT_BACKEND;
  config.wechat.whitelist = { private: ['123'], groups: [] };
  const python = path.join(root, 'python.exe');
  fs.writeFileSync(python, '');
  config.input = { wechatExecutable: path.join(root, 'client', 'Weixin.exe'), python, ...input };
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'state'));
  const write = () => fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify(config));
  write();
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5032', reader_token: 'x' }));
  return { root, config, write };
}

// A child process double: replies with the given worker JSON, or never closes.
function fakeSpawn(replies, seen = []) {
  return (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    let input = '';
    child.stdin = { on() {}, end(text) { input = text; seen.push(JSON.parse(input)); const reply = replies.shift(); if (reply !== 'hang') setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(reply))); child.emit('close', 0); }); } };
    child.kill = () => setImmediate(() => child.emit('close', null));
    return child;
  };
}

test('settings require a clean client path and bound timing values', t => {
  const { root, config } = fixture(t);
  const settings = inputSettings(config, root);
  assert.equal(settings.sendKey, 'enter');
  assert.equal(settings.idleMs, 2000);
  assert.equal(settings.operationTimeoutMs, 20000);
  for (const [patch, code] of [[{ wechatExecutable: undefined }, 'INPUT_CLIENT_REQUIRED'], [{ wechatExecutable: 'C:/x/WeChat.exe' }, 'INPUT_CLIENT_INVALID'],
    [{ sendKey: 'space' }, 'INPUT_SEND_KEY_INVALID'], [{ operationTimeoutMs: 1000 }, 'INPUT_TIMEOUT_INVALID'], [{ idleMs: -1 }, 'INPUT_IDLE_INVALID'], [{ paused: 'yes' }, 'INPUT_PAUSED_INVALID']]) {
    assert.throws(() => inputSettings({ input: { ...config.input, ...patch } }, root), { code }, JSON.stringify(patch));
  }
});

test('an installed workspace can reuse the matched client and bundled foreground runtime', t => {
  const {root, config} = fixture(t);
  const bundled = path.join(root, 'bundled', 'python.exe');
  fs.mkdirSync(path.dirname(bundled));
  fs.writeFileSync(bundled, '');
  fs.writeFileSync(path.join(root, 'config/distribution.json'), JSON.stringify({installed:true, foregroundInputPython:bundled}));
  const explicit = config.input.python;
  config.input = {wechatExecutable:'', python:''};
  assert.equal(inputSettings(config, root).wechatExecutable, path.resolve(root,config.hook.wechatExecutable));
  assert.equal(inputSettings(config, root).python, bundled);
  config.input.python = 'state/input/venv/Scripts/python.exe';
  assert.equal(inputSettings(config, root).python, bundled);
  config.input.python = explicit;
  assert.equal(inputSettings(config, root).python, explicit);
});

test('health is accepted only from a hook-free client with the reader account', () => {
  const ok = { backend: INPUT_BACKEND, integration: 'WeChatAgent-Input-1', ocr: false, hookLoaded: false, databaseAccounts: ['wxid_a_1234'], ready: true };
  assert.equal(inputAccountProblem(ok, 'WXID_A_1234'), '');
  assert.equal(inputAccountProblem({ ...ok, hookLoaded: true }, 'wxid_a_1234'), 'INPUT_CLIENT_HAS_HOOK');
  assert.equal(inputAccountProblem({ ...ok, ocr: true }, 'wxid_a_1234'), 'INPUT_HEALTH_INVALID_RESPONSE');
  assert.equal(inputAccountProblem({ ...ok, databaseAccounts: ['a', 'b'] }, 'a'), 'INPUT_ACCOUNT_UNVERIFIED');
  assert.equal(inputAccountProblem(ok, 'wxid_other'), 'INPUT_ACCOUNT_MISMATCH');
  assert.equal(inputAccountProblem({ ...ok, ready: false }, 'wxid_a_1234'), 'INPUT_WINDOW_NOT_READY');
});

test('a search name must not occur inside any other contact or group name', () => {
  const me = { username: 'wxid_ming', displayName: '小明' };
  assert.equal(uniqueSearchName('小明', 'wxid_ming', [me]), '');
  assert.equal(uniqueSearchName('小明', 'wxid_ming', [me, { username: 'g@chatroom', displayName: '小明同学群' }]), 'INPUT_TARGET_AMBIGUOUS');
  assert.equal(uniqueSearchName('小明', 'wxid_ming', [{ ...me, ambiguous: true }]), 'INPUT_TARGET_AMBIGUOUS');
  assert.equal(uniqueSearchName('小明', 'wxid_ming', [{ username: 'wxid_other', displayName: '小明' }]), 'INPUT_TARGET_AMBIGUOUS');
  assert.equal(uniqueSearchName('Ming', 'wxid_ming', [{ username: 'wxid_ming', displayName: 'Ming' }, { username: 'x', displayName: 'MINGLE' }]), 'INPUT_TARGET_AMBIGUOUS');
  assert.equal(uniqueSearchName('', 'wxid_ming', [me]), 'INPUT_TARGET_NAME_MISSING');
  assert.equal(uniqueSearchName('a\nb', 'wxid_ming', [me]), 'INPUT_TARGET_NAME_MISSING');
  assert.equal(uniqueSearchName('小明', 'wxid_ming', Array(100).fill(me)), 'INPUT_TARGET_AMBIGUOUS');
});

test('worker results map to submit, retry, rejection and receipt-only outcomes', async t => {
  const { root } = fixture(t);
  const seen = [];
  const sender = new InputSender(root, { spawnImpl: fakeSpawn([
    { ok: true, data: { ret: 0, submitted: true } },
    { ok: false, code: 'INPUT_USER_ACTIVE', attempted: false, retryable: true },
    { ok: false, code: 'INPUT_DRAFT_PRESENT', attempted: false },
    { ok: false, code: 'INPUT_SUBMIT_UNCONFIRMED', attempted: true },
    { ok: false, code: 'INPUT_WECHAT_NOT_RUNNING', attempted: false },
  ], seen) });
  assert.deepEqual(await sender.request('text', { text: 'hi' }), { ret: 0, submitted: true });
  assert.equal(seen[0].operation, 'text');
  await assert.rejects(sender.request('text', {}), error => error.message === 'API_HTTP_429' && error.senderCode === 'INPUT_USER_ACTIVE');
  await assert.rejects(sender.request('text', {}), error => error.message === 'API_HTTP_409' && error.senderCode === 'INPUT_DRAFT_PRESENT');
  await assert.rejects(sender.request('text', {}), error => error.message === 'INPUT_SEND_UNCONFIRMED' && error.senderCode === 'INPUT_SUBMIT_UNCONFIRMED');
  await assert.rejects(sender.request('health', {}), { message: 'INPUT_WECHAT_NOT_RUNNING' });
});

test('a timed-out send is never treated as rejected; pause and backend changes block new sends', async t => {
  const f = fixture(t, { operationTimeoutMs: 5000 });
  const sender = new InputSender(f.root, { spawnImpl: fakeSpawn(['hang']) });
  const started = Date.now();
  await assert.rejects(sender.request('text', {}), { message: 'INPUT_SEND_UNCONFIRMED' });
  assert(Date.now() - started >= 5000);
  f.config.input.paused = true; f.write();
  await assert.rejects(sender.request('text', {}), { message: 'API_HTTP_429' });
  f.config.runtime.sender = 'wechat-hook'; f.write();
  await assert.rejects(sender.request('health', {}), { message: 'API_HTTP_409' });
  f.config.runtime.sender = INPUT_BACKEND; f.config.input.paused = false; f.config.input.python = path.join(f.root, 'missing.exe'); f.write();
  await assert.rejects(sender.request('health', {}), { message: 'INPUT_DEPENDENCIES_MISSING' });
});

test('the adapter resolves a unique display name and refuses ambiguous or unsupported sends before the desktop', async t => {
  const { root } = fixture(t);
  const contacts = { '小明': [{ username: 'wxid_ming', displayName: '小明' }], '小红': [{ username: 'wxid_hong', displayName: '小红' }, { username: 'wxid_hong2', displayName: '小红帽' }] };
  const fetchImpl = async url => {
    const target = new URL(url);
    if (target.pathname === '/api/v1/sessions') return Response.json({ sessions: [{ username: 'wxid_ming', displayName: '小明', conversationId: 123 }, { username: 'wxid_hong', displayName: '小红', conversationId: 456 }] });
    if (target.pathname === '/api/v1/contacts') return Response.json({ contacts: contacts[target.searchParams.get('keyword')] ?? [] });
    return new Response('{}', { status: 404 });
  };
  const calls = [];
  const inputSender = { request: async (operation, payload) => { calls.push([operation, payload]); return { ret: 0 }; }, close() {} };
  const adapter = new HookOneBot({ directory: root, fetchImpl, inputSender });
  assert.equal(adapter.senderBackend, INPUT_BACKEND);
  assert.equal(adapter.hook.maxConcurrentSends, 1);
  assert.deepEqual(await adapter.native('/SendTextMsg', { wxidorgid: 'wxid_ming', msg: '你好' }, 'acct'), { ret: 0 });
  assert.deepEqual(calls[0], ['text', { account: 'acct', kind: 'private', target: '123', name: '小明', text: '你好' }]);
  await assert.rejects(adapter.native('/SendTextMsg', { wxidorgid: 'wxid_hong', msg: 'x' }, 'acct'), error => error.message === 'API_HTTP_409' && error.senderCode === 'INPUT_TARGET_AMBIGUOUS');
  await assert.rejects(adapter.native('/SendStickerMsg', { wxidorgid: 'wxid_ming' }, 'acct'), error => error.senderCode === 'INPUT_OPERATION_UNSUPPORTED');
  assert.equal(calls.length, 1);
});
