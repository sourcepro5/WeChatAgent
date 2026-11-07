import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DSH_SDK_VERSION,DSH_INSTALL_URL } from '../public/console/dsh-install.mjs';
import { spawnSync } from 'node:child_process';
import { buildIcons, embedExecutableIcon } from './build-icons.mjs';
import { singleDirectoryTemplate } from './installer-directory-page.mjs';
import { projectRoot as root } from './project-config.mjs';
import { verifyHookBuild,verifyWeChatClient } from './hook-build-policy.mjs';
import {assertPluginHost} from './plugin-host-check.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {releaseIdentity} from './release-version.mjs';

await assertPluginHost(root);
const wechatVersion=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.example.json'),'utf8')).hook.expectedVersion;
const clientSource=path.join(root,'state/hook/wechat-'+wechatVersion);
verifyWeChatClient(clientSource,wechatVersion);
const legacyBuild=wechatVersion==='4.1.10.27'?verifyHookBuild(path.join(root,'state/hook/native')):null;
const currentBuild=['4.1.15.13','4.2.0.12'].includes(wechatVersion)?verifyHookBuild(path.join(root,'state/hook/native-'+wechatVersion),wechatVersion):null;

const {version,packageVersion,buildVersion}=releaseIdentity(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')));
const stage = path.join(root, 'state', 'installer-stage');
const appDir = path.join(stage, 'app');
const project = path.join(stage, 'project');
const vendor = path.join(stage, 'vendor');
const require = createRequire(path.join(root, 'package.json'));
const pluginPackage = JSON.parse(fs.readFileSync(path.join(root,'packages/dsh-social-bridge-plugin/package.json'),'utf8'));
const sdkPackage = JSON.parse(fs.readFileSync(path.join(root,'packages/dsh-social-bridge-plugin/node_modules/@deepseek-ai/dsh-llm/package.json'),'utf8'));
if (pluginPackage.dependencies['@deepseek-ai/dsh-llm'] !== DSH_SDK_VERSION || sdkPackage.version !== DSH_SDK_VERSION) throw new Error('Installed plugin SDK must match the declared DSH compatibility version.');
console.log('DSH desktop is external; only the bridge plugin and SDK '+DSH_SDK_VERSION+' are included.');
for (const dir of [appDir, project, vendor]) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(stage) + path.sep)) throw new Error('Invalid release staging directory');
  fs.rmSync(resolved, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
for (const dir of [appDir, project, vendor, path.join(stage, 'runtime')]) fs.mkdirSync(dir, { recursive: true });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
function copyFile(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
function copyTree(source, target, allow = () => true) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!allow(entry.name, entry.isDirectory()) || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, allow); else copyFile(from, to);
  }
}
function add(relative) { copyFile(path.join(root, relative), path.join(project, relative)); files.push(relative); }
function addTree(relative, allow) {
  copyTree(path.join(root, relative), path.join(project, relative), allow);
  for (const name of fs.readdirSync(path.join(project, relative), { recursive: true })) if (fs.statSync(path.join(project, relative, name)).isFile()) files.push((relative + '/' + name).replaceAll('\\', '/'));
}

for (const name of ['package.json','main.cjs','preload.cjs','shutdown.cjs','storage-location.cjs', 'desktop-policy.cjs','deployment.cjs','appearance.cjs', 'loading-preload.cjs','loading.html','loading.css','loading.js']) copyFile(path.join(root, 'apps/console-desktop', name), path.join(appDir, name));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'wechatagent', productName: 'WeChatAgent', version:packageVersion, releaseVersion:version, description: 'WeChatAgent desktop console', main: 'main.cjs', author: 'WeChatAgent contributors', license: 'SEE THIRD-PARTY-NOTICES.txt' }, null, 2));
await buildIcons(root, appDir, require('sharp'));
for (const name of ['LICENSE','LICENSES.md']) add(name);
for (const name of ['README.md','RELEASE_NOTES.md']) add(name);
add('docs/releases/'+version+'.md');
addTree('docs', (name, directory) => directory || name.endsWith('.md'));
add('config/wechatagent.example.json');
for(const name of ['SESSION_RECOVERY.md','SEND_QUEUE_RECOVERY.md','MEDIA_RECOVERY.md','GROUP_REJOIN.md'])add('docs/'+name);
const presetNames = fs.readdirSync(path.join(root, 'roles')).filter(name => name.endsWith('.md') && name !== 'README.md');
for (const name of presetNames) add('roles/' + name);
addTree('public/console');
add('scripts/wechat_sticker_manager.py');
add('docs/STICKER_MANAGER.md');
add('docs/EXIT_SHUTDOWN.md');
add('docs/DATA_STORAGE.md');
add('docs/HOOK_STARTUP_RECOVERY.md');
add('docs/PORT_STARTUP_RECOVERY.md');
add('docs/REPLY_PROTOCOL.md');
add('docs/PROMPT_POLICY.md');
add('docs/REQUEST_REJECTION.md');
add('docs/ASSISTANT_MODE.md');
add('docs/PLUGIN_CATALOG.md');
add('docs/EXTERNAL_DSH.md');
add('docs/ACCOUNT_SWITCH.md');
add('docs/SESSION_GROUPS.md');
add('scripts/persona-categories.mjs');
add('docs/PERSONA_CATEGORIES.md');
add('scripts/memory-console.mjs');
add('scripts/memory-console-worker.mjs');
add('docs/MEMORY_VIEW.md');
add('docs/FISH_NOTEBOOK.md');
add('scripts/hook-client-health.ps1');
for (const name of ['hook-profiles.mjs','wechat-client-selection.mjs','hook-build-policy.mjs','build-hook-current.ps1','load-hook-current.ps1','build-hook-42012.ps1','load-hook-42012.ps1']) add('scripts/'+name);
add('scripts/stop-legacy-services.ps1');
const scriptNames = ['wechat_files.py','file-delivery-worker.mjs','project-config.mjs','extension-status.mjs','bundled-extensions.mjs','update-check.mjs','migrate-io-config.mjs','manage.ps1','console-server.mjs','console-process.mjs','console-powershell.ps1','console-native.ps1','sync-weflow.cjs','hook-onebot.mjs','reader-api.py','reader-requirements.txt','wechat_media.py','wechat_sticker.py','wechat_sticker_send.py','wechat_forwarded.py','resolve-wechat-image.py','list-friend-ids.mjs','manage-dsh-sessions.mjs','launch-hook-wechat.ps1','pin-hook-client.ps1','launch-dsh.ps1','check-runtime.ps1','setup.ps1','build-hook.ps1'];
for (const name of [...scriptNames, 'wechat_group_bindings.py', 'dsh-configuration.mjs', 'process-recovery.mjs', 'process-recovery.ps1', 'check-runtime.py', 'wechat_meme_library.py', 'wechat_sticker_labels.py', 'wechat_image_normalize.py', 'wechat_sticker_collection.py', 'wechat_quote.py', 'text-delivery-store.mjs', 'reader-setup.mjs', 'reader_setup.py', 'reader-account-state.mjs','wechat-account-check.mjs']) add('scripts/' + name);
addTree('scripts/native-hook');
for (const name of ['nt_decrypt.py','nt_common.py']) add('components/weflow-cli/scripts/' + name);
add('components/weflow-cli/LICENSE');
add('components/weflow-cli/resources/key/win32/x64/wx_key.dll');
for (const directory of ['core','onebot','adapters/wechat','dsh']) addTree('components/qq-bridge/src/' + directory, name => !name.includes('.test.'));
for (const name of ['social-bridge.js','role-card.js','adapters/base-adapter.js']) add('components/qq-bridge/src/' + name);
add('components/qq-bridge/LICENSE');
add('components/qq-bridge/src/safe-fetch.js');
addTree('packages/extension-runtime', (name, dir) => dir || /\.(mjs|md)$/.test(name));
addTree('packages/plugin-api', (name, dir) => dir || /\.(mjs|md)$/.test(name));
add('docs/PLUGIN_DEVELOPMENT.md');
add('scripts/plugin-host-check.mjs');
add('scripts/plugin-settings-actions.mjs');add('scripts/voice-host-status.mjs');
add('scripts/plugin-config-ui.mjs');
add('scripts/plugin-ui.mjs');
add('scripts/pack-bundled-plugins.mjs');
add('docs/VOICE_INPUT.md');
for(const name of ['wechat_voice_input.py','decode-wechat-voice.py','decode-wechat-voice.mjs','voice-requirements.txt'])add('scripts/'+name);
for(const file of ['package.json','LICENSE','PROVENANCE.json','lib/index.mjs','lib/silk.wasm'])add('packages/voice-codec/silk-wasm/'+file);
add('scripts/pack-plugin.mjs');
for(const bundle of BUNDLED_PLUGINS){
  for(const file of bundle.files)add(bundle.source+'/'+file);
  if(bundle.zip){add(bundle.zip);add(bundle.zip+'.sha256');}
}
add('optional-extensions/packages/README.md');
addTree('extensions/skills/meme-search', (name, dir) => dir || /\.(js|json|md)$/.test(name));
fs.writeFileSync(path.join(project, 'components/qq-bridge/package.json'), JSON.stringify({ name:'wechatagent-social-bridge', type:'module', private:true, license:'MIT' })); files.push('components/qq-bridge/package.json');
const bridgeFile = path.join(project, 'components/qq-bridge/src/social-bridge.js');
fs.writeFileSync(bridgeFile, fs.readFileSync(bridgeFile, 'utf8').replace('这是蓝色大肥鱼的 AI 接入测试。', '这是微信助手的 AI 接入测试。'));
addTree('packages/dsh-social-bridge-plugin', (name, dir) => name !== '.git' && name !== '.bin' && (dir || /\.(mjs|js|json|yml|yaml|md|txt|ts|map)$/.test(name) || /^LICENSE|^NOTICE/.test(name)));
addTree('components/WeChat-Hook', (name, dir) => !['.git','x64','Debug','Release','防止微信自动更新','运行库'].includes(name) && (dir || !/\.(exe|dll|pdb|zip|7z|log)$/i.test(name)));
const provenance = {};
for (const file of files.filter(name => name.startsWith('components/WeChat-Hook/'))) provenance[file.slice('components/WeChat-Hook/'.length)] = sha(fs.readFileSync(path.join(project, file)));
fs.writeFileSync(path.join(project, 'components/WeChat-Hook/UPSTREAM.json'), JSON.stringify({ commit:'e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6', files:provenance }, null, 2)); files.push('components/WeChat-Hook/UPSTREAM.json');
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name:'wechatagent-runtime', version:packageVersion, releaseVersion:version, type:'module', private:true }, null, 2)); files.push('package.json');
await assertPluginHost(project,{compareRoot:root});

copyFile(process.execPath, path.join(stage, 'runtime/node.exe'));
if (!fs.existsSync(path.join(stage, 'runtime/python/python.exe'))) throw new Error('Run prepare-installer-runtime.mjs first.');
copyFile(path.join(clientSource, 'Weixin.exe'), path.join(vendor, 'wechat/Weixin.exe'));
copyTree(path.join(clientSource, wechatVersion), path.join(vendor, 'wechat',wechatVersion), name => !/\.disabled$|\.log$|\.token$/.test(name));
if(legacyBuild)for (const name of ['version.dll','build.json']) copyFile(path.join(root, 'state/hook/native', name), path.join(vendor, 'hook', name));
if(currentBuild)for(const name of ['wechatagent-text-'+wechatVersion+'.dll','wechatagent-text-loader.exe','build.json'])copyFile(path.join(root,'state/hook/native-'+wechatVersion,name),path.join(vendor,'hook-current',name));
const bundledVersionDirectories=fs.readdirSync(path.join(vendor,'wechat'),{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>item.name);
if(bundledVersionDirectories.length!==1||bundledVersionDirectories[0]!==wechatVersion||currentBuild&&fs.existsSync(path.join(vendor,'hook')))throw new Error('Installer contains another WeChat client or legacy sender.');
const pluginTemplate = path.join(project, 'packages/dsh-social-bridge-plugin/cordis.patch.yml');
fs.writeFileSync(pluginTemplate, fs.readFileSync(pluginTemplate, 'utf8')
  .replace(/file:\/\/\/[^"'\r\n]*\/dsh-social-bridge-plugin\/([A-Za-z0-9_-]+\.mjs)(?:\?[^"'\r\n]*)?/g, 'dsh-social-bridge-plugin/$1'));
const fileList = [...new Set(files)].sort();
const sourceHashes = Object.fromEntries(fileList.map(file => [file, sha(fs.readFileSync(path.join(project,file)))]));
const desktopHashes = Object.fromEntries(fs.readdirSync(appDir).filter(file=>fs.statSync(path.join(appDir,file)).isFile()).sort().map(file=>[file,sha(fs.readFileSync(path.join(appDir,file)))]));
const runtimeRevision = sha(Buffer.from(JSON.stringify({node:sha(fs.readFileSync(process.execPath)),python:fs.readFileSync(path.join(stage,'runtime/python/DEPENDENCIES.json'),'utf8')}))).slice(0,12);
const buildId = sha(Buffer.from(JSON.stringify({sourceHashes,desktopHashes,runtimeRevision,hook:legacyBuild?.sha256??null,currentHook:currentBuild?.sha256??null,currentLoader:currentBuild?.loaderSha256??null}))).slice(0,16);
fs.writeFileSync(path.join(project, 'deployment.json'), JSON.stringify({ version, packageVersion, buildId, builtAt:new Date().toISOString(), runtimeRevision, wechatVersion, bundledWechatVersions:[wechatVersion], nativeProfile:currentBuild?.profile??null, sourceHashes, files:fileList, presets:presetNames.map(name=>name.slice(0,-3)), node:process.version, python:'3.13.16', dshBundled:false,dshSdkVersion:DSH_SDK_VERSION,dshInstallUrl:DSH_INSTALL_URL, privateAccountDataIncluded:false, authorization:'Maintainer confirmed redistribution authorization for all currently used components and requested all current role files as bundled presets on 2026-10-05.' }, null, 2));
// No personal data can enter the deployment template or vendor programs.
for (const file of fs.readdirSync(project, { recursive:true })) {
  const relative = String(file).replaceAll('\\','/');
  if (/^state\/|(^|\/)wechatagent\.json$|social-dsh-token|native-token|\.env$|WeFlow-config\.json$/.test(relative)) throw new Error('Private file entered the release: ' + relative);
}
for (const file of fs.readdirSync(vendor, { recursive:true })) if (/wechatagent-hook\.token|native-token|social-messages|WeFlow-config\.json|^.*\/\.dsh\//.test(String(file).replaceAll('\\','/'))) throw new Error('Private vendor file entered the release: ' + file);
const notices = 'WeChatAgent '+version+'\n\nRedistribution authorization for the bundled WeChat client and WeChat-Hook components was confirmed by the maintainer on 2026-10-05. This statement does not replace their respective license terms.\n\nBundled components: Electron, Node.js, Python 3.13.16, SQLCipher Python binding, cryptography, zstandard, pycryptodome, Pillow, imageio-ffmpeg, cffi, pycparser, MIT weflow-cli NT reader sources, MIT Social Bridge sources and the local DSH bridge plugin/SDK. The DSH desktop program is installed separately by the user.\n\nPython and wheel licenses are retained in runtime/python and its site-packages/*.dist-info directories. Electron/Chromium and vendor notices are retained with their programs. Refer to project/LICENSES.md for source attribution and license boundaries. No account, credential, chat or whitelist data is included. Maintainer-authorized persona files are included as presets.\n';
fs.writeFileSync(path.join(appDir, 'THIRD-PARTY-NOTICES.txt'), notices);
copyFile(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE.txt'));
const { build, Platform, Arch } = require('electron-builder');
const templateDir = path.dirname(require.resolve('app-builder-lib/package.json')) + '/templates/nsis';
const customNsis = path.join(stage, 'nsis-templates'); fs.mkdirSync(customNsis, { recursive:true });
copyTree(templateDir, customNsis);
let multiUser = fs.readFileSync(path.join(templateDir, 'multiUser.nsh'), 'utf8');
const originalFolderLookup = /      System::Store S[\s\S]*?      System::Store L\r?\n/;
if (!originalFolderLookup.test(multiUser)) throw new Error('NSIS per-user path template differs; inspect before building.');
multiUser = multiUser.replace(originalFolderLookup, '      # Current-user LocalAppData avoids the old System::Store memory fault.\n');
fs.writeFileSync(path.join(customNsis, 'multiUser.nsh'), multiUser);
const assistedFile=path.join(customNsis,'assistedInstaller.nsh');
const assisted=fs.readFileSync(assistedFile,'utf8');
fs.writeFileSync(assistedFile,singleDirectoryTemplate(assisted));
// User data is outside the install directory and deleteAppDataOnUninstall is
// false. Standard removal avoids the legacy uninstaller's atomic rename,
// which fails across drives and on long bundled LibreOffice file paths.
const installUtilFile = path.join(customNsis,'include/installUtil.nsh');
let installUtil = fs.readFileSync(installUtilFile,'utf8');
const updatedArgument = '    StrCpy $0 "$0 --updated"';
if (!installUtil.includes(updatedArgument)) throw new Error('NSIS update template differs; inspect before building.');
installUtil = installUtil.replace(updatedArgument,'    # Keep AppData and use standard removal for large vendor runtimes.');
fs.writeFileSync(installUtilFile,installUtil);
const uninstallFile=path.join(customNsis,'uninstaller.nsh');
let uninstall=fs.readFileSync(uninstallFile,'utf8');
if(!uninstall.includes('    RMDir /r $INSTDIR'))throw new Error('NSIS removal template differs; inspect before building.');
uninstall=uninstall.replace('    RMDir /r $INSTDIR','    RMDir /r $INSTDIR\n    # Remove paths beyond MAX_PATH after ordinary files.\n    RMDir /r "\\\\?\\$INSTDIR"');
fs.writeFileSync(uninstallFile,uninstall);
// Redirect this build's templates without modifying installed builder files;
// keep its standard installer/uninstaller generation and relative includes.
require('app-builder-lib/out/targets/nsis/nsisUtil').nsisTemplatesDir = customNsis;
process.env.ELECTRON_BUILDER_CACHE = path.join(root, 'state', 'installer-cache', 'electron-builder');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '1';
await build({ targets:Platform.WINDOWS.createTarget('nsis', Arch.x64), config: {
  appId:'local.wechatagent.desktop', productName:'WeChatAgent', artifactName:'WeChatAgent-Setup-'+version+'-${arch}.${ext}',
  buildVersion,
  directories:{app:appDir, output:path.join(root,'release','installer'), buildResources:appDir},
  electronDist:path.join(root,'node_modules/electron/dist'), electronVersion:'41.1.1',
  asar:false, npmRebuild:false, buildDependenciesFromSource:false, files:['**/*'],
  afterPack: async context => embedExecutableIcon(path.join(context.appOutDir, 'WeChatAgent.exe'), path.join(appDir, 'icon.ico'), require('resedit')),
  extraResources:[{from:project,to:'project'},{from:path.join(stage,'runtime'),to:'runtime',filter:['**/*','!**/__pycache__/**','!**/*.pyc']},{from:vendor,to:'vendor'}],
  win:{target:['nsis'], icon:path.join(appDir,'icon.ico'), signAndEditExecutable:false, requestedExecutionLevel:'asInvoker'},
  nsis:{include:path.join(root,'apps/console-desktop/installer-storage.nsh'),installerIcon:path.join(appDir,'icon.ico'), uninstallerIcon:path.join(appDir,'icon.ico'), oneClick:false, perMachine:false, allowElevation:false, allowToChangeInstallationDirectory:true, createDesktopShortcut:true, createStartMenuShortcut:true, deleteAppDataOnUninstall:false, differentialPackage:false, runAfterFinish:false, installerLanguages:['zh_CN','en_US'], language:'2052', license:path.join(appDir,'LICENSE.txt')},
  compression:'normal', publish:null,
} });
console.log('Installer built in release/installer');
