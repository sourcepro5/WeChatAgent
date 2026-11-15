import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Foreground keyboard-simulation sender for clients without a usable Hook.
// It drives the selected clean WeChat window with Ctrl+F / clipboard / Enter;
// delivery is still decided by the reader's database receipt.
export const INPUT_BACKEND = 'wechat-input';
export const INPUT_INTEGRATION = 'WeChatAgent-Input-1';
// Operations that never stage or submit chat content.
export const INPUT_CONTROL_OPERATIONS = new Set(['health']);
const fault = code => Object.assign(new Error(code), { code });
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n"\0]/.test(value);
const localPython = 'state/input/venv/Scripts/python.exe';

function inputPython(root, configured) {
  const fallback = path.resolve(root, localPython);
  const selected = configured ? path.resolve(root, configured) : fallback;
  if (selected !== fallback || fs.existsSync(selected)) return selected;
  try {
    const distribution = JSON.parse(fs.readFileSync(path.join(root, 'config/distribution.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (distribution.installed === true && safePath(distribution.foregroundInputPython)) {
      return path.resolve(root, distribution.foregroundInputPython);
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return fallback;
}

export function inputSettings(config, root) {
  const settings = config.input ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fault('INPUT_CONFIG_INVALID');
  const executable = settings.wechatExecutable === undefined || settings.wechatExecutable === ''
    ? config.hook?.wechatExecutable : settings.wechatExecutable;
  if (!safePath(executable)) throw fault('INPUT_CLIENT_REQUIRED');
  if (!/^weixin\.exe$/i.test(path.basename(executable))) throw fault('INPUT_CLIENT_INVALID');
  if (settings.python !== undefined && settings.python !== '' && !safePath(settings.python)) throw fault('INPUT_PYTHON_INVALID');
  if (settings.paused !== undefined && typeof settings.paused !== 'boolean') throw fault('INPUT_PAUSED_INVALID');
  if (settings.voiceSend !== undefined && typeof settings.voiceSend !== 'boolean') throw fault('INPUT_VOICE_CONFIG_INVALID');
  if (settings.sendKey !== undefined && !['enter', 'ctrl-enter'].includes(settings.sendKey)) throw fault('INPUT_SEND_KEY_INVALID');
  const operationTimeoutMs = settings.operationTimeoutMs ?? 20000;
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 5000 || operationTimeoutMs > 30000) throw fault('INPUT_TIMEOUT_INVALID');
  const idleMs = settings.idleMs ?? 2000;
  if (!Number.isInteger(idleMs) || idleMs < 0 || idleMs > 30000) throw fault('INPUT_IDLE_INVALID');
  return {
    wechatExecutable: path.resolve(root, executable),
    python: inputPython(root, settings.python),
    operationTimeoutMs,
    idleMs,
    sendKey: settings.sendKey ?? 'enter',
    paused: settings.paused === true,
    voiceSend: settings.voiceSend === true,
  };
}

export function inputAccountProblem(health, account) {
  if (health?.backend !== INPUT_BACKEND || health.integration !== INPUT_INTEGRATION || health.ocr !== false) return 'INPUT_HEALTH_INVALID_RESPONSE';
  if (health.hookLoaded !== false) return 'INPUT_CLIENT_HAS_HOOK';
  if (!Array.isArray(health.databaseAccounts) || health.databaseAccounts.length !== 1 ||
      typeof health.databaseAccounts[0] !== 'string' || typeof account !== 'string' || !account) return 'INPUT_ACCOUNT_UNVERIFIED';
  if (health.databaseAccounts[0].toLowerCase() !== account.toLowerCase()) return 'INPUT_ACCOUNT_MISMATCH';
  return health.ready === true ? '' : 'INPUT_WINDOW_NOT_READY';
}

// Without a control tree the only guard against opening the wrong chat is the
// search text itself: WeChat's search matches substrings, so the target name
// must not occur inside any other contact or group name.
export function uniqueSearchName(name, wxid, contacts) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\r\n\0]/.test(name)) return 'INPUT_TARGET_NAME_MISSING';
  if (!Array.isArray(contacts) || contacts.length >= 100) return 'INPUT_TARGET_AMBIGUOUS';
  const needle = name.toLowerCase();
  const matching = contacts.filter(item => typeof item?.displayName === 'string' && item.displayName.toLowerCase().includes(needle));
  if (matching.length !== 1 || matching[0].username !== wxid || matching[0].displayName !== name || matching[0].ambiguous) return 'INPUT_TARGET_AMBIGUOUS';
  return '';
}

// Each request has its own bounded Python process. The queue serializes
// desktop operations, and the worker also holds a Windows mutex.
export class InputSender {
  constructor(root, { spawnImpl = spawn } = {}) {
    this.root = path.resolve(root);
    this.spawn = spawnImpl;
    this.tail = Promise.resolve();
    this.queued = 0;
    this.closed = false;
    this.children = new Map();
  }
  get busy() { return this.queued > 0; }
  request(operation, payload = {}) {
    if (this.closed) return Promise.reject(fault('API_HTTP_409'));
    if (this.queued >= 4) return Promise.reject(fault('API_HTTP_429'));
    const expiresAt = Date.now() + 60000;
    this.queued++;
    const result = this.tail.then(() => {
      if (this.closed) throw fault('API_HTTP_409');
      if (Date.now() >= expiresAt) throw fault('API_HTTP_429');
      return this.run(operation, payload);
    });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.queued--; });
  }
  run(operation, payload) {
    if (this.children.size) throw fault('API_HTTP_429');
    const config = JSON.parse(fs.readFileSync(path.join(this.root, 'config/wechatagent.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (config.runtime.sender !== INPUT_BACKEND) throw fault('API_HTTP_409');
    const settings = inputSettings(config, this.root);
    const control = INPUT_CONTROL_OPERATIONS.has(operation);
    const voice = operation === 'voice';
    if (!control && settings.paused) throw fault('API_HTTP_429');
    if (voice && !settings.voiceSend) throw fault('API_HTTP_409');
    if (!fs.existsSync(settings.python)) throw fault('INPUT_DEPENDENCIES_MISSING');
    const input = JSON.stringify({ ...payload, operation });
    const maxBytes = voice ? 4 * Math.ceil(59 * 32000 / 3) + 4095 : 65536;
    if (Buffer.byteLength(input) > maxBytes) throw fault('API_HTTP_400');
    return new Promise((resolve, reject) => {
      let output = '', finished = false, timedOut = false, killDeadline;
      const child = this.spawn(settings.python, ['-B', path.join(this.root, 'scripts/input-worker.py'), '--workspace', this.root, '--parent-pid', String(process.pid)], {
        cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      });
      this.children.set(child, voice);
      const cancel = () => {
        if (voice) child.stdin.end(); // Let the worker release its record key before it exits.
        else child.kill();
      };
      const done = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killDeadline);
        error ? reject(error) : resolve(value);
      };
      // A timed-out send may already have pressed Enter: only the receipt decides.
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
        if (!finished) killDeadline = setTimeout(() => done(fault(control ? 'INPUT_OPERATION_TIMEOUT' : 'INPUT_SEND_UNCONFIRMED')), 1000);
      }, voice ? 75000 : settings.operationTimeoutMs);
      child.on('error', () => {
        this.children.delete(child);
        done(fault('INPUT_WORKER_START_FAILED'));
      });
      child.stdout.on('data', bytes => {
        output += bytes.toString('utf8');
        if (Buffer.byteLength(output) > 32768) {
          timedOut = true;
          cancel();
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('close', () => {
        this.children.delete(child);
        if (timedOut) return done(fault(control ? 'INPUT_OPERATION_TIMEOUT' : 'INPUT_SEND_UNCONFIRMED'));
        try {
          const result = JSON.parse(output);
          if (result.ok === true) return done(null, result.data);
          const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(result.code ?? '') ? result.code : 'INPUT_WORKER_FAILED';
          if (control) return done(fault(code));
          const error = fault(result.attempted ? 'INPUT_SEND_UNCONFIRMED' : result.retryable ? 'API_HTTP_429' : 'API_HTTP_409');
          error.cause = fault(code);
          error.senderCode = code;
          done(error);
        } catch {
          done(fault(control ? 'INPUT_HEALTH_INVALID_RESPONSE' : 'INPUT_SEND_UNCONFIRMED'));
        }
      });
      if (voice) child.stdin.write(input + '\n');
      else child.stdin.end(input);
    });
  }
  close() {
    this.closed = true;
    for (const [child, voice] of this.children) {
      if (voice) child.stdin.end();
      else child.kill();
    }
  }
}
