const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectDirectory, safeNavigation, externalWebUrl, windowPlacement } = require('./desktop-policy.cjs');
const { bootstrapDeployment } = require('./deployment.cjs');
const { createAppearanceStore, strengthOf } = require('./appearance.cjs');
const {createShutdownController}=require('./shutdown.cjs');
const {resolveStorageLocation,migrationPlan,retainDsh,deploymentStorageOptions,prepareDataHome,rebindExternalDsh,stopLegacyServices}=require('./storage-location.cjs');

app.setName('WeChatAgent');
app.setAppUserModelId('local.wechatagent.desktop');
const installedDistribution = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'project', 'deployment.json'));
const legacyHome=path.join(app.getPath('appData'),'WeChatAgent');
let storage=null,storageFailure=null;
try{if(installedDistribution)storage=resolveStorageLocation({appDir:path.dirname(process.resourcesPath),legacyHome,override:process.env.WECHATAGENT_TEST_DATA_HOME});}catch(error){storageFailure=error;}
const deploymentHome = storage?.dataHome || process.env.WECHATAGENT_TEST_DATA_HOME || legacyHome;
let deployment = null;
const root = installedDistribution ? path.join(deploymentHome, 'workspace') : projectDirectory(process.resourcesPath, __dirname, app.isPackaged);
let dataDirectory = installedDistribution ? path.join(deploymentHome,'desktop') : path.join(root, 'state', 'desktop');
try{if(storageFailure)throw storageFailure;fs.mkdirSync(dataDirectory,{recursive:true});}catch(error){storageFailure=Error('无法使用所选数据位置，请确认磁盘已连接且目录可写。\n'+error.message);dataDirectory=path.join(require('node:os').tmpdir(),'WeChatAgent-startup-'+process.pid);fs.mkdirSync(dataDirectory,{recursive:true});}
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'session'));
const preferenceFile = path.join(dataDirectory, 'window.json');
let preferences = {};
try { preferences = JSON.parse(fs.readFileSync(preferenceFile, 'utf8')); } catch {}
const appearanceStore = createAppearanceStore(dataDirectory, nativeImage);
let window, tray, consoleApp, origin; let quitting = false, quitApproved=false, quitCheck=null;
// 窗口按钮叠加层：背景透明，让控制台的玻璃顶栏从按钮下方透出；高度与桌面模式顶栏（56px）一致，
// 只有图标颜色随主题变化。悬停底色与关闭键红色由系统绘制。
// 主题预设（预设名、主看板布局、进入方舟预设前的明暗）：只接受简单的标识符，其余字段丢弃
const presetOf = value => {
  const id = item => (typeof item === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(item) ? item : null);
  return { name: id(value?.name), layout: id(value?.layout), prevTheme: ['light', 'dark'].includes(value?.prevTheme) ? value.prevTheme : null };
};
const titleBarOverlay = theme => ({ color: 'rgba(0,0,0,0)', symbolColor: theme === 'dark' ? '#e5ebe7' : '#26332e', height: 56 });
const savePreferences = () => {
  const temp = preferenceFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(preferences, null, 2)); fs.renameSync(temp, preferenceFile);
};
const bringForward = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
function queryUnsavedChanges() {
  if(!window||window.isDestroyed()||window.webContents.isDestroyed())return Promise.resolve(false);
  return new Promise(resolve=>{
    const id=require('node:crypto').randomUUID();
    const answer=value=>{if(quitCheck?.id!==id)return;clearTimeout(quitCheck.timer);quitCheck=null;resolve(value);};
    quitCheck={id,answer,timer:setTimeout(()=>answer(true),2000)};
    try{window.webContents.send('desktop:check-unsaved',id);}catch{answer(true);}
  });
}
const shutdown=createShutdownController({
  confirm:async()=>{
    if(await queryUnsavedChanges()){
      const response=dialog.showMessageBoxSync(window,{type:'question',title:'有未保存的设置',message:'退出会放弃未保存的更改，并停止本实例的后台服务。',buttons:['继续编辑','放弃更改并退出'],defaultId:0,cancelId:0});
      if(response!==1)return false;
    }
    quitApproved=true;return true;
  },
  stop:async()=>{if(consoleApp)await consoleApp.shutdown();},
  finish:()=>{quitting=true;app.quit();},
  onState:state=>{
    if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('desktop:shutdown-state',state);
    if(tray&&!tray.isDestroyed())tray.setToolTip(state==='stopping'?'WeChatAgent · 正在停止后台服务':'WeChatAgent');
  },
  onError:error=>{quitApproved=false;quitting=false;bringForward();dialog.showErrorBox('退出未完成',error.message+'\n程序已保留，请检查运行日志后重试。');},
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', bringForward);
  app.on('activate', bringForward);
  Menu.setApplicationMenu(null);
  app.whenReady().then(async () => {
    if(storageFailure)throw storageFailure;
    let loadingWindow;
    if (installedDistribution) {
      loadingWindow = new BrowserWindow({ width:480, height:280, resizable:false, title:'WeChatAgent', icon:path.join(__dirname,'icon.png'), backgroundColor:'#f3f5f4', webPreferences:{preload:path.join(__dirname,'loading-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false} });
      loadingWindow.setMenu(null);
      await loadingWindow.loadFile(path.join(__dirname,'loading.html'));
      const progress=message=>{if(!loadingWindow.isDestroyed())loadingWindow.webContents.send('deployment:progress',message);};
      let plan=migrationPlan(storage);
      if(plan.needed){
        const answer=dialog.showMessageBoxSync(loadingWindow,{type:'question',title:'迁移旧版数据',message:'发现已有的 WeChatAgent 数据',detail:'从：'+plan.source+'\n到：'+plan.dataHome+'\n\n会停止旧实例管理的后台服务，再复制并校验配置、人设、表情包和会话状态，保留旧副本。请先退出旧版窗口和匹配微信。\n\n选择“保留旧 DSH”会跳过 DSH 数据迁移，保留其原位置、会话、附件和配置并继续启动；启动后需在 DSH 中手动重新添加新版插件目录。选择完整迁移时，请先从托盘退出 DSH。',buttons:['停止旧服务并迁移','保留旧 DSH','暂不启动'],defaultId:1,cancelId:2});
        if(answer!==0&&answer!==1){quitting=true;app.quit();return;}
        if(answer===1)plan=retainDsh(plan);
        progress('正在停止旧实例管理的后台服务…');await stopLegacyServices(plan,process.resourcesPath);
      }
      let migrated;
      try{migrated=await prepareDataHome(plan,{progress});}catch(error){
        if(error.code!=='DSH_EXTERNAL_LINK'||plan.dshRetained)throw error;
        const answer=dialog.showMessageBoxSync(loadingWindow,{type:'warning',title:'保留旧 DSH 数据',message:'旧 DSH 包含外部链接，无法自动迁移',detail:error.message+'\n\n可保留旧 DSH 原位置，仅迁移 WeChatAgent 的数据并继续启动。不会复制、删除或修改旧 DSH 数据；启动后需手动重新添加新版插件目录。',buttons:['保留旧 DSH 并继续','暂不启动'],defaultId:0,cancelId:1});
        if(answer!==0){quitting=true;app.quit();return;}
        plan=retainDsh(plan);migrated=await prepareDataHome(plan,{progress});
      }
      deployment = await bootstrapDeployment(process.resourcesPath, deploymentHome, progress, deploymentStorageOptions(migrated.report,deploymentHome));
      await rebindExternalDsh(migrated.report,root,deploymentHome);
      try{preferences=fs.existsSync(preferenceFile)?JSON.parse(fs.readFileSync(preferenceFile,'utf8')):{};}catch{preferences={};}
    }
    const runtimeNode = deployment?.node ?? (app.isPackaged ? path.join(process.resourcesPath, '..', 'runtime', 'node.exe') : process.env.WECHATAGENT_NODE_EXECUTABLE);
    if (!runtimeNode || !fs.existsSync(runtimeNode)) throw new Error('找不到桌面应用的 Node.js 运行环境，请重新构建应用。');
    process.env.PATH = path.dirname(runtimeNode) + path.delimiter + (process.env.PATH ?? '');
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.PSModulePath;
    const { createConsole } = await import(pathToFileURL(path.join(root, 'scripts/console-server.mjs')).href);
    if (deployment) {
      const { prepare } = await import(pathToFileURL(path.join(root, 'scripts/project-config.mjs')).href);
      prepare(root);
    }
    consoleApp = createConsole({ root, port: 0, nodeExecutable: runtimeNode,
      onQuit: () => app.quit(),
      filePicker: async kind => {
        const result = await dialog.showOpenDialog(window, { title: kind === 'workspace' ? '选择工作区目录' : kind === 'folder' ? '选择微信数据库目录' : '选择程序', properties: ['folder','workspace'].includes(kind) ? ['openDirectory'] : ['openFile'], ...(kind === 'exe' ? { filters: [{ name: '程序', extensions: ['exe'] }] } : {}) });
        return result.canceled ? '' : result.filePaths[0];
      },
    });
    const address = await consoleApp.start(); origin = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(path.join(dataDirectory, 'runtime.json'), JSON.stringify({ pid: process.pid, port: address.port, root, startedAt: Date.now() }, null, 2));
    const theme = preferences.theme === 'dark' ? 'dark' : 'light';
    const iconPath = path.join(__dirname, 'icon.png');
    const iconImage = nativeImage.createFromPath(iconPath);
    const savedBounds = preferences.bounds;
    const area = savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y) ? screen.getDisplayNearestPoint({ x: savedBounds.x, y: savedBounds.y }).workArea : screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({ ...windowPlacement(savedBounds, area), minWidth: Math.min(900, area.width), minHeight: Math.min(620, area.height), title: 'WeChatAgent', icon: iconPath, show: false,
      titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(theme),
      backgroundColor: theme === 'dark' ? '#121815' : '#ecf2ee',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, spellcheck: false },
    });
    const trusted = event => event.sender === window.webContents && safeNavigation(event.senderFrame?.url ?? '', origin);
    ipcMain.on('desktop:unsaved-answer',(event,id,value)=>{if(trusted(event)&&quitCheck?.id===id&&typeof value==='boolean')quitCheck.answer(value);});
    ipcMain.on('desktop:initial', event => { event.returnValue = event.sender === window.webContents ? { theme: preferences.theme ?? theme, appearance:appearanceStore.read(preferences.appearance), preset: presetOf(preferences.preset) } : {}; });
    ipcMain.handle('desktop:appearance-choose', async event => {
      if (!trusted(event)) throw new Error('不允许此窗口修改背景。');
      const result = await dialog.showOpenDialog(window,{title:'选择背景图片',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg']}]});
      if(result.canceled || !result.filePaths[0])return {canceled:true};
      preferences.appearance = await appearanceStore.importFile(result.filePaths[0],preferences.appearance);
      savePreferences();return appearanceStore.read(preferences.appearance);
    });
    ipcMain.handle('desktop:appearance-strength',(event,value)=>{
      if(!trusted(event)||!Number.isFinite(value))throw new Error('背景强度无效。');
      preferences.appearance={...preferences.appearance,strength:strengthOf(value)};savePreferences();return {strength:preferences.appearance.strength};
    });
    ipcMain.handle('desktop:appearance-reset',event=>{
      if(!trusted(event))throw new Error('不允许此窗口修改背景。');
      appearanceStore.reset();delete preferences.appearance;savePreferences();return appearanceStore.read();
    });
    ipcMain.handle('desktop:theme', (event, value) => {
      if (!trusted(event) || !['light', 'dark'].includes(value)) return;
      preferences.theme = value; savePreferences();
      window.setTitleBarOverlay(titleBarOverlay(value));
    });
    ipcMain.handle('desktop:preset', (event, value) => {
      if (!trusted(event)) return;
      preferences.preset = presetOf(value); savePreferences();
    });
    ipcMain.handle('desktop:export-log', async (event, payload) => {
      if (!trusted(event) || typeof payload?.text !== 'string' || payload.text.length > 250000) throw new Error('日志内容无效。');
      const name = typeof payload.name === 'string' && /^[a-zA-Z0-9._-]+\.log$/.test(payload.name) ? payload.name : 'wechatagent.log';
      const result = await dialog.showSaveDialog(window, { title: '保存运行日志', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: '日志文件', extensions: ['log', 'txt'] }] });
      if (result.canceled) return { saved: false };
      await fs.promises.writeFile(result.filePath, payload.text, 'utf8'); return { saved: true };
    });
    ipcMain.handle('desktop:plugin-path', event => {
      if (!trusted(event)) return;
      require('electron').clipboard.writeText(path.join(root, 'packages', 'dsh-social-bridge-plugin'));
    });
    ipcMain.handle('desktop:plugin-folder', event => {
      if (!trusted(event)) return;
      return require('electron').shell.openPath(path.join(root, 'packages', 'dsh-social-bridge-plugin'));
    });
    const openExternal = async target => {
      const url = externalWebUrl(target);
      if (!url) throw new Error('只允许打开公开的 HTTP(S) 网页链接。');
      await shell.openExternal(url);
      return { opened:true };
    };
    ipcMain.handle('desktop:open-external', (event, target) => {
      if (!trusted(event)) throw new Error('不允许此窗口打开外部链接。');
      return openExternal(target);
    });
    const navigationExternal = target => { if (externalWebUrl(target)) openExternal(target).catch(error => dialog.showErrorBox('无法打开链接',error.message)); };
    window.webContents.setWindowOpenHandler(({url}) => { navigationExternal(url); return { action:'deny' }; });
    window.webContents.on('will-navigate', (event, target) => {
      if (!safeNavigation(target, origin)) { event.preventDefault(); navigationExternal(target); }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('will-prevent-unload', event => {
      if(quitApproved&&shutdown.finished){event.preventDefault();return;}
      const response = dialog.showMessageBoxSync(window, { type: 'question', title: '有未保存的设置', message: '退出会放弃未保存的更改。', buttons: ['继续编辑', '放弃更改并退出'], defaultId: 0, cancelId: 0 });
      if (response === 1) event.preventDefault(); else quitting = false;
    });
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); window.hide(); return; }
      if (!window.isMaximized()) preferences.bounds = window.getBounds();
      preferences.maximized = window.isMaximized(); savePreferences();
    });
    window.once('ready-to-show', () => { if (preferences.maximized) window.maximize(); window.show(); if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.destroy(); });
    window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle('WeChatAgent'); });
    tray = new Tray(iconImage.resize({ width: 20, height: 20 }));
    tray.setToolTip('WeChatAgent');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 WeChatAgent', click: bringForward }, { type: 'separator' }, { label: '退出应用', click: () => app.quit() }]));
    tray.on('double-click', bringForward); tray.on('click', bringForward);
    await window.loadURL(origin + '/');
  }).catch(error => {
    dialog.showErrorBox('WeChatAgent 启动失败', error.message); quitting = true; app.quit();
  });
  app.on('before-quit', event => {
    if(shutdown.finished||!consoleApp){quitting=true;return;}
    event.preventDefault();quitting=false;
    if(shutdown.running)return;
    if (consoleApp?.isBusy()) {
      event.preventDefault(); quitting = false; bringForward();
      dialog.showMessageBox(window, { type: 'info', title: '操作正在进行', message: '请等待当前操作完成后再退出应用。', buttons: ['知道了'] });
      return;
    }
    void shutdown.request();
  });
  app.on('will-quit', () => {
    if (tray) tray.destroy(); consoleApp?.close();
    const runtimeFile=path.join(dataDirectory,'runtime.json');
    try{if(JSON.parse(fs.readFileSync(runtimeFile,'utf8')).pid===process.pid)fs.unlinkSync(runtimeFile);}catch{}
  });
}
