import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { HookOneBot, onebotId, conversationId, textSegments } from './hook-onebot.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';

function fixture(t, { version = '4.1.10.27', account = 'wxid_fixture_account', sendRet = 0, receipt = true, oldReceipt = false, blockFirst = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent hook '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateA = 'wxid_fixture_A', privateB = 'wxid_fixture_B', group = 'fixture@chatroom';
  const ids = { a: onebotId(privateA), b: onebotId(privateB), group: conversationId(group, 'Fixture Group (3)') };
  const config = { runtime: { sender: 'wechat-hook', weflowMode: 'nt' },
    hook: { baseUrl: 'http://127.0.0.1:30001', expectedVersion: '4.1.10.27', requestTimeoutMs: 5000, receiptTimeoutMs: 1000, maxConcurrentSends: 4 },
    ports: { adapter: 0 }, account: { nicknames: ['Fixture Bot'] }, wechat: { whitelist: { private: [String(ids.a), String(ids.b)], groups: [String(ids.group)] } } };
  for (const dir of ['config', 'state/hook']) fs.mkdirSync(path.join(directory, dir), { recursive: true });
  fs.writeFileSync(path.join(directory, 'config/wechatagent.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'state/wechat-io-config.json'), JSON.stringify({ reader_token: 'fixture-reader-token', reader_base_url: 'http://127.0.0.1:5031', onebot_ws_url: 'ws://127.0.0.1:11229/ws' }));
  fs.writeFileSync(path.join(directory, 'state/hook/native-token.txt'), 'a'.repeat(64));
  const calls = [], sent = new Map();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const makeRow = (localId = 2, text = 'fixture reply') => ({ localId, createTime: Math.floor(Date.now() / 1000), serverId: '900000000000000001', isSend: true, fullText: text });
  const preexistingRow = makeRow(1);
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); calls.push({ path: url.pathname, body: options.body ? JSON.parse(options.body) : undefined });
    const native = url.port === '30001';
    assert.equal(options.headers?.Authorization, 'Bearer ' + (native ? 'a'.repeat(64) : 'fixture-reader-token'));
    let data;
    if (url.pathname === '/api/v1/reader/status') data = { backend: 'weflow-cli-nt', ownWxid: 'wxid_fixture', accountDirectory: 'wxid_fixture_account' };
    else if (url.pathname === '/WeChatAgent/health') data = { backend: 'wechat-hook', integration: 'WeChatAgent-1', version, databaseAccounts: [account] };
    else if (url.pathname === '/api/v1/sessions') data = { sessions: [{ username: privateA, displayName: 'Same Display Name' }, { username: privateB, displayName: 'Same Display Name' }, { username: group, displayName: 'Fixture Group (3)' }] };
    else if (url.pathname === '/api/v1/messages') {
      const wxid = url.searchParams.get('talker');
      data = { messages: oldReceipt ? [preexistingRow] : (sent.has(wxid) && receipt ? [makeRow(2, sent.get(wxid))] : []) };
    } else if (url.pathname === '/SendTextMsg') {
      assert.equal(options.headers['X-WeChatAgent-Account'], 'wxid_fixture_account');
      const body = JSON.parse(options.body);
      if (blockFirst && body.wxidorgid === privateA) await firstGate;
      sent.set(body.wxidorgid, body.msg); data = { ret: sendRet };
    } else if (url.pathname === '/api/v1/push/messages') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ event: 'message.new', type: 1, sessionId: privateA, talkerId: privateA, content: 'fixture incoming', rawid: 'fixture-event', timestamp: Math.floor(Date.now() / 1000) }) + '\n\n'));
        options.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    } else throw new Error('Unexpected test route');
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const adapter = new HookOneBot({ directory, fetchImpl, receiptTimeoutMs: 30, pollMs: 5 });
  const action = (target = ids.a, echo = 'fixture-echo', text = 'fixture reply', kind = 'private') => ({ action: kind === 'group' ? 'send_group_msg' : 'send_private_msg', echo, params: { [kind === 'group' ? 'group_id' : 'user_id']: target, message: [{ type: 'text', data: { text } }] } });
  return { adapter, directory, config, ids, calls, sent, action, releaseFirst };
}

test('Hook sends resolve synthetic IDs to wxid and require a new server receipt', async t => {
  const f = fixture(t);
  const response = await f.adapter.action(f.action());
  assert.equal(response.status, 'ok'); assert.equal(response.echo, 'fixture-echo');
  assert.equal(response.data.receipt, 'wechat-server-id');
  assert.deepEqual(f.calls.find(c => c.path === '/SendTextMsg').body, { wxidorgid: 'wxid_fixture_A', msg: 'fixture reply' });
});

test('unlisted targets and nontext messages never reach native sending', async t => {
  const f = fixture(t);
  assert.equal((await f.adapter.action(f.action(999))).status, 'failed');
  const action = f.action(); action.params.message = '[CQ:image,file=fixture]';
  assert.equal((await f.adapter.action(action)).status, 'failed');
  assert.equal(f.calls.length, 0);
  assert.throws(() => textSegments([{ type: 'at', data: { qq: 'all' } }]), /TEXT_ONLY/);
});

test('wrong version and wrong account stop before native sending', async t => {
  for (const settings of [{ version: '4.1.15.13' }, { account: 'wxid_other_account' }]) {
    const f = fixture(t, settings);
    assert.equal((await f.adapter.action(f.action())).status, 'failed');
    assert.equal(f.calls.some(c => c.path === '/SendTextMsg'), false);
  }
});

test('native acceptance and preexisting matching messages cannot acknowledge success', async t => {
  for (const settings of [{ receipt: false }, { oldReceipt: true }, { sendRet: 1 }]) {
    const f = fixture(t, settings), response = await f.adapter.action(f.action());
    assert.equal(response.status, 'failed'); assert.equal(response.echo, 'fixture-echo');
    assert.equal(f.adapter.status.confirmed_sends, 0);
  }
});

test('different conversations run concurrently and retain their own echoes', async t => {
  const f = fixture(t, { blockFirst: true });
  const first = f.adapter.action(f.action(f.ids.a, 'echo-A', 'reply-A'));
  while (!f.calls.some(c => c.path === '/SendTextMsg')) await sleep(1);
  const second = await f.adapter.action(f.action(f.ids.b, 'echo-B', 'reply-B'));
  assert.equal(second.status, 'ok'); assert.equal(second.echo, 'echo-B');
  assert.equal(f.sent.has('wxid_fixture_A'), false);
  f.releaseFirst(); const result = await first;
  assert.equal(result.status, 'ok'); assert.equal(result.echo, 'echo-A');
  assert.equal(f.sent.get('wxid_fixture_A'), 'reply-A'); assert.equal(f.sent.get('wxid_fixture_B'), 'reply-B');
});

test('same conversation does not reuse a receipt for simultaneous requests', async t => {
  const f = fixture(t, { blockFirst: true });
  const first = f.adapter.action(f.action());
  while (!f.calls.some(c => c.path === '/SendTextMsg')) await sleep(1);
  const second = await f.adapter.action(f.action());
  assert.equal(second.message, 'SENDER_BUSY');
  f.releaseFirst(); await first;
  assert.equal(f.calls.filter(c => c.path === '/SendTextMsg').length, 1);
});

test('group IDs remain compatible and own messages are excluded', async t => {
  const f = fixture(t); await f.adapter.checkNative();
  assert.equal(conversationId('fixture@chatroom', 'Fixture Group (3)'), onebotId('Fixture Group'));
  const response = await f.adapter.action(f.action(f.ids.group, 'echo-group', 'group reply', 'group'));
  assert.equal(response.status, 'ok'); assert.equal(f.sent.get('fixture@chatroom'), 'group reply');
  const payload = { event: 'message.new', type: 1, sessionId: 'fixture@chatroom', groupName: 'Fixture Group (3)', talkerId: 'wxid_member', content: '@Fixture Bot\u2005 fixture incoming', rawid: 'fixture-group-event' };
  const event = f.adapter.incoming(payload);
  assert.equal(event.group_id, f.ids.group); assert.equal(event.message[0].type, 'at');
  assert.equal(f.adapter.incoming({ ...payload, talkerId: 'wxid_fixture' }), null);
  assert.equal(f.adapter.incoming({ ...payload, type: 3 }), null);
  const image = f.adapter.incoming({ ...payload, type: 3, content: '[图片]', image: { id: 'a'.repeat(64) } });
  assert.equal(image.message.at(-1).type, 'image');
  assert.equal(image.message.at(-1).data.media_id, 'a'.repeat(64));
  f.adapter.enqueue(payload); f.adapter.enqueue(payload); assert.equal(f.adapter.pending.length, 1);
});

test('real reverse WebSocket carries reader events and confirmed Hook action responses', async t => {
  const f = fixture(t), server = new ReverseOneBotServer({ port: 0, timeoutMs: 2000 });
  server.on('error', () => {}); await server.start();
  const apiFile = path.join(f.directory, 'state/wechat-io-config.json'), api = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
  api.onebot_ws_url = `ws://127.0.0.1:${server.server.address().port}/ws`;
  fs.writeFileSync(apiFile, JSON.stringify(api)); f.adapter.reload();
  const event = new Promise(resolve => server.on('event', event => { if (event.post_type === 'message') resolve(event); }));
  t.after(async () => { await f.adapter.stop(); await server.stop(); });
  await f.adapter.start();
  const incoming = await Promise.race([event, sleep(2000).then(() => { throw new Error('Reader/OneBot event timeout'); })]);
  assert.equal(incoming.user_id, f.ids.a); assert.equal(incoming.raw_message, 'fixture incoming');
  const response = await server.action('send_private_msg', f.action().params);
  assert.equal(response.status, 'ok'); assert.equal(response.data.receipt, 'wechat-server-id');
  assert.equal(f.adapter.status.reader_connected, true);
});

test('stickers use bound image references; pats to the bot explicitly wake groups', async t => {
  const f = fixture(t); await f.adapter.checkNative();
  const base = { event:'message.new', sessionId:'fixture@chatroom', groupName:'Fixture Group (3)', talkerId:'wxid_member', rawid:'fixture-media', content:'[表情包]' };
  assert.equal(f.adapter.incoming({...base,type:47}), null);
  const sticker = f.adapter.incoming({...base,type:47,image:{id:'b'.repeat(64)}});
  assert.equal(sticker.message.at(-1).data.file, 'wechatagent://image/'+'b'.repeat(64));
  const pat = {...base,type:62*2**32+49,content:'[拍一拍]',pat:{actor:'wxid_member',target:'wxid_fixture'}};
  const event = f.adapter.incoming(pat);
  assert.equal(event.message[0].type,'at'); assert.equal(event.group_id,f.ids.group);
  assert.equal(f.adapter.incoming({...pat,pat:{...pat.pat,target:'wxid_other'}}),null);
  assert.equal(f.adapter.incoming({...pat,pat:{...pat.pat,actor:'wxid_other'}}),null);
  assert.equal(f.adapter.incoming({...pat,isSend:true}),null);
  assert.equal(f.adapter.incoming({...pat,sessionId:'unknown@chatroom',groupName:'Unknown'}),null);
});
