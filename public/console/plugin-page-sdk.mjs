// WeChatAgent plugin page SDK. Served to plugin pages as ./__sdk.mjs relative
// to the page's ui/ folder: import wa from './__sdk.mjs'. It only wraps the
// postMessage protocol; pages may implement the protocol themselves.
const pending = new Map(), listeners = new Map(), handlers = new Map();
let sequence = 0, autoResize = true, lastHeight = 0;
const host = globalThis.parent;
const post = message => host.postMessage({ wa: 1, ...message }, '*');

globalThis.addEventListener('message', async event => {
  if (event.source !== host) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.wa !== 1) return;
  if (data.type === 'response') {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timer);
    data.ok ? item.resolve(data.result) : item.reject(new Error(data.error ?? '宿主未完成操作。'));
  } else if (data.type === 'event') {
    if (data.event === 'theme') applyTheme(data.payload);
    for (const listener of listeners.get(data.event) ?? []) try { listener(data.payload); } catch (error) { console.error(error); }
  } else if (data.type === 'request') {
    const handler = handlers.get(data.method);
    try { post({ type: 'response', id: data.id, ok: true, result: handler ? await handler(data.params ?? {}) : null }); }
    catch (error) { post({ type: 'response', id: data.id, ok: false, error: String(error?.message ?? error) }); }
  }
});

function call(method, params = {}, timeoutMs = 20000) {
  const id = 'p' + ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('宿主没有响应：' + method)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    post({ type: 'request', id, method, params });
  });
}

function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const root = document.documentElement;
  root.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light';
  root.style.colorScheme = root.dataset.theme;
  for (const [name, value] of Object.entries(theme.vars ?? {})) if (/^--wa-[a-z0-9-]+$/.test(name)) root.style.setProperty(name, String(value));
}

function measure() {
  if (!autoResize || !document.documentElement) return;
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (Math.abs(height - lastHeight) < 2) return;
  lastHeight = height;
  call('ui.resize', { height }).catch(() => {});
}
if (typeof ResizeObserver === 'function') {
  const start = () => { new ResizeObserver(measure).observe(document.documentElement); measure(); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();
}

export const wa = {
  /** {pluginId, name, version, enabled, active, status, mode:'settings'|'page', chats:[{key,name}], settingsActions, runAllowed, voice?} */
  info: () => call('host.info'),
  settings: {
    /** {values, schema}; secret values are always empty strings. */
    get: () => call('settings.get'),
    /** Saves plugin settings only; leave a secret empty to keep the stored value. */
    save: values => call('settings.save', { values }),
  },
  actions: {
    /** Calls one of this plugin's registerAction() actions for an authorised chat. */
    call: (action, args = {}, { key } = {}) => call('actions.call', { action, args, key }, 40000),
  },
  ui: {
    resize: height => call('ui.resize', { height }),
    toast: text => call('ui.toast', { text }),
    close: () => call('ui.close'),
    autoResize(enabled = true) { autoResize = !!enabled; if (enabled) measure(); },
  },
  /** Events: 'theme'; settings pages also get 'run-allowed' {runAllowed}. Returns an unsubscribe function. */
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(listener);
    return () => listeners.get(event)?.delete(listener);
  },
  /** Settings dialog: handler({enabled}) returns the values to save, or throws to block saving. */
  onCollect(handler) { handlers.set('collect', handler); },
};
export default wa;
