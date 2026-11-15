import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pcmWav, decodeVoice, validateSilk, voicePcm } from './decode-wechat-voice.mjs';
import { HookOneBot } from './hook-onebot.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {configuration, packageFiles, scanPlugins, updatePlugin} from '../packages/plugin-api/catalog.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {createSettingsActionRunner} from './plugin-settings-actions.mjs';
import {ReverseOneBotServer} from '../components/qq-bridge/src/onebot/reverse-ws-server.js';

const token = 'b'.repeat(64);
const account = 'wxid_fixture_1234';
const chat = 'fixture@chatroom';
const target = '123';
const wav = pcmWav(Buffer.alloc(3200));
const route = '/api/voice/send';
const row = (fields = {}) => ({
  localId: 2, localType: 34, isSend: 1, createTime: Math.floor(Date.now() / 1000),
  serverId: '900000000000000001', ...fields,
});

async function fixture(t, { capable = true, receiptTimeoutMs = 30000, loseResponse = false, desktop = false, helper = false, helperFull = false, hookVoice = false, stream = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent-voice-send-'));
  const config = {
    runtime: { sender: 'wechat-hook', weflowMode: 'nt' },
    ports: { adapter: 0 },
    account: {nicknames: ['Fixture']},
    hook: { baseUrl: 'http://127.0.0.1:30001', expectedVersion: '4.2.0.12' },
    wechat: { whitelist: { private: [], groups: [target] } },
  };
  const helperAny = helper || helperFull;
  const filehelperMode = desktop || helperAny;
  const backend = {
    account, readerOwnWxid: 'wxid_fixture', chat: filehelperMode ? 'filehelper' : chat, rows: [], submissions: [], textSubmissions: [], ret: 0, loseVoice: false, dropTextReceipt: false,
    helperAccount: 'wxid_fixture', helperTargets: undefined, helperReceipt: {}, targetRows: new Map(),
    contentReceipt: null, receiptQueries: [], hookVoiceState: 'queued', hookVoiceMapping: {}, hookVoiceTestOnly: false,
  };
  if (desktop) {
    config.runtime.sender = 'wechat-input';
    config.input = { wechatExecutable: path.join(directory, 'Weixin.exe'), voiceSend: true };
  }
  if (filehelperMode) config.wechat.whitelist = { private: [target, '124'], groups: [] };
  if (helperAny) config.helperVoice = { port: 30001 };
  if (helperFull) config.runtime.sender = 'wechat-helper';
  for (const folder of ['config', 'state/hook']) fs.mkdirSync(path.join(directory, folder), { recursive: true });
  fs.writeFileSync(path.join(directory, 'state/wechat-io-config.json'), JSON.stringify({
    reader_base_url: 'http://127.0.0.1:5031', reader_token: 'reader-token',
  }));
  fs.writeFileSync(path.join(directory, 'state/hook/native-token.txt'), 'a'.repeat(64));
  if (helperAny) {
    fs.unlinkSync(path.join(directory, 'state/hook/native-token.txt'));
    fs.writeFileSync(path.join(directory, 'state/helper-voice.token'), 'a'.repeat(64));
  }
  const tokenFile = path.join(directory, 'state/voice-send.token');
  fs.writeFileSync(tokenFile, token);
  const saveConfig = () => fs.writeFileSync(path.join(directory, 'config/wechatagent.json'), JSON.stringify(config));
  saveConfig();
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const native = url.port === '30001';
    assert.equal(options.headers.Authorization, 'Bearer ' + (native ? 'a'.repeat(64) : 'reader-token'));
    if (url.pathname === '/api/v1/reader/status') {
      return Response.json({ backend: 'weflow-cli-nt', ownWxid: backend.readerOwnWxid, accountDirectory: backend.account });
    }
    if (url.pathname === '/api/v1/push/messages') {
      return new Response(new ReadableStream({
        start(controller) {
          backend.emitVoice = payload => controller.enqueue(Buffer.from('data: ' + JSON.stringify(payload) + '\n\n'));
          options.signal.addEventListener('abort', () => controller.close(), {once: true});
        },
      }), {headers: {'Content-Type': 'text/event-stream'}});
    }
    if (url.pathname.startsWith('/api/v1/voices/')) {
      backend.audioReads = (backend.audioReads ?? 0) + 1;
      return Response.json({id: url.pathname.split('/').at(-1), conversationKey: url.searchParams.get('conversationKey'),
        b64: wav.toString('base64'), sha256: crypto.createHash('sha256').update(wav).digest('hex'),
        mime: 'audio/wav', filename: 'voice.wav', durationSeconds: 0.1});
    }
    if (url.pathname === '/WeChatAgent/health') {
      if (helperAny) return Response.json({
        integration: 'WeChatAgent-Helper-Voice-1', version: '4.2.0.12',
        nativeVoiceSend: capable, account: backend.helperAccount, voiceTargets: backend.helperTargets,
        ...(helperFull ? { nativeTextSend: true } : {}),
      });
      return Response.json({
        backend: 'wechat-hook', integration: 'WeChatAgent-1', version: '4.2.0.12',
        profile: '4.2.0.12-stickers-v2', nativeTextSend: true, nativeStickerSend: true,
        nativeVoiceSend: capable, databaseAccounts: [backend.account],
        ...(hookVoice ? {nativeVoiceProtocol: 'silk-receipt-v1', nativeVoiceTestOnly: backend.hookVoiceTestOnly} : {}),
      });
    }
    if (url.pathname === '/api/v1/sessions') return Response.json({ sessions: [
      { username: backend.chat, conversationId: target, displayName: filehelperMode ? '文件传输助手' : 'fixture' },
      ...(filehelperMode ? [{ username: 'wxid_other', conversationId: '124' }] : []),
      ...(helperAny ? [{ username: chat, conversationId: '125' }] : []),
    ] });
    if (desktop && url.pathname === '/api/v1/contacts') {
      return Response.json({ contacts: [{ username: 'filehelper', displayName: '文件传输助手' }] });
    }
    if (url.pathname === '/api/v1/messages') {
      const talker = url.searchParams.get('talker');
      if (talker === backend.chat) return Response.json({ messages: backend.rows });
      assert(helperAny && ['wxid_other', chat].includes(talker));
      return Response.json({ messages: backend.targetRows.get(talker) ?? [] });
    }
    if (url.pathname === '/api/v1/outgoing-voice-receipt') {
      backend.receiptQueries.push(url.searchParams);
      const match = backend.contentReceipt?.(url.searchParams) ?? null;
      return Response.json({ success: true, match });
    }
    assert.equal(options.headers['X-WeChatAgent-Account'], helperAny ? backend.helperAccount : backend.account);
    if (url.pathname === '/SendTextMsg') {
      const body = JSON.parse(options.body);
      backend.textSubmissions.push(body);
      if (helperFull) assert.match(body.operationId, /^[a-f0-9]{64}$/);
      if (!backend.dropTextReceipt) {
        // The NT reader later shows the sent text with a server ID.
        const talker = body.wxidorgid, rows = talker === backend.chat ? backend.rows : backend.targetRows.get(talker) ?? [];
        rows.push({ localId: 100 + backend.textSubmissions.length, localType: 1, isSend: 1, createTime: Math.floor(Date.now() / 1000),
          serverId: '91000000000000000' + backend.textSubmissions.length, content: body.msg });
        if (talker !== backend.chat) backend.targetRows.set(talker, rows);
      }
      return Response.json({ ret: 0, ...(helperFull ? { operationId: body.operationId, state: 'accepted', target: body.wxidorgid } : {}) });
    }
    if (url.pathname === '/SendVoiceMsg') {
      backend.submissions.push(JSON.parse(options.body));
      if (hookVoice) assert.equal(backend.submissions.at(-1).accountWxid, 'wxid_fixture');
      if (loseResponse || backend.loseVoice) throw new TypeError('fixture lost submit response');
      if (helperAny) {
        const { operationId, wxidorgid } = backend.submissions.at(-1);
        return Response.json({ operationId, state: 'accepted', target: backend.helperTargets && wxidorgid });
      }
      if (hookVoice) {
        const {operationId, wxidorgid} = backend.submissions.at(-1);
        return Response.json({ret: 0, operationId, target: wxidorgid, state: 'queued'});
      }
      return Response.json({ ret: backend.ret, localId: 2 });
    }
    const receipt = backend.submissions.find(item => url.pathname === '/WeChatAgent/voice-deliveries/' + item.operationId);
    if (receipt) {
      if (helperAny) return Response.json({
        operationId: receipt.operationId, state: 'accepted',
        target: backend.helperTargets && receipt.wxidorgid, ...backend.helperReceipt,
      });
      if (hookVoice) return Response.json({
        ret: backend.hookVoiceState === 'rejected' ? 1 : 0,
        operationId: receipt.operationId, target: receipt.wxidorgid, state: backend.hookVoiceState,
        ...backend.hookVoiceMapping,
      });
      return Response.json({ operationId: receipt.operationId, localId: 2 });
    }
    assert.fail('Unexpected adapter route ' + url.pathname);
  };
  let adapter;
  const restart = async () => {
    if (adapter) await adapter.stop();
    const inputSender = desktop ? {
      async request(operation, payload) {
        if (operation === 'health') return {
          backend: 'wechat-input', integration: 'WeChatAgent-Input-1', ocr: false, hookLoaded: false,
          version: '4.2.0.12', databaseAccounts: [backend.account], ready: true, voiceSend: capable,
        };
        assert.equal(operation, 'voice');
        backend.submissions.push(payload);
        return { ret: 0, submitted: true };
      },
      close() {},
    } : undefined;
    adapter = new HookOneBot({ directory, fetchImpl, receiptTimeoutMs, inputSender, helperVoiceOnly: helper });
    adapter.connectOneBot = async () => { if (helper) assert.fail('voice-only mode must not start OneBot'); };
    if (!stream) adapter.receiveSse = async () => {};
    await adapter.start();
  };
  t.after(async () => {
    if (adapter?.server?.listening) await adapter.stop();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await restart();
  const call = async (url, { auth = token, body } = {}) => {
    const response = await fetch('http://127.0.0.1:' + adapter.server.address().port + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { http: response.status, body: await response.json() };
  };
  const submit = (overrides = {}, options) => call(route, { ...options, body: {
    deliveryId: 'fixture-id', conversationKey: 'wechat:' + (filehelperMode ? 'private:' : 'group:') + target,
    wavBase64: wav.toString('base64'), ...overrides,
  } });
  return { backend, config, saveConfig, restart, submit, call, directory, tokenFile,
    status: (id = 'fixture-id') => call(route + '/' + id), adapter: () => adapter };
}

test('the loopback voice route requires its own token, a whitelisted target and a capable backend', async t => {
  const f = await fixture(t, { capable: false });
  fs.unlinkSync(f.tokenFile);
  assert.deepEqual(await f.submit(), { http: 401, body: { error: 'VOICE_UNAUTHORIZED' } });
  fs.writeFileSync(f.tokenFile, token);
  assert.equal((await f.submit({}, { auth: 'a'.repeat(64) })).http, 401);
  assert.deepEqual(await f.submit({ conversationKey: 'wechat:group:456' }), {
    http: 403, body: { error: 'VOICE_CONVERSATION_NOT_ALLOWED' },
  });
  assert.deepEqual(await f.submit(), { http: 501, body: { error: 'VOICE_UNSUPPORTED' } });
  assert.equal(f.backend.submissions.length, 0);
});

test('only a unique outgoing type-34 row with a server receipt confirms a SILK delivery', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit({ wavBase64: 'AAAA' })).body.error, 'VOICE_INVALID_WAV');
  assert.equal((await f.submit({ wavBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') })).http, 413);
  assert.equal((await f.submit()).http, 202);
  const [submission] = f.backend.submissions;
  assert.equal(submission.wxidorgid, chat);
  assert.equal(submission.durationMs, 100);
  assert.equal((await decodeVoice(Buffer.from(submission.silkBase64, 'base64'))).durationSeconds, 0.1);
  for (const rows of [[row({ localType: 49 })], [row({ isSend: 0 })], [row({ serverId: '0' })],
    [row({ localId: 3 })], [row(), row()]]) {
    f.backend.rows = rows;
    assert.equal((await f.status()).body.status, 'pending');
  }
  f.backend.rows = [row()];
  const confirmed = await f.status();
  assert.deepEqual(confirmed, { http: 200, body: {
    status: 'confirmed', deliveryId: 'fixture-id', durationMs: 100, messageId: '2', receipt: 'wechat-server-id',
  } });
  assert.deepEqual(await f.submit(), confirmed);
  const different = Buffer.from(wav);
  different[44] = 1;
  assert.equal((await f.submit({ wavBase64: different.toString('base64') })).body.error, 'VOICE_DELIVERY_ID_CONFLICT');
  assert.equal(f.backend.submissions.length, 1);
});

test('a lost submission response survives restart and recovers a late receipt without resending', async t => {
  const f = await fixture(t, { loseResponse: true, receiptTimeoutMs: 0 });
  assert.equal((await f.submit()).body.status, 'unconfirmed');
  await f.restart();
  assert.equal((await f.submit()).body.status, 'unconfirmed');
  f.backend.rows = [row()];
  assert.equal((await f.status()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('the 4.2 Hook accepts a suffixed reader account and recovers its SILK receipt', async t => {
  const f = await fixture(t, {hookVoice: true, loseResponse: true});
  f.backend.readerOwnWxid = account;
  f.backend.rows = [row({localId: 1, serverId: '900000000000000000'})];
  assert.equal((await f.submit()).body.status, 'pending');
  assert.equal(f.backend.submissions[0].accountWxid, 'wxid_fixture');
  await f.restart();
  assert.equal((await f.status()).body.submitted, undefined);
  assert.equal(f.backend.receiptQueries.length, 0);
  f.backend.hookVoiceState = 'accepted';
  f.backend.hookVoiceMapping = {target: 'other@chatroom'};
  assert.equal((await f.status()).body.submitted, undefined);
  assert.equal(f.backend.receiptQueries.length, 0);
  f.backend.hookVoiceMapping = {};
  const silk = Buffer.from(f.backend.submissions[0].silkBase64, 'base64');
  const {start, end} = validateSilk(silk);
  f.backend.contentReceipt = query => {
    assert.equal(query.get('talker'), chat);
    assert.equal(query.get('account'), account);
    assert.equal(query.get('baseline'), '1');
    assert.equal(query.get('digest'), crypto.createHash('sha256').update(silk.subarray(start, end)).digest('hex'));
    return row({createTime: Number(query.get('after'))});
  };
  assert.deepEqual((await f.status()).body, {
    deliveryId: 'fixture-id', durationMs: 100, status: 'confirmed', messageId: '2',
    serverMessageId: '900000000000000001', receipt: 'wechat-server-id', receiptSource: 'silk-sha256',
  });
  assert.equal((await f.submit()).body.status, 'confirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('the 4.2 Hook never resubmits an operation after queue rejection', async t => {
  const f = await fixture(t, {hookVoice: true});
  assert.equal((await f.submit()).body.status, 'pending');
  f.backend.hookVoiceState = 'uncertain';
  assert.equal((await f.status()).body.status, 'pending');
  f.backend.hookVoiceState = 'rejected';
  assert.equal((await f.status()).body.status, 'rejected');
  assert.equal((await f.submit()).body.status, 'rejected');
  assert.equal(f.backend.receiptQueries.length, 0);
  assert.equal(f.backend.submissions.length, 1);
});

test('the opt-in 4.2 voice candidate rejects other chats before submission', async t => {
  const f = await fixture(t, {hookVoice: true});
  f.backend.hookVoiceTestOnly = true;
  assert.deepEqual(await f.submit(), {http: 403, body: {error: 'VOICE_HOOK_TARGET_NOT_ALLOWED'}});
  assert.equal(f.backend.submissions.length, 0);
});

test('an existing type-34 row and changes to authorization cannot confirm a delivery', async t => {
  const f = await fixture(t);
  f.backend.rows = [row()];
  await f.submit();
  assert.equal((await f.status()).body.status, 'pending');
  f.backend.account = 'wxid_other_1234';
  assert.equal((await f.status()).body.error, 'VOICE_ACCOUNT_OR_TARGET_CHANGED');
  f.backend.account = account;
  f.backend.chat = 'different@chatroom';
  assert.equal((await f.status()).body.error, 'VOICE_ACCOUNT_OR_TARGET_CHANGED');
  f.config.wechat.whitelist.groups = [];
  f.saveConfig();
  assert.equal((await f.status()).body.error, 'VOICE_CONVERSATION_NOT_ALLOWED');
  assert.equal(f.backend.submissions.length, 1);
});

test('a definite backend rejection persists and is never resubmitted', async t => {
  const f = await fixture(t);
  f.backend.ret = 7;
  assert.equal((await f.submit()).body.status, 'rejected');
  await f.restart();
  assert.equal((await f.submit()).body.status, 'rejected');
  assert.equal(f.backend.submissions.length, 1);
});

test('the desktop path sends only filehelper PCM and leaves an uncorrelated receipt unconfirmed', async t => {
  const f = await fixture(t, { desktop: true });
  assert.deepEqual(await f.submit({ conversationKey: 'wechat:private:124' }), {
    http: 403, body: { error: 'VOICE_FILEHELPER_ONLY' },
  });
  assert.equal((await f.submit()).body.status, 'unconfirmed');
  const [submission] = f.backend.submissions;
  assert.equal(submission.wxid, 'filehelper');
  assert.deepEqual(Buffer.from(submission.pcmBase64, 'base64'), wav.subarray(44));
  await f.restart();
  f.backend.rows = [row()];
  assert.equal((await f.submit()).body.status, 'unconfirmed');
  assert.equal(f.backend.submissions.length, 1);
});

test('Helper voice-only mode recovers acceptance and blocks account changes without a native Hook', async t => {
  const f = await fixture(t, { helper: true, loseResponse: true, receiptTimeoutMs: 0 });
  assert.equal((await f.submit({ conversationKey: 'wechat:private:124' })).body.error, 'VOICE_HELPER_TARGET_NOT_ALLOWED');
  f.backend.helperAccount = 'wxid_other';
  assert.equal((await f.submit()).http, 503);
  assert.equal(f.backend.submissions.length, 0);
  f.backend.helperAccount = 'wxid_fixture';
  assert.deepEqual((await f.submit()).body, { deliveryId: 'fixture-id', durationMs: 100, status: 'unconfirmed' });
  assert.equal((await decodeVoice(Buffer.from(f.backend.submissions[0].silkBase64, 'base64'))).durationSeconds, 0.1);
  await f.restart();
  f.backend.rows = [row()];
  assert.deepEqual((await f.status()).body, {
    deliveryId: 'fixture-id', durationMs: 100, status: 'unconfirmed', submitted: true,
  });
  assert.equal((await f.submit()).body.submitted, true);
  assert.equal(f.backend.submissions.length, 1);
});

test('Helper sends to the permitted private and group chat and confirms only an exact target receipt', async t => {
  const f = await fixture(t, { helper: true });
  const friend = { conversationKey: 'wechat:private:124', deliveryId: 'friend-voice' };
  const group = { conversationKey: 'wechat:group:125', deliveryId: 'group-voice' };
  f.backend.helperTargets = ['filehelper', chat];
  assert.equal((await f.submit(friend)).body.error, 'VOICE_HELPER_TARGET_NOT_ALLOWED');
  assert.equal((await f.submit(group)).body.error, 'VOICE_CONVERSATION_NOT_ALLOWED');
  assert.deepEqual(f.backend.submissions, []);

  f.backend.helperTargets.push('wxid_other');
  f.config.wechat.whitelist.groups.push('125');
  f.saveConfig();
  for (const request of [friend, group]) assert.equal((await f.submit(request)).body.submitted, true);
  assert.deepEqual(f.backend.submissions.map(item => item.wxidorgid), ['wxid_other', chat]);
  assert.equal((await f.submit({ ...group, deliveryId: friend.deliveryId })).body.error, 'VOICE_DELIVERY_ID_CONFLICT');

  f.backend.targetRows.set('wxid_other', [row()]);
  f.backend.helperReceipt = { target: chat, localId: 2 };
  assert.equal((await f.status(friend.deliveryId)).body.status, 'pending');
  f.backend.helperReceipt = { localId: 2 };
  assert.equal((await f.status(friend.deliveryId)).body.status, 'confirmed');
  f.backend.targetRows.set(chat, [row({ serverId: '0' })]);
  assert.equal((await f.status(group.deliveryId)).body.status, 'pending');
  f.backend.targetRows.set(chat, [row()]);
  assert.equal((await f.status(group.deliveryId)).body.status, 'confirmed');
  f.backend.helperTargets = ['filehelper', 'wxid_other'];
  assert.equal((await f.status(group.deliveryId)).body.error, 'VOICE_HELPER_TARGET_NOT_ALLOWED');
  assert.equal(f.backend.submissions.length, 2);
});

test('Helper voice receipts can be recovered by a unique SILK digest after restart', async t => {
  const f = await fixture(t, { helper: true, loseResponse: true });
  f.backend.rows = [row({ localId: 1, serverId: '900000000000000000' })];
  await f.submit();
  await f.restart();
  const silk = Buffer.from(f.backend.submissions[0].silkBase64, 'base64');
  const { start, end } = validateSilk(silk);
  const digest = crypto.createHash('sha256').update(silk.subarray(start, end)).digest('hex');
  f.backend.contentReceipt = query => {
    assert.equal(query.get('talker'), 'filehelper');
    assert.equal(query.get('account'), 'wxid_fixture');
    assert.equal(query.get('baseline'), '1');
    assert.equal(query.get('digest'), digest);
    return row({ localId: 1, createTime: Number(query.get('after')) });
  };
  assert.equal((await f.status()).body.status, 'pending');
  assert.equal(f.backend.receiptQueries.length, 1);
  f.backend.contentReceipt = query => row({ createTime: Number(query.get('after')) });
  assert.deepEqual((await f.status()).body, {
    deliveryId: 'fixture-id', durationMs: 100, status: 'confirmed', messageId: '2',
    serverMessageId: '900000000000000001', receipt: 'wechat-server-id', receiptSource: 'silk-sha256',
  });
  assert.equal(f.backend.submissions.length, 1);
  f.backend.rows = [row()];
  await f.submit({ deliveryId: 'new-same-voice' });
  f.backend.contentReceipt = query => {
    assert.equal(query.get('baseline'), '2');
    return row({ localId: 3, createTime: Number(query.get('after')) });
  };
  assert.equal((await f.status('new-same-voice')).body.status, 'pending');
  f.backend.contentReceipt = query => row({
    localId: 3, serverId: '900000000000000002', createTime: Number(query.get('after')),
  });
  assert.equal((await f.status('new-same-voice')).body.messageId, '3');
  assert.equal((await f.status()).body.messageId, '2');
  assert.equal(f.backend.submissions.length, 2);
});

test('identical audio submitted more than once in a chat cannot confirm by content alone', async t => {
  const f = await fixture(t, { helper: true });
  await f.submit();
  await f.submit({ deliveryId: 'repeat-voice' });
  await f.restart();
  f.backend.contentReceipt = query => row({ createTime: Number(query.get('after')) });
  for (const id of ['fixture-id', 'repeat-voice']) assert.equal((await f.status(id)).body.status, 'pending');
  assert.equal(f.backend.receiptQueries.length, 0);
  assert.equal(f.backend.submissions.length, 2);
});

test('the installed TTS plugin tests settings and submits normalized speech once per delivery', async t => {
  const f = await fixture(t, {helper: true});
  const calls = [];
  const providerWav = pcmWav(Buffer.alloc(24000 * 2 * 9));
  providerWav.writeUInt32LE(24000, 24);
  providerWav.writeUInt32LE(48000, 28);
  let providerStatus = 200, revoke;
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const transcribing = req.url.endsWith('/audio/transcriptions');
    calls.push({url: req.url, authorization: req.headers.authorization, body: body && !transcribing ? JSON.parse(body) : null});
    if (transcribing) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({text: '转写测试通过。'}));
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({data: [{id: 'team/tts'}, {id: 'fixture-key'}]}));
    }
    revoke?.();
    res.writeHead(providerStatus, {'Content-Type': 'application/octet-stream'});
    res.end(providerWav);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  const ticket = installer.inspect({name: 'speech-synthesis.zip', zip: packZip(packageFiles(source)).toString('base64')});
  installer.install(ticket);
  const settings = {
    endpoint: 'http://127.0.0.1:' + provider.address().port + '/tenant/v1/audio/speech',
    apiKey: 'fixture-key', model: 'team/tts', voice: 'fixture-voice', recognitionModel: 'team/asr',
  };
  const set = (enabled, chats = ['wechat:private:123']) => updatePlugin(f.directory, 'speech-synthesis', {
    revision: configuration(f.directory).revision, enabled, chats, settings, permissions: ['audio_read', 'audio_synthesize'],
  });
  const text = {conversationKey: 'wechat:private:123', deliveryId: 'text-tts', text: '测试后台发送。'};
  const send = overrides => f.call('/api/voice/send-text', {body: {...text, ...overrides}});
  assert.equal((await send()).body.error, 'VOICE_TTS_PLUGIN_DISABLED');
  assert.equal(calls.length, 0);
  set(false);
  const runner = createSettingsActionRunner({root: f.directory, describe: () => ({ui: {settings: {actions: ['models', 'check', 'check-input']}}})});
  t.after(() => runner.close());
  const packageRevision = scanPlugins(f.directory).find(item => item.id === 'speech-synthesis').revision;
  const args = {packageRevision, args: {settings: {apiKey: ''}}};
  assert.deepEqual(await runner.run('speech-synthesis', 'models', {packageRevision, args: {settings: {apiKey: ''}, capability: 'tts'}}), {ok: true, models: ['team/tts']});
  const testAudio = await runner.run('speech-synthesis', 'check', args);
  assert.equal(testAudio.ok, true);
  assert.equal(testAudio.durationMs, 9000);
  // Since 1.3.0 the settings preview is 8 kHz 8-bit, at most 5 s, to fit the action result.
  const preview = Buffer.from(testAudio.preview, 'base64');
  assert.deepEqual([preview.readUInt32LE(24), preview.readUInt16LE(34), preview.readUInt32LE(40)], [8000, 8, 40000]);
  assert.equal(testAudio.clipped, true);
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(calls[0].url, '/tenant/v1/models');
  assert.equal(calls[1].body.input, '你好，这是一段语音测试。');

  set(true);
  const submitted = await send();
  assert.equal(submitted.http, 202);
  assert.equal(submitted.body.submitted, true);
  assert.deepEqual(calls[2], {
    url: '/tenant/v1/audio/speech', authorization: 'Bearer fixture-key',
    body: {model: 'team/tts', voice: 'fixture-voice', input: text.text, response_format: 'wav'},
  });
  const {silkBase64} = f.backend.submissions[0];
  assert.equal((await decodeVoice(Buffer.from(silkBase64, 'base64'))).durationSeconds, 9);
  await f.restart();
  assert.equal((await send()).body.submitted, true);
  assert.equal((await send({text: '另一段文字'})).body.error, 'VOICE_DELIVERY_ID_CONFLICT');
  assert.equal(calls.length, 3);
  assert.equal(f.backend.submissions.length, 1);

  providerStatus = 401;
  assert.equal((await send({deliveryId: 'failed-tts'})).body.error, 'VOICE_TTS_AUTH');
  assert.equal((await send({deliveryId: 'failed-tts'})).body.status, 'rejected');
  assert.equal(calls.length, 4);
  providerStatus = 200;
  revoke = () => set(false);
  assert.equal((await send({deliveryId: 'revoked-tts'})).body.error, 'VOICE_TTS_PERMISSION_CHANGED');
  assert.equal(f.backend.submissions.length, 1);
  assert.deepEqual(await runner.run('speech-synthesis', 'check-input', {packageRevision, args: {settings: {apiKey: ''}, method: 'file'}}),
    {ok: true, method: 'file', text: '转写测试通过。', partials: []});
  assert.equal(calls.at(-1).url, '/tenant/v1/audio/transcriptions');
});

test('1.6.0 capabilities: TTS and single-file recognition use their own services and keys; WeChat gets one native voice', async t => {
  const f = await fixture(t, {helper: true});
  const calls = [];
  const providerWav = pcmWav(Buffer.alloc(16000 * 2, 4));
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({url: req.url, authorization: req.headers.authorization});
    if (req.url.startsWith('/asr/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({text: '单条识别通过。'}));
    }
    res.writeHead(200, {'Content-Type': 'audio/wav'});
    res.end(providerWav);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const origin = 'http://127.0.0.1:' + provider.address().port;
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  installer.install(installer.inspect({name: 'speech-synthesis.zip', zip: packZip(packageFiles(source)).toString('base64')}));
  const slot = (entry, method, profile) => ({entry, method, profiles: {[entry + '/' + method]: profile}});
  // Realtime recognition is configured too, at an address that is never contacted.
  const services = {version: 2, recognition: 'file', reply: 'dsh',
    tts: slot('custom', 'speech', {name: 'tts', endpoint: origin + '/tts/v1', auth: 'bearer', model: 'team/tts', voice: 'v1', speed: 1}),
    realtimeAsr: slot('custom', 'asr', {endpoint: 'ws://127.0.0.1:9/never', auth: 'none', model: 'qwen3-asr-flash-realtime'}),
    fileAsr: slot('custom', 'transcriptions', {endpoint: origin + '/asr/v1', auth: 'bearer', model: 'team/asr'}),
    owners: {tts: {entry: 'custom', origins: [origin]}, realtimeAsr: null, fileAsr: {entry: 'custom', origins: [origin]}}, legacy: null};
  updatePlugin(f.directory, 'speech-synthesis', {revision: configuration(f.directory).revision, enabled: true, chats: ['wechat:private:123'],
    permissions: ['audio_read', 'audio_synthesize'],
    settings: {voiceMode: 'separate', recognitionModel: 'team/asr', services, ttsKey: 'tts-key', fileAsrKey: 'asr-key'}});
  const submitted = await f.call('/api/voice/send-text', {body: {conversationKey: 'wechat:private:123', deliveryId: 'v16-tts', text: 'DSH 选择了语音回复。'}});
  assert.equal(submitted.http, 202);
  assert.equal(submitted.body.submitted, true);
  assert.deepEqual(calls, [{url: '/tts/v1/audio/speech', authorization: 'Bearer tts-key'}]);
  assert.equal(f.backend.submissions.length, 1);
  assert.equal((await decodeVoice(Buffer.from(f.backend.submissions[0].silkBase64, 'base64'))).durationSeconds, 1);
  const runner = createSettingsActionRunner({root: f.directory, describe: () => ({ui: {settings: {actions: ['check-input', 'credentials']}}})});
  t.after(() => runner.close());
  const packageRevision = scanPlugins(f.directory).find(item => item.id === 'speech-synthesis').revision;
  const draft = {voiceMode: 'separate', recognitionModel: 'team/asr', services, ttsKey: '', fileAsrKey: ''};
  assert.deepEqual(await runner.run('speech-synthesis', 'check-input', {packageRevision, args: {settings: draft, method: 'file'}}),
    {ok: true, method: 'file', text: '单条识别通过。', partials: []});
  assert.deepEqual(calls.at(-1), {url: '/asr/v1/audio/transcriptions', authorization: 'Bearer asr-key'});
  const sources = await runner.run('speech-synthesis', 'credentials', {packageRevision, args: {settings: draft}});
  assert.deepEqual(sources, {ok: true, sources: {tts: 'tts', realtimeAsr: 'none', fileAsr: 'fileAsr'}});
  assert(!JSON.stringify(sources).includes('tts-key'));
});

// ---- Realtime reply choice (voice-dialogue-v1) through the full Helper backend ----

// A Realtime provider on a real WebSocket. `choices` are answered in order to
// the text-only decision responses; audio responses read the last choice.
async function realtimeProvider(t, choices, {audioStatus = () => 'completed', onAudio} = {}) {
  const provider = new ReverseOneBotServer({port: 0, path: '/tenant/v1/realtime?model=realtime-fixture', token: 'fixture-key'});
  await provider.start();
  t.after(() => provider.stop());
  const events = [];
  let last;
  function sendEvent(event) {
    const body = Buffer.from(JSON.stringify(event));
    const header = body.length < 126 ? Buffer.from([129, body.length])
      : body.length < 65536 ? Buffer.from([129, 126, body.length >> 8, body.length & 255])
        : Buffer.concat([Buffer.from([129, 127, 0, 0, 0, 0]), Buffer.from([body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255])]);
    provider.socket.write(Buffer.concat([header, body]));
  }
  provider.on('event', event => {
    events.push(event);
    if (event.type === 'session.update') sendEvent({type: 'session.updated'});
    if (event.type === 'input_audio_buffer.commit') sendEvent({type: 'input_audio_buffer.committed'});
    if (event.type !== 'response.create') return;
    const id = 'r' + events.length;
    sendEvent({type: 'response.created', response: {id}});
    if (event.response?.output_modalities?.[0] === 'text') {
      const next = choices.shift();
      last = next;
      const raw = typeof next === 'string' ? next : JSON.stringify(next);
      sendEvent({type: 'response.output_text.delta', response_id: id, delta: raw});
      sendEvent({type: 'response.output_text.done', response_id: id, text: raw});
      sendEvent({type: 'response.done', response: {id, status: 'completed'}});
      return;
    }
    onAudio?.();
    // Segmented audio: two chunks of 50 ms at 24 kHz.
    for (let index = 0; index < 2; index++) sendEvent({type: 'response.output_audio.delta', response_id: id, delta: Buffer.alloc(2400).toString('base64')});
    sendEvent({type: 'response.output_audio_transcript.done', response_id: id, transcript: last?.text ?? ''});
    sendEvent({type: 'response.done', response: {id, status: audioStatus()}});
  });
  return {provider, events};
}

async function realtimeFixture(t, choices, providerOptions) {
  const f = await fixture(t, {helperFull: true, stream: true, receiptTimeoutMs: 1500});
  f.backend.helperTargets = ['wxid_other'];
  const {provider, events} = await realtimeProvider(t, choices, providerOptions);
  const installer = new PluginInstaller(f.directory);
  t.after(() => installer.dispose());
  const source = path.join(import.meta.dirname, '..', 'optional-extensions', 'speech-synthesis');
  installer.install(installer.inspect({name: 'speech-dialogue.zip', zip: packZip(packageFiles(source)).toString('base64')}));
  updatePlugin(f.directory, 'speech-synthesis', {
    revision: configuration(f.directory).revision, enabled: true, chats: ['wechat:private:124'],
    permissions: ['audio_read', 'audio_synthesize'],
    settings: {voiceMode: 'realtime', realtimeEndpoint: 'ws://127.0.0.1:' + provider.server.address().port + '/tenant/v1/realtime',
      apiKey: 'fixture-key', realtimeModel: 'realtime-fixture', voice: 'fixture-voice'},
  });
  // Voice receipts: the reader reports a unique outgoing voice for the submitted SILK.
  f.backend.contentReceipt = query => row({localId: 50, createTime: Number(query.get('after')), serverId: '920000000000000001'});
  f.backend.targetRows.set('wxid_other', []);
  const textEvent = (rawid, content) => ({event: 'message.new', type: 1, rawid, sessionId: 'wxid_other', talkerId: 'wxid_other', conversationId: '124', content});
  const voiceEvent = id => ({event: 'message.new', type: 34, rawid: 'v' + id.slice(0, 6), sessionId: 'wxid_other', talkerId: 'wxid_other',
    conversationId: '124', content: '[语音]', voice: {id, durationSeconds: 0.1}});
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    await f.adapter().realtimeQueue;
  };
  const records = () => fs.readdirSync(path.join(f.directory, 'state/realtime-replies')).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(f.directory, 'state/realtime-replies', name), 'utf8')));
  return {...f, events, textEvent, voiceEvent, settle, records};
}

async function until(check, label = 'condition') {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert(Date.now() < deadline, label + ' timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('Realtime chooses per turn: text in -> one voice, voice in -> one text, duplicates and restarts send nothing more', async t => {
  const f = await realtimeFixture(t, [
    {mode: 'voice', text: '好，我给你念一遍。'},
    {mode: 'text', text: '这是你要复制的命令：ls -la'},
  ]);
  const asked = f.textEvent('1001', '用语音回答：你好吗？');
  f.backend.emitVoice(asked);
  await until(() => f.backend.submissions.length === 1, 'voice submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 0);
  const decide = f.events.find(event => event.type === 'session.update').session;
  assert.deepEqual(decide.output_modalities, ['text']);
  assert.match(decide.instructions, /本轮可以回复文字（text）或语音（voice）/);
  assert.equal(f.events.find(event => event.type === 'conversation.item.create').item.content[0].text, '用语音回答：你好吗？');
  assert.equal(f.backend.submissions[0].wxidorgid, 'wxid_other');

  const spoken = f.voiceEvent('d'.repeat(64));
  f.backend.emitVoice(spoken);
  await until(() => f.backend.textSubmissions.length === 1, 'text submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions[0].msg, '这是你要复制的命令：ls -la');
  assert.equal(f.backend.submissions.length, 1);
  await until(() => f.records().every(record => record.stage === 'sent'), 'records sent');
  assert.deepEqual(f.records().map(record => [record.input, record.mode]).sort(), [['text', 'voice'], ['voice', 'text']]);
  assert.equal(f.records().find(record => record.mode === 'text').textStatus, 'confirmed');

  // Duplicate events, then a restart with the same events: nothing is sent again.
  f.backend.emitVoice(asked);
  f.backend.emitVoice(spoken);
  await f.settle();
  await f.restart();
  f.backend.emitVoice(asked);
  f.backend.emitVoice(spoken);
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [1, 1]);
  assert.equal(f.events.filter(event => event.type === 'session.update').length, 2);
});

test('an invalid choice ends the turn; a definite synthesis failure sends the chosen text once', async t => {
  let audioStatus = 'incomplete';
  const f = await realtimeFixture(t, ['我就直接说吧', {mode: 'voice', text: '语音没生成，改回文字。'}], {audioStatus: () => audioStatus});
  f.backend.emitVoice(f.textEvent('2001', '你好'));
  await until(() => f.adapter().status.last_error === 'VOICE_REALTIME_CHOICE_INVALID', 'invalid choice');
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [0, 0]);

  const second = f.textEvent('2002', '再说一次');
  f.backend.emitVoice(second);
  await until(() => f.backend.textSubmissions.length === 1, 'fallback text');
  await f.settle();
  assert.equal(f.backend.textSubmissions[0].msg, '语音没生成，改回文字。');
  assert.equal(f.backend.submissions.length, 0);
  const record = f.records().find(item => item.fallback === 'text');
  assert.deepEqual([record.mode, record.voiceError, record.stage], ['voice', 'VOICE_REALTIME_AUDIO', 'sent']);
  audioStatus = 'completed';
  f.backend.emitVoice(second);
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 1);
});

test('permission revoked before sending stops both forms; an uncertain voice submit is only checked by receipt', async t => {
  let revoke;
  const f = await realtimeFixture(t, [{mode: 'voice', text: '撤销前的语音'}, {mode: 'voice', text: '提交结果未知的语音'}], {onAudio: () => revoke?.()});
  revoke = () => { f.config.wechat.whitelist.private = [target]; f.saveConfig(); };
  f.backend.emitVoice(f.textEvent('3001', '你好'));
  await until(() => f.events.filter(event => event.type === 'response.create').length === 2, 'audio requested');
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [0, 0]);

  revoke = undefined;
  f.config.wechat.whitelist.private = [target, '124'];
  f.saveConfig();
  f.backend.loseVoice = true;
  f.backend.contentReceipt = null;
  const uncertain = f.textEvent('3002', '用语音说');
  f.backend.emitVoice(uncertain);
  await until(() => f.backend.submissions.length === 1, 'uncertain voice submit');
  await f.settle();
  assert.equal(f.backend.textSubmissions.length, 0, 'an uncertain voice submit is never replaced by text');
  const record = f.records().find(item => item.text === '提交结果未知的语音');
  await f.restart();
  f.backend.loseVoice = false;
  f.backend.emitVoice(uncertain);
  await f.settle();
  assert.deepEqual([f.backend.submissions.length, f.backend.textSubmissions.length], [1, 0]);
  // A late receipt confirms the original delivery without sending again.
  f.backend.contentReceipt = query => row({localId: 51, createTime: Number(query.get('after')), serverId: '920000000000000002'});
  const status = await f.status(record.id);
  assert.equal(status.body.status, 'confirmed');
  assert.equal(status.body.receiptSource, 'silk-sha256');
  assert.equal(f.backend.submissions.length, 1);
});

test('a backend without voice offers the model text only and sends the reply as text', async t => {
  const f = await realtimeFixture(t, [{mode: 'voice', text: '本轮只能打字回复。'}]);
  f.backend.helperTargets = [];
  f.backend.emitVoice(f.textEvent('4001', '你好'));
  await until(() => f.backend.textSubmissions.length === 1, 'text-only reply');
  await f.settle();
  assert.match(f.events.find(event => event.type === 'session.update').session.instructions, /本轮只能回复文字/);
  assert.equal(f.backend.submissions.length, 0);
  assert.equal(f.events.filter(event => event.type === 'response.create').length, 1);
});
