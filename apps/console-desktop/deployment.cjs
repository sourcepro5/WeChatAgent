// Vendor app.asar files are opaque program files. Electron's patched fs
// interprets them as virtual directories, including incomplete destinations.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function bootstrapDeployment(resourcesPath, dataHome, progress = () => {}) {
  const template = path.join(resourcesPath, 'project');
  const manifestFile = path.join(template, 'deployment.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const workspace = path.join(dataHome, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  for (const relative of manifest.files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.startsWith('state/') || relative === 'config/wechatagent.json') throw new Error('发行包文件清单无效。');
    const source = path.join(template, relative), target = path.join(workspace, relative);
    if (relative.startsWith('roles/') && fs.existsSync(target)) continue;
    const bytes = fs.readFileSync(source);
    if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === crypto.createHash('sha256').update(bytes).digest('hex')) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const runtimeName = manifest.runtimeRevision ? `${manifest.version}-${manifest.runtimeRevision}` : manifest.version;
  const versionRuntime = path.join(dataHome, 'runtimes', runtimeName);
  const ready = path.join(versionRuntime, '.ready');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(versionRuntime, { recursive: true });
    progress('正在准备内置 Python 运行环境…');
    await fs.promises.cp(path.join(resourcesPath, 'runtime', 'python'), path.join(versionRuntime, 'python'), { recursive: true });
    progress('正在准备 Node.js 与模型程序…');
    fs.copyFileSync(path.join(resourcesPath, 'runtime', 'node.exe'), path.join(versionRuntime, 'node.exe'));
    await fs.promises.cp(path.join(resourcesPath, 'vendor', 'dsh'), path.join(versionRuntime, 'dsh'), { recursive: true });
    fs.writeFileSync(ready, manifest.version);
  }
  const python = path.join(versionRuntime, 'python', 'python.exe');
  const node = path.join(versionRuntime, 'node.exe');
  const dsh = path.join(versionRuntime, 'dsh', 'DeepSeek Harness.exe');
  const client = path.join(workspace, 'state', 'hook', 'wechat-4.1.10.27');
  if (!fs.existsSync(path.join(client, 'Weixin.exe'))) {
    progress('正在准备独立匹配微信…');
    fs.mkdirSync(path.dirname(client), { recursive: true }); await fs.promises.cp(path.join(resourcesPath, 'vendor', 'wechat'), client, { recursive: true });
  }
  const nativeDir = path.join(workspace, 'state', 'hook', 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  const previousBuild = path.join(nativeDir,'build.json');
  if (fs.existsSync(previousBuild) && fs.existsSync(path.join(nativeDir,'version.dll'))) {
    const installedHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(nativeDir,'version.dll'))).digest('hex');
    const nextHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(resourcesPath,'vendor/hook/version.dll'))).digest('hex');
    if (installedHash !== nextHash) {
      const previous=JSON.parse(fs.readFileSync(previousBuild,'utf8').replace(/^\uFEFF/,''));
      if (previous.sha256 === installedHash) fs.copyFileSync(previousBuild,path.join(nativeDir,'build.previous.json'));
    }
  }
  for (const file of ['version.dll', 'build.json']) {
    const source = path.join(resourcesPath, 'vendor', 'hook', file), target = path.join(nativeDir, file);
    const bytes = fs.readFileSync(source);
    if (!fs.existsSync(target) || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== crypto.createHash('sha256').update(bytes).digest('hex')) fs.writeFileSync(target,bytes);
  }
  const configFile = path.join(workspace, 'config', 'wechatagent.json');
  if (!fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'config', 'wechatagent.example.json'), 'utf8'));
    config.runtime.python = python;
    config.runtime.dshDesktop = dsh;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  }
  const distributionFile = path.join(workspace, 'config', 'distribution.json');
  if (fs.existsSync(distributionFile)) {
    const previous = JSON.parse(fs.readFileSync(distributionFile, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (config.runtime.python === previous.python) config.runtime.python = python;
    if (config.runtime.dshDesktop === previous.dsh) config.runtime.dshDesktop = dsh;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    if (manifest.buildId && previous.buildId !== manifest.buildId) {
      const pendingFile = path.join(workspace, 'state', 'console-state.json');
      let pending = {}; try { pending = JSON.parse(fs.readFileSync(pendingFile,'utf8')); } catch {}
      fs.writeFileSync(pendingFile,JSON.stringify({...pending,pendingApply:true,dshRestartRequired:true},null,2));
    }
  }
  fs.writeFileSync(distributionFile, JSON.stringify({ version: manifest.version, buildId:manifest.buildId, runtimeRevision:manifest.runtimeRevision, installed: true, dataHome, python, node, dsh, assets: resourcesPath }, null, 2));
  progress('本机运行环境已准备，正在打开控制台…');
  return { root: workspace, node, python, dataHome, version: manifest.version };
}
module.exports = { bootstrapDeployment };
