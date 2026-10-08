import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, projectRoot } from './project-config.mjs';
import { conversationId } from './hook-onebot.mjs';
import { runConsoleCommand, taskFailureMessage, windowsPowerShellEnvironment, windowsPowerShellExecutable } from './console-process.mjs';
import { personaError } from '../public/console/persona-files.mjs';
import { runReaderSetup, readerSetupMessage } from './reader-setup.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};
const optionalJson = (file, fallback = {}) => fs.existsSync(file) ? readJson(file) : fallback;
const roleName = name => typeof name === 'string' && /^[^\\/\0.][^\\/\0]{0,60}$/.test(name) && !name.includes('..') && !/[<>:"|?*\r\n]/.test(name) && !/[. ]$/.test(name) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name);
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(600); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
});

export function validateConsoleConfig(config, root) {
  try { validateConfig(config); } catch (error) {
    const translations = [
      [/distinct|ports|Required ports/, '端口必须为 1024–65535 的整数，且不能互相重复。'],
      [/loopback/, '发送后端地址必须是本机回环 HTTP 地址。'],
      [/matching|version/, '发送组件需要匹配版本 4.1.10.27 的微信程序。'],
      [/persona/, '人格名称不能包含路径、点号前缀或无效字符。'],
      [/OneBot IDs/, '聊天 ID 必须是有效的正整数。'],
      [/nicknames|Python/, '请填写 Python 程序位置与至少一个账号昵称。'],
      [/provider|model/, '请填写有效的模型提供方与模型标识。'],
      [/wake_mode/, '请选择自然参与或唤醒后回复。'],
      [/sticker/, '表情发送与标签缓存必须使用开关值，聊天覆盖设置需要有效聊天 ID。'],
      [/search/, '请检查联网搜索开关、聊天 ID 和单轮次数范围。每轮搜索次数为 1–3，摘要长度为 256–3000 字符。'],
      [/proactive/, '请检查主动聊天开关、内容方向、时间段和间隔。时间为 HH:MM，主动间隔为 30–1440 分钟。'],
      [/context/, '请检查上下文压缩设置：阈值为 4,000–2,000,000 token，空闲等待为 15–3,600 秒；单个聊天填 0 可关闭。'],
      [/Hook/, '请检查发送请求超时、回执等待时间和并发上限。'],
    ];
    throw fault(translations.find(([pattern]) => pattern.test(error.message))?.[1] ?? '配置格式无效，请检查连接与回复设置。');
  }
  for (const value of [config.runtime.python, config.runtime.dshDesktop ?? '']) {
    if (typeof value !== 'string' || /[\0\r\n"]/.test(value) || value.length > 1024) throw fault('程序路径包含无效字符。');
  }
  for (const list of [config.account.nicknames, config.wechat.wake_words]) {
    if (!Array.isArray(list) || list.length > 50 || list.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw fault('昵称与唤醒词必须是有效文字，每项不超过 100 字。');
  }
  const ranges = { batch_ms: [0, 60000], min_interval_ms: [0, 3600000], private_min_interval_ms: [0, 3600000], max_per_minute: [1, 1000], max_per_ten_minutes: [1, 10000] };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (!Number.isInteger(config.social?.[key]) || config.social[key] < low || config.social[key] > high) throw fault(`回复频率 ${key} 必须在 ${low}–${high} 范围内。`);
  }
  for (const [key, value] of Object.entries(config.persona.chats ?? {})) {
    if (!/^wechat:(private|group):[1-9]\d*$/.test(key) || !roleName(value)) throw fault('聊天人格映射无效。');
  }
  for (const name of [config.persona.default, ...Object.values(config.persona.chats ?? {})]) {
    if (!roleName(name) || !fs.existsSync(path.join(root, 'roles', name + '.md'))) throw fault(`找不到人格「${name}」，请先在“人格”页面创建。`);
  }
  for (const key of ['allowStickerCdn', 'allowStickerCdnAlias']) {
    if (typeof config.wechat.media?.[key] !== 'boolean') throw fault('图片设置必须是开关值。');
  }
  return config;
}

export function createConsole({ root = projectRoot, port = 3210, runner, readerSetup = runReaderSetup, fetchImpl = fetch, nodeExecutable = process.execPath, filePicker, onQuit } = {}) {
  const publicDir = path.join(projectRoot, 'public', 'console');
  const configFile = path.join(root, 'config', 'wechatagent.json');
  const preferenceFile = path.join(root, 'state', 'console-state.json');
  const readerFile = path.join(root, 'state', 'weflow', 'WeFlow-config.json');
  const readerRevision = () => hash(JSON.stringify(optionalJson(readerFile)));
  const readerVerified = () => optionalJson(preferenceFile).readerVerifiedRevision === readerRevision();
  const csrf = crypto.randomBytes(32).toString('hex');
  const jobs = new Map(); let activeJob = null; let latestJob = null; let protectingCredential = false;
  let statusPromise; let statusTime = 0;
  const snapshot = () => {
    const raw = fs.readFileSync(fs.existsSync(configFile) ? configFile : path.join(root, 'config', 'wechatagent.example.json'), 'utf8');
    return { config: JSON.parse(raw.replace(/^\uFEFF/, '')), revision: hash(raw) };
  };
  const safeText = input => {
    let text = String(input ?? '');
    for (const relative of ['state/social-dsh-token.txt', 'state/hook/native-token.txt']) {
      const file = path.join(root, relative);
      if (fs.existsSync(file)) { const secret = fs.readFileSync(file, 'utf8').trim(); if (secret) text = text.split(secret).join('[已隐藏]'); }
    }
    let io = {}; try { io = optionalJson(path.join(root, 'state', 'wechat-io-config.json')); } catch {}
    if (io.reader_token) text = text.split(io.reader_token).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]').replace(/((?:decryptKey|access_token|api[_-]?key|password|reader_token)\s*[":=]+\s*")[^"]*/gi, '$1[已隐藏]').replace(/userdpapi:[A-Za-z0-9+/=]+/g, '[已隐藏凭据]').replace(/\b[0-9a-f]{64}\b/gi, '[已隐藏凭据]');
  };
  const backup = file => {
    if (!fs.existsSync(file)) return;
    const dir = path.join(root, 'state', 'console-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${path.basename(file)}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.bak`));
  };
  const markPending = (dsh = false) => {
    const previous = optionalJson(preferenceFile);
    atomic(preferenceFile, { ...previous, pendingApply: true, dshRestartRequired: previous.dshRestartRequired || dsh });
    statusTime = 0;
  };
  const assertIdle = () => { if (activeJob || protectingCredential) throw fault('有操作正在进行，请等它完成后再保存或执行其他操作。', 409); };
  async function remote(url, token, timeout = 2200) {
    const response = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw fault('连接服务暂不可用。请检查服务是否启动。', 503);
    const data = await response.json();
    if (data.success === false) throw fault('读取服务返回错误，请查看运行日志。', 503);
    return data;
  }
  async function reader(route) {
    const { config } = snapshot(); const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
    if (!io.reader_token) throw fault('读取连接尚未准备，请先启动服务。', 503);
    return remote(`http://127.0.0.1:${config.ports.weflow}${route}`, io.reader_token, 5000);
  }
  async function plugin(route) {
    const { config } = snapshot();
    const tokenFile = path.join(root, 'state', 'social-dsh-token.txt');
    if (!fs.existsSync(tokenFile)) throw fault('模型连接尚未准备，请先打开 DSH 并启用本项目插件。', 503);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const health = await remote(`http://127.0.0.1:${config.ports.dshPlugin}/health`, token);
    if (health.project !== 'WeChatAgent' || path.resolve(health.projectRoot ?? '') !== path.resolve(root)) throw fault('DSH 插件连接到其他项目，请启用当前项目插件。', 503);
    return remote(`http://127.0.0.1:${config.ports.dshPlugin}${route}`, token, 5000);
  }
  function buffered() {
    const buffer = optionalJson(path.join(root, 'state', 'social-messages.json'), { chats: {} });
    const rows = Object.entries(buffer.chats ?? {}).flatMap(([key, messages]) => messages.map(m => ({ ...m, key })));
    return { buffer, rows };
  }
  async function getStatus() {
    if (statusPromise && Date.now() - statusTime < 3000) return statusPromise;
    statusTime = Date.now();
    statusPromise = (async () => {
      const { config } = snapshot();
      const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
      const tokenFile = path.join(root, 'state', 'social-dsh-token.txt');
      const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
      const results = await Promise.allSettled([
        io.reader_token ? remote(`http://127.0.0.1:${config.ports.weflow}/api/v1/reader/status`, io.reader_token) : Promise.reject(),
        io.reader_token ? remote(`http://127.0.0.1:${config.ports.weflow}/api/v1/sessions?limit=1`, io.reader_token) : Promise.reject(),
        remote(`http://127.0.0.1:${config.ports.adapter}/status`),
        token ? remote(`http://127.0.0.1:${config.ports.dshPlugin}/health`, token) : Promise.reject(),
        portOpen(config.ports.onebot),
      ]);
      const value = index => results[index].status === 'fulfilled' ? results[index].value : null;
      const readerState = value(0), adapter = value(2), health = value(3);
      const dshReady = health?.ok === true && health.project === 'WeChatAgent' && path.resolve(health.projectRoot ?? '') === path.resolve(root) && health.contextMode === 'native-session-v1' && health.behaviorPolicy === 'local-config-only-v1' && health.imageInput === 'native-attachment-v1';
      const readerReady = !!readerState && !!value(1) && !readerState.lastError;
      const bridgeReady = !!value(4) && adapter?.ob_connected === true;
      const hookReady = adapter?.hook_connected === true && adapter?.hook_account_verified === true && adapter?.version === config.hook.expectedVersion;
      const ready = readerReady && bridgeReady && hookReady && dshReady && adapter?.reader_connected === true;
      const { rows } = buffered();
      const services = [
        { id: 'reader', label: '微信读取', ready: readerReady, detail: readerReady ? '数据库可读，消息同步正常' : readerState?.lastError ? '读取异常，请重新连接并验证' : readerFailureDetail(), port: config.ports.weflow },
        { id: 'bridge', label: '消息桥接', ready: bridgeReady && hookReady && adapter?.reader_connected === true, detail: bridgeReady && hookReady && adapter?.reader_connected ? '收发连接正常，账号已核验' : !hookReady ? '等待匹配微信登录与发送连接' : '等待消息桥接连接', port: config.ports.adapter },
        { id: 'dsh', label: '模型连接', ready: dshReady, detail: dshReady ? 'DSH 插件已连接' : '打开 DSH 并启用本项目插件', port: config.ports.dshPlugin },
      ];
      const running = !!readerState || !!adapter || !!value(4);
      return { ready, running, services, lastError: safeText(adapter?.last_error ?? ''),
        stats: { received: rows.filter(m => !m.outgoing).length, sent: rows.filter(m => m.outgoing).length, pending: rows.filter(m => !m.outgoing && !m.processed).length, chats: Object.keys(buffered().buffer.chats ?? {}).length },
        recent: rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 6).map(m => ({ key: m.key, name: m.conversation_name, text: m.text?.slice(0, 100), outgoing: m.outgoing, timestamp: m.timestamp })),
        ...optionalJson(preferenceFile), activeJob: activeJob ? jobs.get(activeJob) : null, latestJob: latestJob ? jobs.get(latestJob) : null, updatedAt: Date.now() };
    })();
    return statusPromise;
  }
  function command(action, body = {}) {
    const ps = (file, ...args) => ({ exe: windowsPowerShellExecutable(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'console-powershell.ps1'), '-ScriptPath', path.join(root, 'scripts', file), '-ArgumentsBase64', Buffer.from(JSON.stringify(args), 'utf8').toString('base64')] });
    const node = (file, ...args) => ({ exe: nodeExecutable, args: [path.join(root, 'scripts', file), ...args] });
    if (['start', 'stop', 'restart', 'prepare'].includes(action)) return ps('manage.ps1', action);
    if (action === 'setup') return ps(fs.existsSync(path.join(root, 'config', 'distribution.json')) ? 'check-runtime.ps1' : 'setup.ps1');
    if (action === 'dsh-open') return ps('launch-dsh.ps1');
    if (action === 'wechat-open') return ps('launch-hook-wechat.ps1', ...(fs.existsSync(path.join(root,'config/distribution.json')) && fs.existsSync(path.join(root,'state/hook/native/build.previous.json')) ? ['-UpdateHook'] : []));
    if (action === 'hook-build') return ps('build-hook.ps1');
    if (action === 'hook-pin') return ps('pin-hook-client.ps1');
    if (action === 'hook-unpin') return ps('pin-hook-client.ps1', '-Unlock');
    if (action === 'hook-check') return node('hook-onebot.mjs', '--check');
    if (action === 'reader-check') return { exe: snapshot().config.runtime.python, args: ['-B', path.join(root, 'scripts', 'reader-api.py'), '--check'] };
    if (['sessions-configure', 'sessions-compact'].includes(action)) {
      const key = body.conversationKey;
      const config = snapshot().config;
      const match = /^wechat:(private|group):([1-9]\d*)$/.exec(key ?? '');
      if (!match || !config.wechat.whitelist[match[1] === 'group' ? 'groups' : 'private'].map(String).includes(match[2])) throw fault('请从已允许的聊天中选择需要管理的会话。');
      return node('manage-dsh-sessions.mjs', action === 'sessions-compact' ? 'compact' : 'configure', key);
    }
    throw fault('不支持此操作。');
  }
  const execute = runner ?? ((spec, onOutput) => runConsoleCommand(spec, onOutput, { cwd: root, timeoutMs: spec.timeoutMs }));
  function readerFailureDetail() {
    const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
    if (!fs.existsSync(file)) return '请在首次配置中连接并验证微信';
    const output = fs.readFileSync(file, 'utf8').slice(-8000);
    return output.trim() ? taskFailureMessage(output, 1) : '等待读取服务启动';
  }
  function readerRequest(body) {
    if (body.revision !== readerRevision()) throw fault('读取配置已变化，请重新载入后再连接。', 409);
    const settings = optionalJson(readerFile);
    for (const key of ['dbPath', 'myWxid', 'decryptKey']) {
      if (typeof body[key] !== 'string' || body[key].length > 4096 || /[\0\r\n]/.test(body[key])) throw fault('读取设置包含无效字符。');
    }
    if (typeof body.autoKey !== 'boolean') throw fault('请选择自动连接或手动验证。');
    const request = { operation: 'connect', dbPath: body.dbPath.trim() || settings.dbPath || '', myWxid: body.myWxid.trim() || settings.myWxid || '',
      decryptKey: body.decryptKey.trim() || settings.decryptKey || '', autoKey: body.autoKey, wechatExecutable: snapshot().config.hook.wechatExecutable };
    if (!request.dbPath || !request.myWxid) throw fault('请先自动查找账号或选择微信账号文件夹。');
    return request;
  }
  function startJob(body) {
    assertIdle();
    const connectRequest = body.action === 'reader-connect' ? readerRequest(body) : null;
    const checkRevision = readerRevision();
    const spec = connectRequest ? {} : command(body.action, body);
    spec.timeoutMs = ['setup', 'hook-build'].includes(body.action) ? 1200000 : ['start', 'restart'].includes(body.action) ? 180000 : 150000;
    const id = crypto.randomUUID();
    const job = { id, action: body.action, state: 'running', startedAt: Date.now(), output: '', exitCode: null };
    jobs.set(id, job); activeJob = id; latestJob = id;
    while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
    const output = chunk => { job.output = safeText(job.output + chunk.toString()).slice(-40000); };
    Promise.resolve().then(async () => {
      if (!connectRequest) return execute(spec, output);
      const result = await readerSetup({ root, python: snapshot().config.runtime.python, request: connectRequest, onProgress: message => output(message + '\n') });
      if (!result.ok) { job.message = readerSetupMessage(result.code); output(job.message + '\n'); return 1; }
      if (checkRevision !== readerRevision()) throw fault('读取配置已在其他程序中变化。请刷新后重试，当前配置未覆盖。', 409);
      if (!/^userdpapi:[A-Za-z0-9+/=]+$/.test(result.protectedKey ?? '') || !result.dbPath || !result.myWxid) throw fault('凭据保护或数据库验证未完成，原配置已保留。');
      const previousReader = optionalJson(readerFile);
      const settings = { ...previousReader, dbPath: result.dbPath, myWxid: result.myWxid, decryptKey: result.protectedKey };
      backup(readerFile); atomic(readerFile, settings); markPending();
      if (previousReader.dbPath !== result.dbPath || previousReader.myWxid !== result.myWxid) {
        const ioFile = path.join(root, 'state', 'wechat-io-config.json');
        if (fs.existsSync(ioFile)) atomic(ioFile, { ...optionalJson(ioFile), self_wxid: '' });
      }
      atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: readerRevision() });
      job.readerConfigured = true; output('微信数据库已验证并保存。可以继续启动服务。\n');
      return 0;
    }).then(code => {
      job.exitCode = code; job.state = code === 0 ? 'succeeded' : 'failed';
      if (code !== 0 && ['start', 'restart'].includes(body.action) && /reader exited/.test(job.output)) {
        const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
        if (fs.existsSync(file)) output('\n读取器错误：\n' + fs.readFileSync(file, 'utf8').slice(-8000));
      }
      if (code !== 0 && !job.message) job.message = taskFailureMessage(job.output, code);
      if (code === 0 && body.action === 'reader-check' && checkRevision === readerRevision()) {
        atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: checkRevision }); job.readerConfigured = true;
      }
      if (code === 0 && ['start', 'restart'].includes(body.action)) {
        atomic(preferenceFile, { ...optionalJson(preferenceFile), pendingApply: false });
      }
    }).catch(error => { job.state = 'failed'; job.exitCode = 1; job.message = error.status ? error.message : connectRequest ? readerSetupMessage(error.message) : taskFailureMessage(job.output, 1); output(job.message); }).finally(() => {
      job.finishedAt = Date.now(); activeJob = null; statusTime = 0;
    });
    return job;
  }
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw fault('提交内容过大。', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('表单内容无效。'); }
  }
  async function nativeHelper(kind, input) {
    if (process.platform !== 'win32') throw fault('文件选择与凭据保护需要 Windows。');
    return new Promise((resolve, reject) => {
      const child = spawn(windowsPowerShellExecutable(), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', 'console-native.ps1'), kind], { windowsHide: true, shell: false, env: windowsPowerShellEnvironment() });
      let output = ''; let error = '';
      child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { error += b.toString(); });
      child.once('error', () => reject(fault('无法打开 Windows 选择窗口。')));
      child.once('close', code => code === 0 ? resolve(output.trim()) : reject(fault(kind === 'protect' ? '无法保护读取凭据。原有设置未修改。' : '文件选择失败，请手动填写路径。')));
      child.stdin.end(input ?? '');
    });
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    const reply = (status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
    try {
      const boundPort = server.address()?.port ?? port;
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) throw fault('请通过本机控制台地址访问。', 403);
      const origin = `http://${expectedHost}`;
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fault('不允许其他网站访问本机控制台。', 403);
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/persona-files.mjs': ['persona-files.mjs', 'text/javascript; charset=utf-8'], '/icons.svg': ['icons.svg', 'image/svg+xml'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        if (!assets[route]) return reply(404, { error: '页面不存在。' });
        const [file, type] = assets[route]; return reply(200, fs.readFileSync(path.join(publicDir, file)), type);
      }
      if (req.method === 'GET' && route === '/api/info') return reply(200, { project: 'WeChatAgent Console', root, version: 1, token: csrf });
      if (req.headers['x-console-token'] !== csrf) throw fault('控制台连接已更新，请刷新页面。', 401);
      if (req.method === 'GET' && route === '/api/config') return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      if (req.method === 'GET' && route === '/api/deployment') {
        const distribution = optionalJson(path.join(root, 'config', 'distribution.json'));
        const readerSettings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { installed: !!distribution.installed, version: distribution.version ?? '0.2.1', configured: !!readerSettings.dbPath && !!readerSettings.myWxid && !!readerSettings.decryptKey && readerVerified(), pluginPath: path.join(root, 'packages', 'dsh-social-bridge-plugin') });
      }
      if (req.method === 'GET' && route === '/api/status') return reply(200, await getStatus());
      if (req.method === 'GET' && route === '/api/roles') {
        const names = fs.existsSync(path.join(root, 'roles')) ? fs.readdirSync(path.join(root, 'roles')).filter(n => n.endsWith('.md') && n !== 'README.md' && roleName(n.slice(0, -3))) : [];
        return reply(200, { roles: names.map(file => { const content = fs.readFileSync(path.join(root, 'roles', file), 'utf8'); return { name: file.slice(0, -3), content, revision: hash(content) }; }) });
      }
      if (req.method === 'GET' && route === '/api/contacts') {
        const kind = url.searchParams.get('kind') === 'groups' ? 'groups' : 'private';
        const keyword = (url.searchParams.get('keyword') ?? '').slice(0, 100).trim();
        // Sessions contain selected chats only; discovery must use the contact catalog.
        const data = await reader(`/api/v1/contacts?kind=${kind}&keyword=${encodeURIComponent(keyword)}&limit=100`);
        const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
        const rows = data.contacts ?? [];
        const contacts = rows.filter(c => c.username && c.username !== io.self_wxid && (c.username.includes('@chatroom') ? 'groups' : 'private') === kind)
          .map(c => ({ name: c.remark || c.displayName || c.nickname || c.username, id: String(conversationId(c.username, c.displayName)), ambiguous: c.ambiguous === true }));
        const counts = new Map(); for (const row of contacts) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
        return reply(200, { contacts: contacts.map(c => ({ ...c, ambiguous: c.ambiguous || counts.get(c.id) > 1 })) });
      }
      if (req.method === 'GET' && route === '/api/chats') {
        const { buffer } = buffered();
        return reply(200, { chats: Object.entries(buffer.chats ?? {}).map(([key, rows]) => ({ key, name: rows.at(-1)?.conversation_name ?? key, lastAt: rows.at(-1)?.timestamp ?? 0 })) });
      }
      if (req.method === 'GET' && route === '/api/sessions') return reply(200, await plugin('/sessions'));
      if (req.method === 'GET' && route === '/api/job') {
        const job = jobs.get(url.searchParams.get('id')); if (!job) throw fault('此操作记录已过期。', 404); return reply(200, job);
      }
      if (req.method === 'GET' && route === '/api/logs') {
        const dir = path.join(root, 'state', 'logs');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9._-]+\.log$/.test(n)).sort() : [];
        const name = url.searchParams.get('file') ?? files.find(n => n === 'bridge.stdout.log') ?? files[0];
        if (name && !files.includes(name)) throw fault('日志文件不存在。', 404);
        let content = '';
        if (name) { const file = path.join(dir, name); const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, 120000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); content = safeText(bytes.toString('utf8')); } finally { fs.closeSync(fd); } }
        return reply(200, { files, file: name ?? '', content });
      }
      if (req.method === 'GET' && route === '/api/reader-config') {
        const settings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { dbPath: /^(userdpapi:|safe:)/.test(settings.dbPath ?? '') ? '' : settings.dbPath ?? '', myWxid: /^(userdpapi:|safe:)/.test(settings.myWxid ?? '') ? '' : settings.myWxid ?? '', hasKey: !!settings.decryptKey, hasPath: !!settings.dbPath, hasAccount: !!settings.myWxid, verified: readerVerified(), revision: hash(JSON.stringify(settings)) });
      }
      if (req.method !== 'POST') throw fault('接口不存在。', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw fault('请使用控制台表单。', 415);
      const body = await readBody(req);
      if (route === '/api/jobs') return reply(202, startJob(body));
      assertIdle();
      if (route === '/api/reader-accounts') {
        if (typeof body.dbPath !== 'string' || body.dbPath.length > 4096 || /[\0\r\n]/.test(body.dbPath)) throw fault('目录包含无效字符。');
        protectingCredential = true;
        try {
          const result = await readerSetup({ root, python: snapshot().config.runtime.python, request: { operation: 'discover', dbPath: body.dbPath.trim() } });
          if (!result.ok) throw fault(readerSetupMessage(result.code));
          return reply(200, { accounts: result.accounts });
        } catch (error) { throw error.status ? error : fault(readerSetupMessage(error.message)); }
        finally { protectingCredential = false; }
      }
      if (route === '/api/quit') {
        reply(200, { ok: true });
        setTimeout(() => { if (onQuit) onQuit(); else { server.closeAllConnections(); server.close(); } }, 100);
        return;
      }
      if (route === '/api/config') {
        const previous = snapshot();
        if (body.revision !== previous.revision) throw fault('配置已在其他窗口更新，请重新载入后再保存。', 409);
        const config = validateConsoleConfig(body.config, root);
        if (Object.values(config.ports).includes(boundPort) || Number(new URL(config.hook.baseUrl).port || 80) === boundPort) throw fault('服务端口不能与当前控制台端口重复。');
        backup(configFile); atomic(configFile, config);
        const withoutStickers=value=>{const copy=structuredClone(value);delete copy.wechat.stickers;delete copy.wechat.search;delete copy.wechat.proactive;delete copy.wechat.context;return copy;};
        if(JSON.stringify(withoutStickers(previous.config))!==JSON.stringify(withoutStickers(config)))markPending(JSON.stringify(previous.config.dsh) !== JSON.stringify(config.dsh) || previous.config.ports.dshPlugin !== config.ports.dshPlugin);
        return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      }
      if (route === '/api/roles') {
        const error = personaError(body.name, body.content);
        if (error) throw fault(error);
        fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
        const file = path.join(root, 'roles', body.name + '.md');
        const exists = fs.existsSync(file);
        if (exists && body.revision !== hash(fs.readFileSync(file, 'utf8'))) throw fault('同名人格已存在或已被修改，请重新载入或换一个名称。', 409);
        if (!exists && body.revision) throw fault('人格文件已被移动，请重新载入。', 409);
        backup(file); atomic(file, body.content); markPending();
        return reply(200, { ok: true, revision: hash(body.content) });
      }
      if (route === '/api/browse') {
        if (!['exe', 'folder'].includes(body.kind)) throw fault('无效的文件类型。');
        return reply(200, { path: filePicker ? await filePicker(body.kind) : await nativeHelper(body.kind) });
      }
      if (route === '/api/dsh-reopened') {
        await plugin('/health');
        atomic(preferenceFile, { ...optionalJson(preferenceFile), dshRestartRequired: false }); statusTime = 0;
        return reply(200, { ok: true });
      }
      if (route === '/api/reader-config') {
        const file = path.join(root, 'state', 'weflow', 'WeFlow-config.json');
        const settings = optionalJson(file);
        if (body.revision !== hash(JSON.stringify(settings))) throw fault('读取配置已变化，请重新载入后保存。', 409);
        for (const key of ['dbPath', 'myWxid', 'decryptKey']) {
          if (typeof body[key] !== 'string' || body[key].length > 4096 || /[\0\r\n]/.test(body[key])) throw fault('读取设置包含无效字符。');
        }
        if ((!body.dbPath.trim() && !settings.dbPath) || (!body.myWxid.trim() && !settings.myWxid) || (!body.decryptKey.trim() && !settings.decryptKey)) throw fault('首次配置需要数据库目录、账号标识和读取凭据。');
        if (body.dbPath.trim()) settings.dbPath = body.dbPath.trim();
        if (body.myWxid.trim()) settings.myWxid = body.myWxid.trim();
        if (body.decryptKey.trim()) {
          protectingCredential = true;
          try {
            settings.decryptKey = await nativeHelper('protect', body.decryptKey.trim());
            if (!/^userdpapi:[A-Za-z0-9+/=]+$/.test(settings.decryptKey)) throw fault('凭据保护失败，原有配置未修改。');
          } finally { protectingCredential = false; }
        }
        if (body.revision !== hash(JSON.stringify(optionalJson(file)))) throw fault('读取配置已变化，请重新载入后保存。', 409);
        backup(file); atomic(file, settings); markPending(); return reply(200, { ok: true });
      }
      throw fault('接口不存在。', 404);
    } catch (error) {
      const message = error.code === 'ENOENT' ? '所需文件尚未准备，请检查连接设置。' : error.status ? error.message : '操作失败，请检查配置和本机文件。';
      reply(error.status ?? 500, { error: safeText(message) });
    }
  });
  server.requestTimeout = 180000;
  return { server, isBusy: () => !!activeJob || protectingCredential, close: () => { server.closeAllConnections(); server.close(); }, start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WECHATAGENT_CONSOLE_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid console port');
  const app = createConsole({ port });
  await app.start();
  console.log(`WeChatAgent Console: http://127.0.0.1:${port}`);
}
