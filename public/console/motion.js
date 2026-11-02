// WeChatAgent · Motion layer
// 纯展示增强：页面切换级联、导航滑块、按钮涟漪、数字滚动、卡片光斑、主题圆形扩散等。
// 不调用任何接口、不修改业务状态；系统开启"减少动态效果"时自动降级。
// CSP 兼容：仅通过 CSSOM（element.style.setProperty）写样式，无内联 style 属性。

const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => reduceQuery.matches;
const $ = selector => document.querySelector(selector);
const restartClass = (el, name) => { el.classList.remove(name); void el.offsetWidth; el.classList.add(name); };
const clearOnEnd = (el, ...names) => el.addEventListener('animationend', event => { if (event.target === el) el.classList.remove(...names); }, { once: true });

// ---------- 动态背景 ----------
function installAmbient() {
  const layer = document.createElement('div');
  layer.className = 'motion-ambient';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) layer.append(document.createElement('i'));
  document.body.prepend(layer);
}

// ---------- 首次进入级联 ----------
function boot() {
  if (reduced()) return;
  document.querySelectorAll('.sidebar .nav-caption, .sidebar nav a').forEach((el, i) => el.style.setProperty('--motion-i', String(i)));
  document.body.classList.add('motion-boot');
  setTimeout(() => document.body.classList.remove('motion-boot'), 1600);
}

// ---------- 侧边导航滑动指示器 ----------
// 液态位移：移动途中沿运动方向拉长、到位时轻微回弹，像一滴玻璃在导航间流动。
function jelly(pill, from, to) {
  const distance = to.y - from.y;
  const stretch = Math.min(.42, .1 + Math.abs(distance) / 480);
  pill.animate([
    { transform: `translateY(${from.y}px)`, height: from.h + 'px' },
    { transform: `translateY(${from.y + distance * .58}px) scale(${1 - stretch * .18},${1 + stretch})`, offset: .4 },
    { transform: `translateY(${to.y}px) scale(${1 + stretch * .08},${1 - stretch * .22})`, offset: .72 },
    { transform: `translateY(${to.y}px)`, height: to.h + 'px' },
  ], { duration: 640, easing: 'cubic-bezier(.3,.8,.25,1)' });
}
function installNavIndicator() {
  const nav = $('.sidebar nav');
  if (!nav) return;
  const pill = document.createElement('span');
  pill.className = 'motion-nav-indicator';
  pill.setAttribute('aria-hidden', 'true');
  nav.prepend(pill);
  let placed = null; // 上一次的位置 { link, y, h }；null 表示滑块当前未显示
  // animate=false 用于尺寸变化后的重新对齐：只更新位置，不播放流动动画
  const place = ({ animate = true } = {}) => {
    const link = nav.querySelector('a[aria-current=page]');
    if (!link?.offsetHeight) { nav.classList.remove('has-indicator'); placed = null; return; }
    const to = { link, y: link.offsetTop, h: link.offsetHeight };
    pill.style.setProperty('--y', to.y + 'px');
    pill.style.height = to.h + 'px';
    if (animate && placed && placed.link !== link && !reduced()) {
      restartClass(pill, 'is-moving');
      jelly(pill, placed, to);
    }
    placed = to;
    nav.classList.add('has-indicator');
  };
  new MutationObserver(() => place()).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current', 'hidden'] });
  new ResizeObserver(() => place({ animate: false })).observe(nav);
  place();
}

// ---------- 按钮涟漪 ----------
const RIPPLE_TARGETS = '.button,.icon-button,.power-control,.mode-option,.role-item,.chat-picker-item,.segmented button,.workspace-tabs>a,.workspace-tabs>button,.sidebar nav a,.action-menu>div>button';
function installRipple() {
  document.addEventListener('pointerdown', event => {
    if (reduced() || event.button !== 0) return;
    const target = event.target.closest?.(RIPPLE_TARGETS);
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const rect = target.getBoundingClientRect();
    const host = document.createElement('span');
    const dot = document.createElement('span');
    host.className = 'motion-ripple-host';
    host.setAttribute('aria-hidden', 'true');
    dot.className = 'motion-ripple';
    dot.style.setProperty('--size', Math.max(rect.width, rect.height) * 2.4 + 'px');
    dot.style.setProperty('--x', event.clientX - rect.left + 'px');
    dot.style.setProperty('--y', event.clientY - rect.top + 'px');
    host.append(dot);
    target.append(host);
    const remove = () => host.remove();
    dot.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 1200);
  }, { passive: true, capture: true });
}

// ---------- 卡片光斑跟随 ----------
function installSpotlight() {
  let frame = 0, last = null;
  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    last = event;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const card = last.target.closest?.('.card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', last.clientX - rect.left + 'px');
      card.style.setProperty('--my', last.clientY - rect.top + 'px');
    });
  }, { passive: true });
}

// ---------- 数字滚动 ----------
const counting = new WeakMap();
function countTo(el, from, to, duration = 900) {
  const node = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && /^\s*-?\d+\s*$/.test(n.data));
  if (!node || from === to || reduced()) return;
  const token = { to, active: true };
  counting.set(el, token);
  const start = performance.now();
  node.data = String(from);
  const step = now => {
    if (counting.get(el) !== token || !node.isConnected) return;
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    node.data = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step); else token.active = false;
  };
  requestAnimationFrame(step);
}
const readNumber = el => {
  const running = el && counting.get(el);
  if (running?.active) return running.to;
  const node = el && [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.data.trim());
  const value = node ? Number(node.data.trim()) : NaN;
  return Number.isFinite(value) ? value : null;
};

// ---------- 无限动画相位锁定（轮询重绘时不跳帧） ----------
const LOOPS = new Set(['motion-ping', 'motion-flow', 'motion-blink', 'motion-shimmer', 'motion-loading-bar']);
function syncLoops() {
  if (reduced() || !document.getAnimations) return;
  for (const animation of document.getAnimations()) {
    if (animation.animationName && LOOPS.has(animation.animationName) && animation.startTime !== 0) {
      try { animation.startTime = 0; } catch {}
    }
  }
}

// ---------- 页面切换：内容级联 ----------
const CARDISH = '.card,.notice,.empty-state,.loading-state,table,form';
function collectBlocks(root) {
  const out = [];
  const visit = (el, depth) => {
    for (const child of el.children) {
      if (child.matches('script,template,[hidden]')) continue;
      const style = getComputedStyle(child);
      if (style.display === 'none') continue;
      const container = !child.matches(CARDISH) && depth < 3 && child.children.length > 1 &&
        (style.display === 'grid' || style.display === 'flex' || child.querySelector(':scope > .card'));
      if (container) visit(child, depth + 1); else out.push(child);
    }
  };
  visit(root, 0);
  return out;
}
function animateEnter(full) {
  if (reduced()) return;
  const heading = $('.page-heading');
  const blocks = collectBlocks($('#page-body'));
  const cls = full ? 'motion-enter' : 'motion-soft';
  if (heading) { heading.style.setProperty('--motion-i', '0'); restartClass(heading, cls); clearOnEnd(heading, cls); }
  blocks.forEach((el, i) => {
    el.style.setProperty('--motion-i', String(Math.min(i + 1, 12)));
    restartClass(el, cls);
    clearOnEnd(el, cls);
  });
  if (full) for (const metric of document.querySelectorAll('#page-body .metric-value')) {
    const value = readNumber(metric);
    if (value) countTo(metric, 0, value, 1000);
  }
}
function installPageTransitions() {
  const body = $('#page-body');
  if (!body) return;
  let lastPage = null, lastHash = null;
  const pageKey = () => location.hash.replace(/^#/, '').split(/[/?&]/)[0] || 'overview';
  new MutationObserver(() => {
    const only = body.children.length === 1 ? body.firstElementChild : null;
    if (!body.firstElementChild || only?.classList.contains('loading-state')) return;
    const page = pageKey(), hash = location.hash;
    if (page !== lastPage) animateEnter(true);
    else if (hash !== lastHash) animateEnter(false);
    lastPage = page; lastHash = hash;
    syncLoops();
  }).observe(body, { childList: true });
}

// ---------- 轮询刷新的细节动效 ----------
function installLiveDetails() {
  const body = $('#page-body');
  let messages = null, recent = null, powerTitle = '';
  // 整页重绘时先重置基准（须早于其他观察者注册），避免跨页误判为"新消息"
  new MutationObserver(() => {
    messages = readNumber($('#metric-messages'));
    powerTitle = $('#power-title')?.textContent ?? '';
    const rows = [...document.querySelectorAll('#recent-list .recent-row')];
    recent = rows.length ? new Set(rows.map(r => r.textContent)) : null;
  }).observe(body, { childList: true });
  new MutationObserver(records => {
    let touched = false;
    for (const record of records) {
      const el = record.target;
      if (!(el instanceof Element)) continue;
      touched = true;
      if (el.id === 'metric-messages') {
        const value = readNumber(el);
        if (value !== null && messages !== null && value !== messages) countTo(el, messages, value, 700);
        messages = value;
      } else if (el.id === 'recent-list') {
        const rows = [...el.querySelectorAll('.recent-row')];
        const keys = rows.map(row => row.textContent);
        if (recent && !reduced()) rows.forEach((row, i) => { if (!recent.has(keys[i])) row.classList.add('motion-new-row'); });
        recent = new Set(keys);
      } else if (el.id === 'power-title') {
        const text = el.textContent;
        if (powerTitle && text !== powerTitle && !reduced()) restartClass(el, 'motion-changed');
        powerTitle = text;
      }
    }
    if (touched) syncLoops();
  }).observe(body, { childList: true, subtree: true });

  // 顶栏连接状态
  const label = $('#connection-label');
  if (label) {
    let text = label.textContent;
    new MutationObserver(() => {
      if (label.textContent !== text && !reduced()) restartClass(label, 'motion-changed');
      text = label.textContent; syncLoops();
    }).observe(label, { childList: true });
  }
  // 导航计数
  const count = $('#nav-chat-count');
  if (count) {
    let text = count.textContent;
    new MutationObserver(() => {
      if (count.textContent !== text && text !== '—' && !reduced()) restartClass(count, 'motion-bump');
      text = count.textContent;
    }).observe(count, { childList: true, characterData: true, subtree: true });
  }
  // 任务标题
  const jobTitle = $('#job-title');
  if (jobTitle) {
    let text = jobTitle.textContent;
    new MutationObserver(() => {
      if (jobTitle.textContent !== text && !reduced()) restartClass(jobTitle, 'motion-changed');
      text = jobTitle.textContent; syncLoops();
    }).observe(jobTitle, { childList: true });
  }
}

// ---------- 弹窗内容切换 / Toast 文案更新 ----------
function installOverlays() {
  const dialog = $('#modal'), content = $('#modal-content');
  if (dialog && content) {
    new MutationObserver(records => {
      const opening = records.some(r => r.type === 'attributes' && r.attributeName === 'open' && r.oldValue === null);
      if (!opening && dialog.open && records.some(r => r.target === content && r.type === 'childList') && !reduced()) {
        restartClass(content, 'motion-swap'); clearOnEnd(content, 'motion-swap');
      }
    }).observe(dialog, { attributes: true, attributeFilter: ['open'], attributeOldValue: true, childList: true, subtree: true });
  }
  const toast = $('#toast');
  if (toast) {
    new MutationObserver(records => {
      const showing = records.some(r => r.type === 'attributes' && r.oldValue !== null);
      if (!showing && !toast.hidden && records.some(r => r.type === 'childList') && !reduced()) {
        restartClass(toast, 'motion-swap'); clearOnEnd(toast, 'motion-swap');
      }
    }).observe(toast, { childList: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
  }
}

// ---------- 主题切换：从按钮处圆形扩散 ----------
function installThemeReveal() {
  const REPLAY = Symbol('motion-theme-replay');
  document.addEventListener('click', event => {
    const button = event.target.closest?.('#theme-button');
    if (!button || event[REPLAY] || reduced() || !document.startViewTransition) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(() => {
      const replay = new MouseEvent('click', { bubbles: true, cancelable: true });
      replay[REPLAY] = true;
      button.dispatchEvent(replay);
    });
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(() => {});
  }, true);
}

// ---------- 启动 ----------
function init() {
  installAmbient();
  boot();
  installNavIndicator();
  installRipple();
  installSpotlight();
  installLiveDetails();
  installPageTransitions();
  installOverlays();
  installThemeReveal();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
