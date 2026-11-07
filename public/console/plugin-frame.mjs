// Host side of the plugin page bridge. The page runs in an opaque-origin
// sandbox; it can only reach the handlers passed in here, all of which are
// bound to one plugin id by the caller.
export const FRAME_SANDBOX = 'allow-scripts allow-forms';
export const THEME_VARIABLES = Object.freeze(['bg', 'surface', 'surface-2', 'surface-3', 'text', 'muted', 'border', 'accent', 'accent-hover', 'accent-soft', 'accent-text', 'ok', 'warn', 'warn-soft', 'error', 'error-soft', 'on-accent', 'radius', 'body-font', 'mono']);
const MAX_ACTIVE = 8;

export function themeSnapshot(doc = document, view = doc.defaultView) {
  const style = view.getComputedStyle(doc.documentElement), vars = {};
  for (const name of THEME_VARIABLES) vars['--wa-' + name] = style.getPropertyValue('--' + name).trim().slice(0, 200);
  return { mode: doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', vars };
}

const clean = value => {
  try { return structuredClone(value ?? null); } catch { throw Error('插件页面返回了无法传递的数据。'); }
};

export function mountPluginFrame({ container, src, title, height = 420, minHeight = 120, maxHeight = 2000, fixedHeight = false, handlers, win = window, doc = document }) {
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', FRAME_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', title);
  frame.className = 'plugin-frame';
  const clamp = value => Math.round(Math.min(maxHeight, Math.max(minHeight, Number(value) || minHeight)));
  if (!fixedHeight) frame.style.height = clamp(height) + 'px';
  frame.src = src;
  let active = 0, closed = false, sequence = 0;
  const pending = new Map();
  const post = message => { if (!closed) frame.contentWindow?.postMessage({ wa: 1, ...message }, '*'); };
  const bridge = {
    frame,
    get closed() { return closed; },
    resize(value) { if (!fixedHeight && !closed) frame.style.height = clamp(value) + 'px'; return { height: fixedHeight ? frame.clientHeight : clamp(value) }; },
    emit(event, payload) { post({ type: 'event', event, payload: clean(payload) }); },
    // Host -> page request, e.g. "collect" before the host saves settings.
    request(method, params = {}, timeoutMs = 2000) {
      if (closed) return Promise.reject(Error('插件页面已关闭。'));
      const id = 'h' + ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(Error('插件页面没有响应。'), { timeout: true })); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        post({ type: 'request', id, method, params: clean(params) });
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      win.removeEventListener('message', onMessage);
      observer?.disconnect();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('插件页面已关闭。')); }
      pending.clear();
      frame.remove();
    },
  };
  async function onMessage(event) {
    if (closed || !frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.wa !== 1) return;
    if (data.type === 'response') {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      if (data.ok) item.resolve(data.result ?? null);
      else item.reject(Error(String(data.error ?? '插件页面未完成操作。').slice(0, 300)));
      return;
    }
    if (data.type !== 'request' || !['string', 'number'].includes(typeof data.id) || String(data.id).length > 64) return;
    const reply = message => post({ type: 'response', id: data.id, ...message });
    if (typeof data.method !== 'string' || !Object.hasOwn(handlers, data.method)) return reply({ ok: false, error: '不支持的宿主接口：' + String(data.method).slice(0, 40) });
    if (active >= MAX_ACTIVE) return reply({ ok: false, error: '请求过多，请稍后再试。' });
    active++;
    try {
      const params = data.params && typeof data.params === 'object' && !Array.isArray(data.params) ? data.params : {};
      reply({ ok: true, result: clean(await handlers[data.method](params, bridge)) });
    } catch (error) {
      reply({ ok: false, error: String(error?.message ?? '操作失败。').slice(0, 300) });
    } finally {
      active--;
    }
  }
  win.addEventListener('message', onMessage);
  frame.addEventListener('load', () => bridge.emit('theme', themeSnapshot(doc)));
  const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => bridge.emit('theme', themeSnapshot(doc))) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  container.append(frame);
  return bridge;
}
