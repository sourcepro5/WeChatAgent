const path = require('node:path');
const fs = require('node:fs');

function projectDirectory(resourcesPath, sourceDirectory, packaged) {
  const root = packaged ? path.resolve(resourcesPath, '../../..') : path.resolve(sourceDirectory, '../..');
  for (const name of ['scripts/console-server.mjs', 'config/wechatagent.example.json', 'public/console/index.html']) {
    if (!fs.existsSync(path.join(root, name))) throw new Error('请将桌面应用保留在完整的 WeChatAgent 项目目录中。');
  }
  return root;
}

function safeNavigation(target, origin) {
  try { const url = new URL(target); return url.origin === origin && (url.pathname === '/' || url.pathname === '/index.html'); }
  catch { return false; }
}

function windowPlacement(saved = {}, workArea) {
  const width = Math.min(workArea.width, Math.max(Math.min(940, workArea.width), Number(saved.width) || Math.min(1240, workArea.width - 60)));
  const height = Math.min(workArea.height, Math.max(Math.min(620, workArea.height), Number(saved.height) || Math.min(850, workArea.height - 60)));
  const x = Number.isFinite(saved.x) ? Math.max(workArea.x, Math.min(saved.x, workArea.x + workArea.width - width)) : workArea.x + Math.round((workArea.width - width) / 2);
  const y = Number.isFinite(saved.y) ? Math.max(workArea.y, Math.min(saved.y, workArea.y + workArea.height - height)) : workArea.y + Math.round((workArea.height - height) / 2);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = { projectDirectory, safeNavigation, windowPlacement };
