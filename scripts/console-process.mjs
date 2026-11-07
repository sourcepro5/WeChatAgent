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

// inline：消息显示在概览状态卡等处（不在操作进度面板里），下方没有输出日志，改为指向运行日志页
export function taskFailureMessage(output, code, { inline = false } = {}) {
  if (/CLIENT_PIN_SCOPE_REQUIRED|CLIENT_PIN_LINK_REFUSED/.test(output)) return '客户端保护仅支持项目 state/hook 下没有目录链接的独立微信。请检查连接设置中的微信路径。';
  if (/CLIENT_PIN_VERSION_MISMATCH|CLIENT_PIN_SIGNATURE_INVALID/.test(output)) return '客户端保护未启用：微信版本或腾讯数字签名不符合当前配置，请选择匹配的原版客户端。';
  if (/CLIENT_PIN_UPDATER_RUNNING/.test(output)) return '所选微信的更新器正在运行。请正常退出该微信及更新器，再开启保护。';
  if (/CLIENT_PIN_BUSY/.test(output)) return '这个微信目录正在修改保护状态，请等待当前操作结束后重试。';
  if (/CLIENT_PIN_BACKUP_CHANGED|CLIENT_PIN_RESTORE_CONFLICT|CLIENT_PIN_RECOVERY_REQUIRED/.test(output)) return '客户端保护备份或更新器文件与记录不一致，未覆盖现有文件。请保留详细日志和 state/hook/client-pins 下的恢复记录。';
  if (/CLIENT_PIN_ACL_FAILED|CLIENT_PIN_PROTECTED_CHILD/.test(output)) return '客户端目录权限无法安全调整，请检查当前 Windows 用户的权限和下方错误。已保存的恢复记录位于 state/hook/client-pins。';
  if (/DSH_NOT_CONFIGURED/.test(output)) return '请先在“首次配置”点击“下载安装 DSH”，安装后选择 DSH 程序位置并保存设置。';
  if (/DSH_PLUGIN_NOT_READY/.test(output)) return 'DSH 插件尚未就绪，请在 DSH 添加并启用本机插件，再从托盘完整退出并重新打开 DSH。';
  const port=/\bport=(\d{1,5})\b/.exec(output)?.[1],portLabel=port?'端口 '+port:'配置端口';
  if (/ADAPTER_PORT_IN_USE|SERVICE_PORT_IN_USE|SERVICE_PORT_OWNER_MISMATCH/.test(output)) return portLabel+' 已被其他进程占用或绑定。点击“检查占用进程”，核对路径和 PID，经再次确认后处理；也可在连接设置中修改端口。';
  if (/ADAPTER_PORT_DENIED|SERVICE_PORT_DENIED/.test(output)) return 'Windows 拒绝绑定'+portLabel+'，可能涉及系统保留端口或访问限制。请在连接设置中更换该端口再重试；没有监听进程也可能无法使用。';
  if (/SERVICE_PORT_INSPECTION_FAILED/.test(output)) return '无法核对'+portLabel+'的进程归属，启动已停止。请完整退出并重新打开应用，仍失败时查看启动日志。';
  if (/ADAPTER_IDENTITY_MISMATCH/.test(output)) return portLabel+'未返回本实例的适配器身份，可能仍在运行旧版服务。请先重启本实例服务；持续冲突时检查占用进程。';
  if (/READER_NOT_LISTENING|READER_HEALTH_TIMEOUT|READER_CONNECTION_RESET|READER_HEALTH_INVALID_RESPONSE|READER_HEALTH_FAILED/.test(output)) return '适配器无法连接微信读取服务（'+portLabel+'）。请查看 reader.stderr.log 中的状态，并停止后重新启动助手服务；这一步尚未确认微信发送组件异常。';
  if (/HOOK_CONNECTION_RESET|HOOK_HEALTH_FAILED/.test(output)) return '微信发送组件连接被中断或检查失败（'+portLabel+'）。请查看 hook-init.log；持续失败时使用“修复微信连接”。';
  if (/ADAPTER_LISTEN_FAILED|ADAPTER_START_FAILED/.test(output)) return '应用适配器未能启动。下方日志已保留失败阶段和系统错误码，请结合 adapter.stderr.log 检查。';
  if (/SERVICE_START_TIMEOUT/.test(output)) return portLabel+'对应的本实例服务未在期限内准备完成。请查看该服务日志，或重启本实例后重试。';
  if (/READER_PORT_UNAVAILABLE/.test(output)) return '读取服务端口已被占用或被 Windows 拒绝。请在连接设置中修改微信读取端口，再启动服务；端口可能被未监听的其他程序占用。';
  if (/port is used by another installation|port is already in use|EADDRINUSE|address already in use/i.test(output)) return '配置端口已被占用。点击“检查占用进程”，核对程序后可选择停止，再重试。';
  if (/WECHAT_OTHER_CLIENT_RUNNING/.test(output)) return '检测到其他版本的微信正在运行。请先从微信托盘正常退出，再点击“打开微信”启动连接设置中的匹配版本。';
  if (/WECHAT_CLIENT_PATH_UNAVAILABLE/.test(output)) return '微信进程路径暂时无法核对。请等待微信完成启动后重试；持续出现时，检查所选程序的权限及占用进程。';
  if (/WECHAT_STARTUP_TIMEOUT/.test(output)) return '已尝试打开匹配微信，但它尚未完成启动。请查看微信窗口是否提示升级或启动失败；确认后再重试。';
  if (/WECHAT_LAUNCH_FAILED/.test(output)) return 'Windows 未能打开所选微信程序。请检查连接设置中的程序路径，并查看下方具体启动错误。';
  if (/HOOK_PROFILE_MISMATCH/.test(output)) return '微信版本或已加载的发送组件不匹配。请正常退出该微信后重新打开，并确认使用对应版本的组件。';
  if (/Another desktop WeChat is running|WECHAT_MULTIPLE/i.test(output)) return '检测到其他微信客户端。点击“检查占用进程”，确认并停止对应微信后，再打开匹配微信。';
  if (/HOOK_CLIENT_UNHEALTHY|HOOK_INITIALIZATION_TIMEOUT|HOOK_NOT_LISTENING/.test(output)) return '微信发送组件尚未就绪。可稍后重试；持续失败时点击“修复微信连接”，核对进程并再次确认后重开匹配微信。详情见 hook-init.log。';
  if (/HOOK_AUTH_FAILED|HOOK_PORT_OWNER_MISMATCH/.test(output)) return '微信发送端口或令牌与当前客户端不一致。请检查占用进程和 hook-init.log；可通过“修复微信连接”重新打开匹配微信。';
  if (/HOOK_HEALTH_TIMEOUT/.test(output)) return '微信发送组件响应超时，请稍后重试；持续失败时查看 hook-init.log。';
  if (/HOOK_HEALTH_INVALID_RESPONSE/.test(output)) return '微信发送端口返回了无效响应，可能被其他程序占用；请检查 hook-init.log 和发送端口。';
  if (/ACCOUNT_SWITCH_REQUIRES_DSH_RESTART/.test(output)) return '账号已切换。请从 DSH 托盘完整退出并重新打开，再启动助手服务。';
  if (code === 124) return '操作等待超时。请查看连接检查与日志，确认当前服务状态后重试。';
  if (/ModuleNotFoundError|ImportError|DLL load failed|需要 sqlcipher3/i.test(output)) return '读取组件缺失或无法加载。请重新安装更新后的安装包，然后在首次配置中点击“验证内置环境”。';
  if (/Selected account database directory is unavailable/i.test(output)) return '找不到所选账号的数据库目录。请在首次配置中自动查找账号，或重新选择包含 db_storage 的账号文件夹。';
  if (/Selected account database credential verification failed/i.test(output)) return '密钥与当前账号数据库不匹配。请在首次配置中点击“一键连接并验证”重新获取。';
  if (/Windows current-user credential decryption failed|Legacy secret requires/i.test(output)) return '已有凭据无法在当前电脑或 Windows 用户下读取。请在首次配置中点击“一键连接并验证”重新获取。';
  if (/Contact database could not be read|One or more message shards could not be read/i.test(output)) return '微信数据库尚未完整同步或暂时无法读取。请在微信打开几个聊天，等待同步后重新连接并验证。';
  if (/Reader initialization failed: (?:KeyError|FileNotFoundError)/i.test(output)) return '数据库读取设置尚未完成。请在首次配置中选择账号并点击“一键连接并验证”。';
  if (/reader exited/i.test(output)) return inline ? '数据库读取器未能启动。请在首次配置中重新连接并验证微信；具体错误见“设置 → 运行日志”。' : '数据库读取器未能启动。请在首次配置中重新连接并验证微信；下方会显示读取器的具体错误。';
  if (/HOOK_COMPONENT_UPDATE_PENDING/.test(output)) return '发送组件已更新。点击“修复微信连接”，核对并再次确认后重开匹配微信以应用更新。';
  if (/CouldNotAutoloadMatchingModule|Microsoft\.PowerShell\.Security.*module|Get-AuthenticodeSignature.*ObjectNotFound/is.test(output)) return 'Windows PowerShell 安全模块未能加载。请退出应用后重新打开更新后的 WeChatAgent.exe。';
  if (/WECHAT_LAUNCH_EXITED/i.test(output)) return '微信启动后已退出。若微信提示必须升级，当前固定版本的发送组件需要重新适配；请保留完整微信提示。';
  if (/HOOK_VERSION_MISMATCH|Client version mismatch/i.test(output)) return '微信版本与发送组件不匹配，请在连接设置中选择匹配的微信程序。';
  if (/HOOK_LOGIN_REQUIRED/i.test(output)) return '发送组件已连接，但微信尚未打开账号数据库。请完成登录并等待聊天同步，然后重试。';
  if (/HOOK_MULTIPLE_ACCOUNT_DATABASES/i.test(output)) return '匹配微信进程仍打开多个账号的数据库。点击“修复微信连接”，核对并再次确认后重开匹配微信，再登录目标账号。';
  if (/HOOK_ACCOUNT_MISMATCH/i.test(output)) return '微信当前账号与所选数据库不一致。请重新选择当前账号，或在微信切换到所选账号后重试。';
  if (/HOOK_ACCOUNT_METADATA_INVALID/i.test(output)) return '微信发送组件未提供有效账号信息。请检查组件版本或使用“修复微信连接”。';
  if (/HOOK_ACCOUNT_NOT_READY/i.test(output)) return '微信账号数据库尚未与读取设置匹配。请确认登录了对应账号，并等待聊天同步完成。';
  if (/WeChat-Hook is not ready|BACKEND_UNAVAILABLE|Matching WeChat client missing/i.test(output)) return '匹配微信尚未就绪。点击“打开微信”，登录配置的账号后再启动。';
  if (/Install the DSH plugin|Fully.*reopen DSH|ECONNREFUSED.*11230/i.test(output)) return 'DSH 插件尚未就绪。打开 DSH，启用本项目插件并完整重开后再启动。';
  if (/Invalid project configuration|configuration.*failed/i.test(output)) return '项目配置无效，请检查连接设置与人格文件。';
  return inline ? '读取服务上次未能正常运行，具体错误见“设置 → 运行日志”。' : '操作未完成，请查看下方详细信息，修正配置后重试。';
}
