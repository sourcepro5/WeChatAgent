import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function ready(port, token) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('plugin did not start');
}

test('DSH plugin creates one safe session per group and resumes mappings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-plugin-'));
  const packageDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export const createUserMessage = (value) => value;');
  fs.copyFileSync(path.join(root, 'packages', 'dsh-social-bridge-plugin', 'index.js'), path.join(dir, 'index.js'));
  fs.copyFileSync(path.join(root, 'packages', 'dsh-social-bridge-plugin', 'native-context.mjs'), path.join(dir, 'native-context.mjs'));
  fs.copyFileSync(path.join(root, 'packages', 'dsh-social-bridge-plugin', 'image-input.mjs'), path.join(dir, 'image-input.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const { apply } = await import(pathToFileURL(path.join(dir, 'index.js')).href);
  const oldToken = process.env.SOCIAL_DSH_TOKEN;
  process.env.SOCIAL_DSH_TOKEN = 'test-plugin-token';
  const statePath = path.join(dir, 'sessions.json');
  const tokenFile = path.join(dir, 'token.txt');
  fs.writeFileSync(tokenFile, 'test-plugin-token');
  const port = await freePort();
  const savedSessions = new Map();
  const setup = (resumeExpected = false) => {
    const agents = new Map(), calls = { create: [], resume: [], preset: [] };
    let handler, disposer;
    const hooks = new Map();
    const register = (sid) => {
      if (!savedSessions.has(sid)) {
        const events = [], nodes = [];
        const session = { id: sid, surface: { nodes }, snapshotEvents: () => [...events],
          append(type, data) {
            const event = { seq: events.length, type, data }; events.push(event);
            if (type === 'user/message' || type === 'assistant/message') nodes.push(event.seq);
            handler(session, event); return event;
          } };
        savedSessions.set(sid, session);
      }
      const session = savedSessions.get(sid);
      const agent = { followup(message) {
        assert.equal(message.source.kind, 'wechat-social-bridge');
        queueMicrotask(async () => {
          handler(session, { type: 'turn/start', data: { turn: 1 } });
          const decision = await hooks.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [message] }));
          await hooks.get('agent/request')({ agent }, async () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }));
          for (const input of decision.messages) session.append('user/message', input);
          handler(session, { type: 'assistant/message', data: { turn: 1,
            message: { content: [{ type: 'text', text: 'SILENT' }] } } });
          handler(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
        });
      } };
      agent.session = session;
      agent.ctx = {};
      agents.set(sid, agent);
      return { dispose: async () => { agents.delete(sid); } };
    };
    const ctx = {
      logger: () => ({ info() {}, warn() {} }),
      on: (eventName, fn) => { if (eventName === 'session/event') handler = fn; else hooks.set(eventName, fn); },
      effect: (fn) => { disposer = fn(); },
      agentPresets: { resolve: async (id) => { calls.preset.push(id); return { id }; }, mount: async (agentCtx,id) => { agentCtx.preset=id; return {id}; } },
      sessions: { get: sid => savedSessions.get(sid), flush: async () => true },
      sessionTitle: { get: session => session.title, rename: (session, title) => { session.title = { title }; return session.title; } },
      agents: {
        get: (sid) => agents.get(sid),
        create: async (options) => { assert.equal(resumeExpected, false); calls.create.push(options); const handle=register(options.sessionId); await options.setup(agents.get(options.sessionId).ctx); return handle; },
        resume: async (options) => { assert.deepEqual(options.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'restored sessions require explicit model options'); calls.resume.push(options); const handle=register(options.resumeSessionId); await options.setup(agents.get(options.resumeSessionId).ctx); return handle; },
      },
    };
    return { ctx, calls, stop: () => disposer() };
  };
  const request = async (key) => {
    const response = await fetch(`http://127.0.0.1:${port}/followup`, {
      method: 'POST', headers: { authorization: 'Bearer test-plugin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ conversationKey: key, message: '观察群聊' }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = setup();
    apply(first.ctx, { port, statePath, cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' });
    await ready(port, 'test-plugin-token');
    const a = await request('wechat:group:A');
    const b = await request('wechat:group:B');
    assert.equal(a.text, 'SILENT');
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(first.calls.create.length, 2);
    assert.equal(first.calls.create[0].meta.agentPreset, 'wechat-social');
    await first.stop();
    delete process.env.SOCIAL_DSH_TOKEN;
    const second = setup(true);
    apply(second.ctx, { port, statePath, tokenFile, cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' });
    await ready(port, 'test-plugin-token');
    const restored = await request('wechat:group:A');
    assert.equal(restored.sessionId, a.sessionId);
    assert.equal(second.calls.resume.length, 1);
    assert.deepEqual(second.calls.resume[0].agentOptions, first.calls.create[0].agentOptions);
    assert.equal(second.calls.create.length, 0);
    await second.stop();
  } finally {
    if (oldToken === undefined) delete process.env.SOCIAL_DSH_TOKEN;
    else process.env.SOCIAL_DSH_TOKEN = oldToken;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
