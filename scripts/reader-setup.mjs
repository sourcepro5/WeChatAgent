import path from 'node:path';
import { spawn } from 'node:child_process';

// Credentials travel over stdin and the private result channel, never argv or job logs.
export function runReaderSetup({ root, python, request, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', path.join(root, 'scripts', 'reader_setup.py')], {
      cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
    let pending = '', result, diagnostic = '', finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('READER_SETUP_TIMEOUT')); }, 210000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 128000) { child.kill(); finish(new Error('READER_SETUP_PROTOCOL')); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress' && typeof event.message === 'string') onProgress(event.message);
          if (event.type === 'result') result = event;
        } catch { /* Third-party diagnostics are private and are never forwarded. */ }
      }
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(new Error('READER_RUNTIME_MISSING')));
    child.once('close', () => {
      if (result) finish(null, result);
      else finish(new Error(/ModuleNotFoundError|ImportError|DLL load failed/.test(diagnostic) ? 'READER_DEPENDENCY_MISSING' : 'READER_SETUP_FAILED'));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export const readerSetupMessages = {
  READER_PATH_MISSING: '没有找到账号数据库。请先在微信登录并等待同步，再选择包含 db_storage 的账号文件夹或 xwechat_files 文件夹。',
  READER_DATABASE_MISSING: '账号目录已找到，但消息或联系人数据库尚未同步完成。请在微信打开几个聊天，等待同步后重试。',
  READER_KEY_INVALID: '读取密钥与所选账号不匹配。请点击“一键连接并验证”重新获取，或在高级选项中填写该账号的有效密钥。',
  READER_KEY_REQUIRED: '尚未获取读取密钥。请点击“一键连接并验证”，然后在微信中完成登录。',
  READER_SECRET_UNAVAILABLE: '旧凭据无法在当前 Windows 用户下读取。请点击“一键连接并验证”重新获取。',
  READER_DATABASE_UNREADABLE: '密钥验证通过，但数据库暂时无法完整读取。请等待微信同步完成后重试；若仍失败，请使用“验证内置环境”检查安装文件。',
  READER_DEPENDENCY_MISSING: '读取组件不完整或无法加载。请重新安装更新后的安装包，再使用“验证内置环境”检查。',
  READER_RUNTIME_MISSING: '找不到内置 Python 运行环境。请重新安装更新后的安装包。',
  READER_KEY_COMPONENT_MISSING: '自动连接组件缺失或无法加载。请重新安装更新后的安装包；也可以在高级选项中手动填写密钥。',
  WECHAT_NOT_RUNNING: '匹配微信尚未打开。请点击“打开微信”，再点击“一键连接并验证”，随后在微信中完成登录。',
  WECHAT_MULTIPLE_PROCESSES: '检测到多个匹配微信进程。请保留一个微信客户端后重试，以便确认当前账号。',
  READER_KEY_ACCESS_DENIED: '无法连接微信进程。请以相同的 Windows 用户和权限打开微信与助手后重试。',
  READER_SETUP_TIMEOUT: '获取密钥超时。请再次点击“一键连接并验证”，然后在微信中退出账号并重新登录；程序会等待登录完成。',
  READER_SETUP_FAILED: '自动连接未完成。请确认微信已打开、目录对应当前账号后重试；原有配置已保留。',
};

export function readerSetupMessage(code) {
  return readerSetupMessages[code] ?? readerSetupMessages.READER_SETUP_FAILED;
}
