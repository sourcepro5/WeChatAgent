import { spawn } from 'node:child_process';
import path from 'node:path';

export function windowsPowerShellEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'psmodulepath') delete result[key];
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const modules = [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')];
  if (env.ProgramFiles) modules.push(path.win32.join(env.ProgramFiles, 'WindowsPowerShell', 'Modules'));
  result.PSModulePath = modules.join(';');
  return result;
}

export function windowsPowerShellExecutable(env = process.env) {
  return path.win32.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// A persistent service started by PowerShell can inherit a pipe handle even
// after the launcher exits. Its pipes must not define the task's lifetime.
export function runConsoleCommand(spec, onOutput, { cwd, env = process.env, timeoutMs = 180000, drainMs = 150 } = {}) {
  return new Promise(resolve => {
    const processEnv = /(?:^|[\\/])powershell\.exe$/i.test(spec.exe) ? windowsPowerShellEnvironment(env) : env;
    const child = spawn(spec.exe, spec.args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...processEnv, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
    let done = false, drainTimer;
    const finish = code => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(drainTimer);
      child.stdout?.destroy(); child.stderr?.destroy(); resolve(code);
    };
    const deadline = setTimeout(() => {
      onOutput('\n操作等待超时，请查看连接检查与运行日志后重试。\n');
      child.kill(); finish(124);
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
    child.once('error', error => { onOutput(error.message); finish(1); });
    child.once('exit', code => {
      clearTimeout(deadline);
      // Let queued output drain, with a bound independent of descendants.
      drainTimer = setTimeout(() => finish(code ?? 1), drainMs);
    });
    child.once('close', code => finish(code ?? 1));
  });
}

export function taskFailureMessage(output, code) {
  if (code === 124) return '操作等待超时。请查看连接检查与日志，确认当前服务状态后重试。';
  if (/HOOK_COMPONENT_UPDATE_PENDING/.test(output)) return '发送组件已更新。请从匹配微信的托盘菜单完整退出，再点击“打开微信”应用更新。';
  if (/CouldNotAutoloadMatchingModule|Microsoft\.PowerShell\.Security.*module|Get-AuthenticodeSignature.*ObjectNotFound/is.test(output)) return 'Windows PowerShell 安全模块未能加载。请退出应用后重新打开更新后的 WeChatAgent.exe。';
  if (/WECHAT_LAUNCH_EXITED/i.test(output)) return '微信启动后已退出。若微信提示必须升级，当前固定版本的发送组件需要重新适配；请保留完整微信提示。';
  if (/WeChat-Hook is not ready|BACKEND_UNAVAILABLE|Matching WeChat client missing/i.test(output)) return '匹配微信尚未就绪。点击“打开微信”，登录配置的账号后再启动。';
  if (/HOOK_VERSION_MISMATCH|Client version mismatch/i.test(output)) return '微信版本与发送组件不匹配，请在连接设置中选择匹配的微信程序。';
  if (/HOOK_ACCOUNT_NOT_READY/i.test(output)) return '微信登录账号与数据库账号不一致，请登录读取设置对应的账号。';
  if (/Install the DSH plugin|Fully.*reopen DSH|ECONNREFUSED.*11230/i.test(output)) return 'DSH 插件尚未就绪。打开 DSH，启用本项目插件并完整重开后再启动。';
  if (/Invalid project configuration|configuration.*failed/i.test(output)) return '项目配置无效，请检查连接设置与人格文件。';
  return '操作未完成，请查看下方详细信息，修正配置后重试。';
}
