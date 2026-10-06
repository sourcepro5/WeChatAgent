const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectDirectory, safeNavigation, windowPlacement } = require('./desktop-policy.cjs');
const { bootstrapDeployment } = require('./deployment.cjs');

app.setName('WeChatAgent');
app.setAppUserModelId('local.wechatagent.desktop');
const installedDistribution = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'project', 'deployment.json'));
const deploymentHome = process.env.WECHATAGENT_TEST_DATA_HOME || path.join(app.getPath('appData'), 'WeChatAgent');
let deployment = null;
const root = installedDistribution ? path.join(deploymentHome, 'workspace') : projectDirectory(process.resourcesPath, __dirname, app.isPackaged);
const dataDirectory = path.join(root, 'state', 'desktop');
fs.mkdirSync(dataDirectory, { recursive: true });
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'session'));
const preferenceFile = path.join(dataDirectory, 'window.json');
let preferences = {};
try { preferences = JSON.parse(fs.readFileSync(preferenceFile, 'utf8')); } catch {}
let window, tray, consoleApp, origin; let quitting = false;
const savePreferences = () => {
  const temp = preferenceFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(preferences, null, 2)); fs.renameSync(temp, preferenceFile);
};
const bringForward = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', bringForward);
  app.on('activate', bringForward);
  Menu.setApplicationMenu(null);
  app.whenReady().then(async () => {
    let loadingWindow;
    if (installedDistribution) {
      loadingWindow = new BrowserWindow({ width:480, height:280, resizable:false, title:'WeChatAgent', icon:path.join(__dirname,'icon.png'), backgroundColor:'#f3f5f4', webPreferences:{preload:path.join(__dirname,'loading-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false} });
      loadingWindow.setMenu(null);
      await loadingWindow.loadFile(path.join(__dirname,'loading.html'));
      deployment = await bootstrapDeployment(process.resourcesPath, deploymentHome, message => { if (!loadingWindow.isDestroyed()) loadingWindow.webContents.send('deployment:progress', message); });
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
        const result = await dialog.showOpenDialog(window, { title: kind === 'folder' ? '选择微信数据库目录' : '选择程序', properties: kind === 'folder' ? ['openDirectory'] : ['openFile'], ...(kind === 'exe' ? { filters: [{ name: '程序', extensions: ['exe'] }] } : {}) });
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
      titleBarStyle: 'hidden', titleBarOverlay: { color: theme === 'dark' ? '#222a25' : '#ffffff', symbolColor: theme === 'dark' ? '#e5ebe7' : '#26332e', height: 48 },
      backgroundColor: theme === 'dark' ? '#181e1b' : '#f3f5f4',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, spellcheck: false },
    });
    const trusted = event => event.sender === window.webContents && safeNavigation(event.senderFrame?.url ?? '', origin);
    ipcMain.on('desktop:initial', event => { event.returnValue = event.sender === window.webContents ? { theme: preferences.theme ?? theme } : {}; });
    ipcMain.handle('desktop:theme', (event, value) => {
      if (!trusted(event) || !['light', 'dark'].includes(value)) return;
      preferences.theme = value; savePreferences();
      window.setTitleBarOverlay({ color: value === 'dark' ? '#222a25' : '#ffffff', symbolColor: value === 'dark' ? '#e5ebe7' : '#26332e', height: 48 });
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
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => { if (!safeNavigation(target, origin)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('will-prevent-unload', event => {
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
    if (consoleApp?.isBusy()) {
      event.preventDefault(); quitting = false; bringForward();
      dialog.showMessageBox(window, { type: 'info', title: '操作正在进行', message: '请等待当前操作完成后再退出应用。', buttons: ['知道了'] });
      return;
    }
    quitting = true;
  });
  app.on('will-quit', () => { if (tray) tray.destroy(); consoleApp?.close(); });
}
