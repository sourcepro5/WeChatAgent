import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { projectRoot } from './project-config.mjs';
import { buildIcons, embedExecutableIcon } from './build-icons.mjs';

const root = projectRoot;
const runtime = path.join(root, 'node_modules/electron/dist');
if (!fs.existsSync(path.join(runtime,'electron.exe'))) throw new Error('未找到已有 Electron 运行环境，请先在源码目录安装开发依赖。');
const output = path.join(root, 'release', 'WeChatAgent');
const appDir = path.join(output, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
function copy(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) { fs.mkdirSync(destination, { recursive: true }); for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name)); return; }
  if (fs.existsSync(destination)) { const target = fs.statSync(destination); if (target.size === stat.size && target.mtimeMs >= stat.mtimeMs) return; }
  fs.copyFileSync(source, destination);
}
for (const name of fs.readdirSync(runtime)) copy(path.join(runtime, name), path.join(output, name === 'electron.exe' ? 'WeChatAgent.exe' : name));
for (const name of ['package.json', 'main.cjs', 'preload.cjs', 'desktop-policy.cjs', 'deployment.cjs', 'appearance.cjs', 'loading-preload.cjs', 'loading.html', 'loading.css', 'loading.js']) fs.copyFileSync(path.join(root, 'apps/console-desktop', name), path.join(appDir, name));
fs.mkdirSync(path.join(output, 'runtime'), { recursive: true });
copy(process.execPath, path.join(output, 'runtime', 'node.exe'));
const nodeLicense = spawnSync(process.execPath, ['--print', 'process.release.name'], { encoding: 'utf8' });
if (nodeLicense.status !== 0 || nodeLicense.stdout.trim() !== 'node') throw new Error('Use the project Node.js executable to build the desktop app.');
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
const iconFile = await buildIcons(root, appDir, sharp);
embedExecutableIcon(path.join(output, 'WeChatAgent.exe'), iconFile, require('resedit'));
const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const launcher = path.join(root, 'WeChatAgent.exe');
const built = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', `/out:${launcher}`, `/win32icon:${iconFile}`, '/reference:System.Windows.Forms.dll', path.join(root, 'apps/console-desktop/launcher.cs')], { encoding: 'utf8', windowsHide: true });
if (built.status !== 0) throw new Error('Desktop launcher compilation failed: ' + (built.stdout || built.stderr));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'WECHATAGENT-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'LICENSES.md'), path.join(output, 'PROJECT-LICENSES.md'));
fs.writeFileSync(path.join(output, 'BUILD.json'), JSON.stringify({ product: 'WeChatAgent', version: JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version, electron: fs.readFileSync(path.join(runtime, 'version'), 'utf8').trim(), node: process.version, entry: 'WeChatAgent.exe', projectRelativeToRuntime: '../..', projectDataBundled: false }, null, 2));
console.log('Desktop application built: ' + launcher);
