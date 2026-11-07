import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Package-owned pages run in an opaque-origin sandbox. The console only reads
// ui.json and static files below ui/; plugin.json and the DSH host never see it.
export const UI_ROOT = 'ui';
export const SDK_NAME = '__sdk.mjs';
export const UI_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
});
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const sdkFile = fileURLToPath(new URL('../public/console/plugin-page-sdk.mjs', import.meta.url));

export function uiSegments(value) {
  if (typeof value !== 'string' || !value || value.length > 240) return null;
  const parts = value.split('/');
  if (parts.length > 8 || parts.some(part => !SEGMENT.test(part) || part.endsWith('.') || RESERVED.test(part))) return null;
  return parts;
}

export function validatePluginUi(value) {
  const invalid = () => { throw Error('插件页面声明无效，请检查 ui.json。'); };
  const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => allowed.includes(key));
  const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
  const entry = s => { const parts = uiSegments(s); return !!parts && parts.at(-1).toLowerCase().endsWith('.html') && parts.at(-1) !== SDK_NAME; };
  if (!keys(value, ['version', 'settings', 'page']) || value.version !== 1 || (value.settings === undefined && value.page === undefined)) invalid();
  if (value.settings !== undefined && (!keys(value.settings, ['entry', 'height', 'actions']) || !entry(value.settings.entry) || value.settings.height !== undefined && (!Number.isInteger(value.settings.height) || value.settings.height < 120 || value.settings.height > 2000))) invalid();
  // Settings actions run from the settings page before the plugin is enabled,
  // so they must be named here explicitly; DSH-loaded actions stay chat-bound.
  const actions = value.settings?.actions;
  if (actions !== undefined && (!Array.isArray(actions) || actions.length > 8 || new Set(actions).size !== actions.length || actions.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,19}$/.test(id)))) invalid();
  if (value.page !== undefined && (!keys(value.page, ['entry', 'title', 'description']) || !entry(value.page.entry) || !text(value.page.title, 40) || value.page.description !== undefined && !text(value.page.description, 200))) invalid();
  return structuredClone(value);
}

// Resolves a file below plugins/<id>/ui without following links.
export function uiFile(root, id, relative) {
  const parts = uiSegments(relative);
  if (!parts) return null;
  let current = path.join(path.resolve(root), 'plugins');
  for (const part of [id, UI_ROOT, ...parts]) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); } catch { return null; }
    if (info.isSymbolicLink()) return null;
  }
  const info = fs.statSync(current);
  return info.isFile() && info.size <= 4 * 1024 * 1024 ? current : null;
}

export function createPluginUiHost({root, secret}) {
  // cap -> package identity. Capabilities change with the package revision and
  // the console token, so outside pages cannot guess them and old URLs expire.
  const grants = new Map();
  const capability = item => crypto.createHmac('sha256', secret).update(item.id + ':' + item.revision).digest('hex').slice(0, 32);
  const folderStamp = id => { try { const info = fs.statSync(path.join(root, 'plugins', id)); return info.ino + ':' + info.birthtimeMs; } catch { return null; } };
  function describe(item) {
    if (item.invalid) return {};
    const folder = path.join(root, 'plugins', item.id), file = path.join(folder, 'ui.json');
    try {
      for (const target of [path.join(root, 'plugins'), folder]) if (fs.lstatSync(target).isSymbolicLink()) throw Error();
      if (!fs.existsSync(file)) return {};
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw Error();
      const ui = validatePluginUi(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
      for (const part of [ui.settings, ui.page]) if (part && !uiFile(root, item.id, part.entry)) throw Error();
      const cap = capability(item);
      for (const [key, grant] of grants) if (grant.id === item.id && key !== cap) grants.delete(key);
      grants.set(cap, {id: item.id, stamp: folderStamp(item.id)});
      const base = `/plugin-ui/${cap}/${item.id}/`;
      return {ui: {
        ...(ui.settings ? {settings: {url: base + ui.settings.entry, height: ui.settings.height ?? 420, actions: ui.settings.actions ?? []}} : {}),
        ...(ui.page ? {page: {url: base + ui.page.entry, title: ui.page.title, description: ui.page.description ?? ''}} : {}),
      }};
    } catch {
      return {uiError: '插件自定义页面不可用，已使用标准配置表单。'};
    }
  }
  function revoke(id) { for (const [key, grant] of grants) if (grant.id === id) grants.delete(key); }
  // Returns {file,type,base} for a granted request, or null for 404.
  function resolve(route) {
    const match = /^\/plugin-ui\/([a-f0-9]{32})\/([a-z][a-z0-9-]{0,39})\/(.+)$/.exec(route);
    if (!match) return null;
    const [, cap, id, raw] = match, grant = grants.get(cap);
    if (!grant || grant.id !== id || grant.stamp !== folderStamp(id)) return null;
    let relative;
    try { relative = decodeURIComponent(raw); } catch { return null; }
    const base = `/plugin-ui/${cap}/${id}/`;
    if (relative === SDK_NAME) return {file: sdkFile, type: UI_TYPES['.mjs'], base};
    const type = UI_TYPES[path.extname(relative).toLowerCase()];
    const file = type && uiFile(root, id, relative);
    return file ? {file, type, base} : null;
  }
  return {describe, revoke, resolve};
}

export function pluginUiHeaders(origin, base, type) {
  const self = origin + base;
  return {
    'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
    // The sandbox directive gives every plugin document an opaque origin even
    // when opened directly, so it can never read the console token or /api/*.
    'Content-Security-Policy': `sandbox allow-scripts allow-forms; default-src 'none'; script-src ${self}; style-src ${self} 'unsafe-inline'; img-src ${self} data: blob:; font-src ${self}; media-src ${self} data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
  };
}
