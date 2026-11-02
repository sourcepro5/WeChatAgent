// WeChatAgent · Liquid Glass layer
// 纯展示增强：玻璃边缘折射、跟随指针的高光、分段控件/标签页的液态滑块、卡片微倾斜、背景视差。
// 不调用任何接口、不修改业务状态；系统开启"减少动态效果 / 减少透明度"时自动降级。
// CSP 兼容：仅通过 CSSOM（element.style.setProperty）与 SVG 属性写样式，无内联 style 属性；
// 折射贴图为 canvas 生成的 data: PNG（CSP 已允许 img-src data:）。

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const SVG_NS = 'http://www.w3.org/2000/svg';
const pageKey = () => location.hash.replace(/^#/, '').split(/[/?&]/)[0] || 'overview';

// ---------- 边缘折射（仅 Chromium：backdrop-filter 支持引用 SVG 滤镜） ----------
// 每个玻璃元素按自身尺寸与圆角生成一张位移贴图：中心不偏移，越靠近边缘越向内取样，
// 形成玻璃厚边缘对背后内容的弯折效果。
const REFRACT = [
  { selector: '.topbar', bezel: 16, scale: 26 },
  { selector: '.sidebar', bezel: 22, scale: 30 },
  { selector: '#modal', bezel: 24, scale: 34 },
  { selector: '.toast', bezel: 14, scale: 20 },
  { selector: '.save-bar', bezel: 18, scale: 26 },
  { selector: '.job-panel', bezel: 18, scale: 26 },
];
const canRefract = () => !!navigator.userAgentData && CSS.supports('backdrop-filter', 'url(#a) blur(1px)') && !reduceTransparency.matches;

function displacementMap(width, height, radius, bezel) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  const data = image.data;
  const halfW = width / 2, halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);
  for (let y = 0; y < height; y++) {
    const py = y + .5 - halfH, ay = Math.abs(py), qy = ay - (halfH - r);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const px = x + .5 - halfW, ax = Math.abs(px), qx = ax - (halfW - r);
      // 圆角矩形的有向距离场与外法线
      let distance, nx, ny;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        distance = length - r; nx = qx / length; ny = qy / length;
      } else if (qx > qy) {
        distance = qx - r; nx = 1; ny = 0;
      } else {
        distance = qy - r; nx = 0; ny = 1;
      }
      const depth = -distance;
      let dx = 0, dy = 0;
      if (depth > 0 && depth < bezel) {
        const t = 1 - depth / bezel;
        const magnitude = t * t;
        dx = -Math.sign(px) * nx * magnitude;
        dy = -Math.sign(py) * ny * magnitude;
      }
      data[i] = 128 + dx * 127;
      data[i + 1] = 128 + dy * 127;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function installRefraction() {
  if (!canRefract()) return;
  document.documentElement.classList.add('lg-refract');
  const defs = document.createElementNS(SVG_NS, 'svg');
  defs.setAttribute('aria-hidden', 'true');
  defs.setAttribute('focusable', 'false');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('class', 'lg-defs');
  document.body.append(defs);
  let serial = 0;
  const entries = new Map();
  const attrs = (el, values) => { for (const [key, value] of Object.entries(values)) el.setAttribute(key, String(value)); };

  // 为一个玻璃元素创建专属滤镜：feImage 载入位移贴图，feDisplacementMap 按贴图偏移背景
  const createFilter = (el, spec) => {
    const id = `lg-refract-${++serial}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    attrs(filter, { id, x: 0, y: 0, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    const map = document.createElementNS(SVG_NS, 'feImage');
    attrs(map, { x: 0, y: 0, result: 'map', preserveAspectRatio: 'none' });
    const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
    attrs(displace, { in: 'SourceGraphic', in2: 'map', scale: spec.scale, xChannelSelector: 'R', yChannelSelector: 'G' });
    filter.append(map, displace);
    defs.append(filter);
    const entry = { el, spec, id, filter, map, size: '', timer: 0 };
    entries.set(el, entry);
    return entry;
  };

  // 尺寸或圆角变化时重新生成贴图（尺寸为 0 表示元素当前隐藏，跳过）
  const refreshMap = entry => {
    const { el, spec, filter, map } = entry;
    const width = Math.round(el.offsetWidth), height = Math.round(el.offsetHeight);
    if (width < 8 || height < 8) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const size = `${width}x${height}x${radius}`;
    if (size === entry.size) return;
    entry.size = size;
    attrs(filter, { width, height });
    attrs(map, { width, height, href: displacementMap(width, height, radius, spec.bezel) });
    el.style.setProperty('--lg-filter', `url(#${entry.id})`);
  };

  const observer = new ResizeObserver(records => {
    for (const record of records) {
      const entry = entries.get(record.target);
      if (!entry) continue;
      clearTimeout(entry.timer);
      // 首次立即生成；之后尺寸连续变化（窗口拖动、弹窗内容切换）时稍作合并
      entry.timer = setTimeout(() => refreshMap(entry), entry.size ? 140 : 0);
    }
  });
  for (const spec of REFRACT) {
    const el = document.querySelector(spec.selector);
    if (!el) continue;
    // 先同步生成一次，避免首帧没有折射；之后的尺寸变化交给 ResizeObserver
    refreshMap(createFilter(el, spec));
    observer.observe(el);
  }
  reduceTransparency.addEventListener?.('change', () => {
    if (!reduceTransparency.matches) return;
    for (const { el } of entries.values()) el.style.removeProperty('--lg-filter');
    document.documentElement.classList.remove('lg-refract');
    observer.disconnect();
  });
}

// ---------- 跟随指针的玻璃高光 + 卡片微倾斜 + 背景视差 ----------
const GLARE_TARGETS = '.sidebar,.topbar,dialog,.save-bar,.job-panel,.action-menu>div';
const TILT_TARGETS = '.metrics>.card,.power-card';
const TILT_MAX_DEG = 3.2;
const TILT_VARS = ['--lg-tilt-x', '--lg-tilt-y', '--lg-tilt'];

function installPointerLight() {
  let frame = 0, last = null, tilted = null, ambient = null;

  const setGlare = (glass, event) => {
    const rect = glass.getBoundingClientRect();
    glass.style.setProperty('--gx', event.clientX - rect.left + 'px');
    glass.style.setProperty('--gy', event.clientY - rect.top + 'px');
  };
  const setParallax = event => {
    // 背景层由 motion.js 创建；按需查找，不依赖两个模块的执行顺序
    ambient ??= document.querySelector('.motion-ambient');
    if (!ambient) return;
    ambient.style.setProperty('--px', (event.clientX / innerWidth * 2 - 1).toFixed(3));
    ambient.style.setProperty('--py', (event.clientY / innerHeight * 2 - 1).toFixed(3));
  };
  // 绕"垂直于指针方向"的轴旋转：指针所在的一角轻轻下沉，离中心越远倾斜越大
  const setTilt = (card, event) => {
    const rect = card.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width * 2 - 1;
    const ny = (event.clientY - rect.top) / rect.height * 2 - 1;
    const amount = Math.min(1, Math.hypot(nx, ny));
    card.style.setProperty('--lg-tilt-x', (-ny).toFixed(3));
    card.style.setProperty('--lg-tilt-y', nx.toFixed(3));
    card.style.setProperty('--lg-tilt', (amount * TILT_MAX_DEG).toFixed(2) + 'deg');
    card.classList.add('lg-tilting');
    tilted = card;
  };
  const resetTilt = () => {
    if (!tilted) return;
    tilted.classList.remove('lg-tilting');
    for (const name of TILT_VARS) tilted.style.removeProperty(name);
    tilted = null;
  };

  const paint = () => {
    frame = 0;
    const event = last;
    const glass = event.target.closest?.(GLARE_TARGETS);
    if (glass) setGlare(glass, event);
    if (reduceMotion.matches) { resetTilt(); return; }
    setParallax(event);
    const card = event.target.closest?.(TILT_TARGETS) ?? null;
    if (card !== tilted) resetTilt();
    if (card) setTilt(card, event);
  };

  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !finePointer.matches) return;
    last = event;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  // 指针离开窗口（relatedTarget 为空）、窗口失焦或按下时，卡片回正
  document.addEventListener('pointerout', event => { if (!event.relatedTarget) resetTilt(); }, { passive: true });
  document.addEventListener('pointerdown', resetTilt, { passive: true });
  window.addEventListener('blur', resetTilt);
}

// ---------- 分段控件 / 标签页：液态玻璃滑块 ----------
// 页面重绘时控件会整段替换。按"页面 + 控件"记住上一次选中位置，
// 新控件出现时从旧位置流动到新位置；同一控件内切换选中项时从当前位置流动。
const THUMB_GROUPS = [
  { selector: '.segmented', active: ':scope>button.selected' },
  { selector: '.workspace-tabs', active: ':scope>[aria-current=page],:scope>[aria-pressed=true]' },
];
const thumbMemory = new Map();     // key -> 最近一次的滑块位置，跨重绘保留
const thumbStates = new WeakMap(); // container -> { group, key, thumb, geo }

const measure = el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
const sameGeo = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function liquidMove(el, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // 沿主要移动方向拉长、另一方向收窄；到位时反向轻压一下再复原
  const stretch = Math.min(.28, .06 + distance / 700);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const sx = horizontal ? 1 + stretch : 1 - stretch * .45;
  const sy = horizontal ? 1 - stretch * .45 : 1 + stretch;
  const box = (geo, scale = '') => ({ transform: `translate(${geo.x}px,${geo.y}px)${scale}`, width: geo.w + 'px', height: geo.h + 'px' });
  const lerp = (a, b, t) => a + (b - a) * t;
  const mid = { x: lerp(from.x, to.x, .58), y: lerp(from.y, to.y, .58), w: lerp(from.w, to.w, .58), h: lerp(from.h, to.h, .58) };
  el.animate([
    box(from),
    { ...box(mid, ` scale(${sx},${sy})`), offset: .42 },
    { ...box(to, ` scale(${1 - (sx - 1) * .3},${1 - (sy - 1) * .3})`), offset: .74 },
    box(to),
  ], { duration: 620, easing: 'cubic-bezier(.3,.8,.25,1)' });
}

function thumbKey(container, group) {
  const label = container.getAttribute('aria-label');
  const index = [...document.querySelectorAll(group.selector)].indexOf(container);
  return `${pageKey()}|${group.selector}|${label || index}`;
}

// animate=false 用于尺寸变化后的重新对齐：只更新位置，不播放流动动画
function placeThumb(container, { animate = true } = {}) {
  const state = thumbStates.get(container);
  const active = container.querySelector(state.group.active);
  if (!active?.offsetWidth) {
    if (state.thumb) state.thumb.hidden = true;
    container.classList.remove('lg-has-thumb');
    state.geo = null;
    return;
  }
  if (!state.thumb) {
    state.thumb = document.createElement('span');
    state.thumb.className = 'lg-thumb';
    state.thumb.setAttribute('aria-hidden', 'true');
    container.prepend(state.thumb);
  }
  const { thumb } = state;
  const from = animate ? state.geo : null;
  const to = measure(active);
  thumb.hidden = false;
  thumb.style.setProperty('transform', `translate(${to.x}px,${to.y}px)`);
  thumb.style.setProperty('width', to.w + 'px');
  thumb.style.setProperty('height', to.h + 'px');
  container.classList.add('lg-has-thumb');
  if (from && !sameGeo(from, to) && !reduceMotion.matches) liquidMove(thumb, from, to);
  state.geo = to;
  thumbMemory.set(state.key, to);
}

function adoptThumbContainer(container, group) {
  const key = thumbKey(container, group);
  // geo 先取上一次重绘前的位置，首次定位即可从那里流动过来
  const state = { group, key, thumb: null, geo: thumbMemory.get(key) ?? null };
  thumbStates.set(container, state);
  // 选中项变化时重新定位；忽略容器自身与滑块的属性变化（placeThumb 会修改它们，避免自触发循环）
  new MutationObserver(records => {
    if (records.some(record => record.target !== container && record.target !== state.thumb)) placeThumb(container);
  }).observe(container, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed', 'hidden'] });
  new ResizeObserver(() => placeThumb(container, { animate: false })).observe(container);
  placeThumb(container);
}

function installThumbs() {
  const body = document.querySelector('#page-body');
  if (!body) return;
  // 只接管新出现的控件；已接管的控件由各自的观察者负责更新
  const adoptNew = () => {
    for (const group of THUMB_GROUPS) {
      for (const container of body.querySelectorAll(group.selector)) {
        if (!thumbStates.has(container)) adoptThumbContainer(container, group);
      }
    }
  };
  // MutationObserver 已把同一任务内的所有变更合并为一次回调，无需再用 requestAnimationFrame 节流；
  // 且 rAF 在窗口隐藏（如收起到托盘）时不会执行，会让滑块迟迟不出现。
  new MutationObserver(adoptNew).observe(body, { childList: true, subtree: true });
  adoptNew();
}

// ---------- 启动 ----------
function init() {
  installRefraction();
  installPointerLight();
  installThumbs();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
