// WeChatAgent · 主题预设
// 以普通脚本（非 module）在 <head> 中加载：先把已保存的预设写到 <html data-preset>，避免首屏闪回默认主题；
// DOM 就绪后在顶栏"更多"菜单加入预设选择器，并为方舟预设挂上装饰层、HUD、主看板（独立主界面或嵌入概览）、标题解码与页面转场。
// 不调用任何接口、不修改业务状态；CSP 兼容（只用 CSSOM 与属性写样式）。
(() => {
  const PRESETS = {
    glass: { label: '液态玻璃', note: '默认主题', swatch: 'glass' },
    ark: { label: '罗德岛 · PRTS', note: '明日方舟 · 终端界面', swatch: 'ark', ark: true },
    embers: { label: '冻土与火种', note: 'PRTS · 7.5 周年活动皮肤', swatch: 'embers', ark: true },
  };
  const STORE_KEY = 'wechatagent-console-preset';
  const PREV_THEME_KEY = 'wechatagent-console-preset-prev-theme';
  const THEME_KEY = 'wechatagent-console-theme'; // 与 console.js 的明暗主题使用同一个键
  const LAYOUT_KEY = 'wechatagent-console-ark-layout';
  // 主看板的两种布局（仅方舟预设）
  const LAYOUTS = {
    page: { label: '独立主界面', note: '单独一页，侧边栏顶部进入', swatch: 'layout-page' },
    overview: { label: '嵌入概览', note: '放在概览页顶部', swatch: 'layout-overview' },
  };
  const root = document.documentElement;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const storage = {
    get: key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} },
  };
  // 预设、主看板布局、进入方舟预设前的明暗：桌面应用里存进它的偏好文件（与明暗主题、背景图同一处）——
  // 桌面应用每次启动的端口不同，localStorage 按来源（含端口）隔离，退出后就读不到了；浏览器里仍用 localStorage
  const PREF_KEYS = { name: STORE_KEY, layout: LAYOUT_KEY, prevTheme: PREV_THEME_KEY };
  const desktopPrefs = typeof window.desktop?.setPreset === 'function' ? { ...window.desktop.initialPreset } : null;
  const prefs = {
    get: key => (desktopPrefs ? desktopPrefs[key] ?? null : storage.get(PREF_KEYS[key])),
    set: (key, value) => {
      if (!desktopPrefs) return storage.set(PREF_KEYS[key], value);
      desktopPrefs[key] = value;
      window.desktop.setPreset({ ...desktopPrefs }).catch?.(() => {});
    },
  };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const isArk = name => !!PRESETS[name]?.ark;
  const pageKey = () => location.hash.replace(/^#/, '').split(/[/?&]/)[0] || 'overview';
  const consolePage = () => (pageKey() === 'prts' ? 'overview' : pageKey()); // 控制台不认识 #prts，会渲染概览

  let current = Object.hasOwn(PRESETS, prefs.get('name')) ? prefs.get('name') : 'glass';
  let layout = prefs.get('layout') === 'overview' ? 'overview' : 'page';
  // 启动时没有指定页面（桌面应用总是从根地址打开）：方舟预设 + "独立主界面"布局默认进入主界面。
  // 在控制台脚本读取地址之前改写，控制台会把 #prts 当作概览在下面渲染；需要首次配置时见 init 中的处理
  const bootHome = isArk(current) && layout === 'page' && !location.hash;
  if (bootHome) history.replaceState(null, '', '#prts');
  // 首屏：方舟预设固定深色底，先写入深色主题；console.js 随后读到的已保存主题也是深色
  if (isArk(current)) { root.dataset.preset = current; root.dataset.ark = ''; root.dataset.theme = 'dark'; }

  // 与 console.js 的 applyTheme 等效（不含按钮图标：方舟预设期间明暗按钮隐藏，退出时恢复原状态，图标自然一致）
  function setThemeQuietly(theme) {
    root.dataset.theme = theme;
    storage.set(THEME_KEY, theme);
    window.desktop?.setTheme?.(theme).catch?.(() => {});
  }

  // ---------- 页面信息：英文名、编号、代号 ----------
  const PAGES = {
    setup: ['SETUP', 'INIT'], overview: ['TERMINAL', 'PRTS-TML'], chats: ['CHANNELS', 'COMM-LINK'], roles: ['OPERATOR', 'OPR-FILE'],
    extensions: ['MODULES', 'MOD-SYS'], stickers: ['DEPOT', 'DPT-STK'], memory: ['ARCHIVES', 'ARC-MEM'], settings: ['SYSTEM', 'SYS-CFG'],
  };

  // ---------- 乱码解码：PRTS 终端式的文字显现 ----------
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/<>=+';
  const CJK = '罗德岛源石博士终端整合运动龙门切城乌萨斯炎国维多利亚卡西米尔莱塔尼亚萨尔贡伊比利亚';
  const decoding = new WeakMap();
  // write(text) 负责把中间状态写回去（文本节点或属性）；返回在完成时 resolve 的 Promise
  // 新的解码会取代同一目标上未完成的解码（被取代的不再写回旧文字）
  function decode(target, finalText, write, { duration = 520, cjk = false } = {}) {
    decoding.get(target)?.cancel(false);
    if (reduced() || !finalText) { write(finalText); return; }
    const pool = cjk ? CJK : GLYPHS;
    const start = performance.now();
    let frame = 0, cancelled = false;
    const tick = now => {
      if (cancelled) return;
      const progress = Math.min(1, (now - start) / duration);
      const settled = Math.floor(finalText.length * progress);
      let text = finalText.slice(0, settled);
      for (let i = settled; i < finalText.length; i++) text += finalText[i] === ' ' ? ' ' : pool[Math.floor(Math.random() * pool.length)];
      write(text);
      if (progress < 1) frame = requestAnimationFrame(tick); else decoding.delete(target);
    };
    decoding.set(target, { cancel: (finish = true) => { cancelled = true; cancelAnimationFrame(frame); decoding.delete(target); if (finish) write(finalText); } });
    frame = requestAnimationFrame(tick);
  }

  // 标题区：写入英文大字、编号、代号，并播放解码
  let titleText = '';
  let titleWrite = null; // 解码最近一次写入的标题文字，用于区分自身写入与 console.js 的新标题
  function syncHeading({ animate = true } = {}) {
    const heading = document.querySelector('.page-heading');
    const title = document.querySelector('#page-title');
    if (!heading || !title) return;
    const [en, code] = PAGES[consolePage()] ?? ['RHODES ISLAND', 'PRTS'];
    const links = [...document.querySelectorAll('.sidebar nav a[data-page]')].filter(link => !link.hidden);
    const index = links.findIndex(link => link.dataset.page === consolePage());
    heading.dataset.index = index >= 0 ? `${String(index + 1).padStart(2, '0')} / ${String(links.length).padStart(2, '0')}` : 'PRTS';
    title.dataset.caption = code;
    const text = title.textContent;
    if (!animate) { heading.dataset.en = en; titleText = text; return; }
    decode(heading, en, value => { heading.dataset.en = value; });
    titleText = text;
    decode(title, text, value => { titleWrite = value; title.textContent = value; }, { duration: 420, cjk: true });
  }

  // ---------- 装饰层 ----------
  const random = (min, max) => min + Math.random() * (max - min);
  function buildDecor() {
    const layer = el('div', 'ark-decor');
    layer.setAttribute('aria-hidden', 'true');
    for (const name of ['ark-floor', 'ak-glow', 'ak-mist', 'ark-halftone', 'ark-stripes', 'ark-ray', 'ak-pixels', 'ark-vignette', 'ark-noise']) layer.append(el('i', name));
    const particle = (className, values) => {
      const dot = el('i', className);
      for (const [key, value] of Object.entries(values)) dot.style.setProperty(key, value);
      layer.append(dot);
    };
    for (let i = 0; i < 24; i++) {
      const duration = random(14, 24);
      particle('ark-dust', { '--x': random(0, 100).toFixed(1) + '%', '--y': random(10, 100).toFixed(1) + '%', '--size': random(1, 2.6).toFixed(1) + 'px', '--d': duration.toFixed(1) + 's', '--delay': (-random(0, duration)).toFixed(1) + 's', '--drift': random(-40, 60).toFixed(0) + 'px' });
    }
    // 活动皮肤的灰烬与火星（仅"冻土与火种"显示）
    for (let i = 0; i < 44; i++) {
      const spark = i >= 34, duration = spark ? random(7, 11) : random(10, 14);
      particle(spark ? 'ak-ash spark' : 'ak-ash', { '--x': random(0, 100).toFixed(1) + '%', '--y': (spark ? random(55, 100) : random(-10, 85)).toFixed(1) + '%', '--size': random(1.5, spark ? 3 : 2.5).toFixed(1) + 'px', '--d': duration.toFixed(1) + 's', '--delay': (-random(0, duration)).toFixed(1) + 's', '--drift': (spark ? random(-30, 30) : random(-40, 10)).toFixed(0) + 'px' });
    }
    return layer;
  }

  // ---------- 顶栏 HUD：状态与时间放进同风格的浮窗 ----------
  let clockTimer = 0;
  function buildHud() {
    const hud = el('div', 'ark-hud');
    hud.setAttribute('aria-hidden', 'true');
    hud.append(el('span', 'ark-hud-live', 'PRTS ONLINE'), el('i'), el('span', 'ark-hud-date'), el('i'), el('b', 'ark-hud-time'));
    return hud;
  }
  function tickClock(hud) {
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    hud.querySelector('.ark-hud-date').textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
    hud.querySelector('.ark-hud-time').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  // ---------- 主看板 · 嵌入概览：概览页顶部的倾斜方块 ----------
  const DECK = [
    ['chats', 'CHANNELS', '聊天', 'users'], ['roles', 'OPERATOR', '人格', 'person'], ['extensions', 'MODULES', '能力', 'plug'],
    ['memory', 'ARCHIVES', '记忆', 'history'], ['stickers', 'DEPOT', '表情包', 'image'], ['settings', 'SYSTEM', '设置', 'sliders'],
  ];
  function buildDeck() {
    const deck = el('section', 'ark-deck');
    deck.setAttribute('aria-label', '快捷入口');
    const grid = el('div', 'ark-deck-grid');
    DECK.forEach(([page, en, cn, icon], i) => {
      const tile = el('a', 'ark-tile' + (i === 0 ? ' is-main' : i === 3 ? ' is-accent' : ''));
      tile.href = '#' + page;
      tile.style.setProperty('--i', String(i));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '/icons.svg#' + icon);
      svg.setAttribute('aria-hidden', 'true');
      svg.append(use);
      tile.append(el('span', 'ark-tile-no', String(i + 1).padStart(2, '0')), el('span', 'ark-tile-meta', page === 'chats' ? '' : '>>'), svg, el('span', 'ark-tile-en', en), el('span', 'ark-tile-cn', cn));
      grid.append(tile);
    });
    const caption = el('div', 'ark-deck-caption');
    const left = el('span');
    left.append(el('b', '', 'PRTS'), document.createTextNode(' // PRIMITIVE RHODES ISLAND TERMINAL SERVICE'));
    caption.append(left, el('span', '', 'DOCTOR, WELCOME BACK'));
    deck.append(grid, caption);
    return deck;
  }
  function syncDeck(deck) {
    deck.hidden = layout !== 'overview' || pageKey() !== 'overview';
    const count = document.querySelector('#nav-chat-count')?.textContent?.trim();
    const meta = deck.querySelector('.ark-tile.is-main .ark-tile-meta');
    if (meta) meta.textContent = count && count !== '—' ? `${count} ACTIVE` : '';
  }

  // ---------- PRTS 主界面：独立的一页（#prts），像游戏的主界面 ----------
  // 不在概览里重复侧边栏的导航：主界面占满窗口，隐藏侧边栏与工作区，从这里进入各个系统。
  // 控制台本身不认识 #prts，会在下面照常渲染概览；主界面上的状态与数字从概览的元素里读取，不另调接口。
  const HOME = 'prts';
  const HOME_TILES = [
    ['overview', 'TERMINAL', '控制台', 'dashboard', '运行状态与连接检查', 'is-main'],
    ['chats', 'CHANNELS', '聊天', 'users', '模式、能力、工作区与任务', 'is-wide'],
    ['roles', 'OPERATOR', '人格', 'person', '性格、语气与聊天习惯'],
    ['extensions', 'MODULES', '能力', 'plug', '内置能力与 DSH'],
    ['memory', 'ARCHIVES', '记忆', 'history', '群友观察与会话摘要', 'is-accent'],
    ['stickers', 'DEPOT', '表情包', 'image', '收集、整理与发送'],
    ['settings', 'SYSTEM', '设置', 'sliders', '默认行为、连接与诊断'],
  ];
  const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const svgIcon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    return svg;
  };
  function buildHome() {
    const home = el('section', 'ark-home');
    home.setAttribute('aria-label', 'PRTS 主界面');
    home.hidden = true;

    const bar = el('header', 'ark-home-bar');
    const logo = el('img');
    logo.src = '/app-icon.png';
    logo.alt = '';
    const title = el('div');
    title.append(el('strong', '', 'RHODES ISLAND'), document.createTextNode('PRTS · 主界面'));
    bar.append(logo, title, el('span', 'ark-hud-live', 'PRTS ONLINE'));

    const status = el('div', 'ark-home-status');
    const greet = el('div', 'ark-home-greet');
    greet.append(el('span', '', 'DOCTOR, WELCOME BACK'), el('strong', '', '博士，欢迎回来'));
    const clock = el('div', 'ark-home-clock');
    clock.setAttribute('aria-hidden', 'true');
    clock.append(el('b', 'ark-home-time'), el('small', 'ark-home-sec'));
    const date = el('div', 'ark-home-date');
    date.setAttribute('aria-hidden', 'true');
    const service = el('a', 'ark-home-service');
    service.href = '#overview';
    service.append(el('span', '', 'SERVICE STATUS // 服务状态'), el('strong', 'ark-home-power', '正在检查连接'), el('em', 'ark-home-tag'));
    const stats = el('dl', 'ark-home-stats');
    for (let i = 0; i < 3; i++) {
      const item = el('div');
      const value = el('dd', 'ark-home-value');
      value.append(document.createTextNode('—'), el('small'));
      item.append(el('dt', 'ark-home-label'), value);
      stats.append(item);
    }
    status.append(greet, clock, date, service, stats);

    const main = el('div', 'ark-home-main');
    // 不用 <nav>：console.css 给所有 nav a 写了侧边栏链接的高度与内边距
    const grid = el('div', 'ark-home-grid');
    grid.setAttribute('role', 'navigation');
    grid.setAttribute('aria-label', '进入系统');
    HOME_TILES.forEach(([page, en, cn, icon, desc, variant], i) => {
      const tile = el('a', 'ark-tile' + (variant ? ' ' + variant : ''));
      tile.href = '#' + page;
      tile.dataset.page = page;
      tile.style.setProperty('--i', String(i));
      tile.append(el('span', 'ark-tile-no', String(i + 1).padStart(2, '0')), el('span', 'ark-tile-meta', '>>'), svgIcon(icon), el('span', 'ark-tile-en', en), el('span', 'ark-tile-cn', cn), el('span', 'ark-tile-desc', desc));
      grid.append(tile);
    });
    main.append(grid);

    const caption = el('div', 'ark-home-caption');
    const left = el('span');
    left.append(el('b', '', 'PRTS'), document.createTextNode(' // PRIMITIVE RHODES ISLAND TERMINAL SERVICE'));
    caption.append(left, el('span', '', 'ESC · 进入控制台'));
    home.append(bar, status, main, caption);
    return home;
  }
  // 从概览里读出状态与数字；离开主界面时不更新
  const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  function syncHome(home) {
    const open = layout === 'page' && pageKey() === HOME;
    home.hidden = !open;
    document.body.classList.toggle('ark-home-open', open);
    if (!open) return;
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    text(home.querySelector('.ark-home-time'), `${pad(now.getHours())}:${pad(now.getMinutes())}`);
    text(home.querySelector('.ark-home-sec'), pad(now.getSeconds()));
    text(home.querySelector('.ark-home-date'), `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} · ${WEEKDAYS[now.getDay()]}`);
    const tag = document.querySelector('#power-tag');
    text(home.querySelector('.ark-home-power'), document.querySelector('#power-title')?.textContent?.trim() || '正在检查连接');
    text(home.querySelector('.ark-home-tag'), tag?.textContent?.trim() ?? '');
    home.querySelector('.ark-home-service').dataset.state = tag?.classList.contains('ok') ? 'ok' : 'idle';
    const metrics = document.querySelectorAll('.metrics > .card');
    home.querySelectorAll('.ark-home-stats > div').forEach((item, i) => {
      const card = metrics[i], value = card?.querySelector('.metric-value');
      text(item.querySelector('dt'), card?.querySelector('.metric-label')?.textContent?.trim() || ['缓存消息', '允许的好友', '允许的群聊'][i]);
      const number = value ? [...value.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.data).join('').trim() : '';
      const dd = item.querySelector('dd');
      text(dd.firstChild, number || '—');
      text(dd.querySelector('small'), value?.querySelector('span')?.textContent ?? '');
    });
    const count = document.querySelector('#nav-chat-count')?.textContent?.trim();
    text(home.querySelector('.ark-tile[data-page=chats] .ark-tile-meta'), count && count !== '—' ? `${count} ACTIVE` : '>>');
  }
  function buildHomeLink() {
    const link = el('a', 'ark-home-link');
    link.href = '#' + HOME;
    link.append(el('span', '', 'HOME'), el('b', '', '主界面'));
    return link;
  }

  // ---------- 页面转场：深色淡出淡入 ----------
  function buildTransit() {
    const transit = el('div', 'ark-transit');
    transit.setAttribute('aria-hidden', 'true');
    transit.append(el('strong', '', 'PRTS'), el('i'), el('span', '', 'RHODES ISLAND · LINKING'));
    return transit;
  }
  function playTransit(transit) {
    if (reduced()) return;
    transit.classList.remove('is-playing');
    void transit.offsetWidth;
    transit.classList.add('is-playing');
  }

  // ---------- 应用预设 ----------
  const parts = {};
  let lastPage = null;
  function mountArk() {
    parts.decor ??= buildDecor();
    parts.hud ??= buildHud();
    parts.deck ??= buildDeck();
    parts.home ??= buildHome();
    parts.homeLink ??= buildHomeLink();
    parts.transit ??= buildTransit();
    if (!parts.decor.isConnected) document.body.prepend(parts.decor);
    const actions = document.querySelector('.topbar-actions');
    if (actions && !parts.hud.isConnected) actions.before(parts.hud);
    const body = document.querySelector('#page-body');
    if (body && !parts.deck.isConnected) body.before(parts.deck);
    if (!parts.home.isConnected) document.body.append(parts.home);
    const brand = document.querySelector('.sidebar .brand');
    if (brand && !parts.homeLink.isConnected) brand.after(parts.homeLink);
    if (!parts.transit.isConnected) document.body.append(parts.transit);
    tickClock(parts.hud);
    clearInterval(clockTimer);
    clockTimer = setInterval(() => { tickClock(parts.hud); syncHome(parts.home); }, 1000);
    syncLayout();
    syncHeading();
    lastPage = pageKey();
  }
  function unmountArk() {
    clearInterval(clockTimer);
    for (const part of Object.values(parts)) part.remove();
    document.body.classList.remove('ark-home-open');
    leaveHome();
    const heading = document.querySelector('.page-heading');
    if (heading) { delete heading.dataset.en; delete heading.dataset.index; }
    if (titleText) { const title = document.querySelector('#page-title'); decoding.get(title)?.cancel(); }
  }

  // 其他预设或"嵌入概览"没有主界面：停在 #prts 时改回概览（控制台此时显示的就是概览，不需要重新渲染）
  function leaveHome() {
    if (pageKey() === HOME) history.replaceState(null, '', '#overview');
  }
  function syncLayout() {
    if (layout !== 'page') leaveHome();
    if (parts.homeLink) parts.homeLink.hidden = layout !== 'page';
    if (parts.deck) syncDeck(parts.deck);
    if (parts.home) syncHome(parts.home);
    for (const option of document.querySelectorAll('[data-ark-layout]')) option.setAttribute('aria-pressed', String(option.dataset.arkLayout === layout));
  }
  // 切到"独立主界面"时直接打开它，让人看到切换的结果
  function setLayout(name) {
    if (name === layout) return;
    layout = name;
    prefs.set('layout', name === 'page' ? null : name);
    syncLayout();
    if (!isArk(current)) return;
    if (name === 'page') location.hash = '#' + HOME;
    else playTransit(parts.transit);
  }

  function apply(name, { boot = false } = {}) {
    const previous = current;
    current = name;
    prefs.set('name', name === 'glass' ? null : name);
    if (name === 'glass') delete root.dataset.preset; else root.dataset.preset = name;
    if (isArk(name)) root.dataset.ark = ''; else delete root.dataset.ark;

    // 方舟预设：进入时切到深色并记住原来的明暗；退出时恢复
    if (isArk(name) && !isArk(previous)) {
      prefs.set('prevTheme', root.dataset.theme === 'dark' ? 'dark' : 'light');
      if (root.dataset.theme !== 'dark') setThemeQuietly('dark');
    } else if (!isArk(name) && isArk(previous)) {
      const back = prefs.get('prevTheme');
      prefs.set('prevTheme', null);
      if (back && back !== root.dataset.theme) setThemeQuietly(back);
    }

    if (isArk(name)) {
      mountArk();
      if (boot && !reduced()) {
        document.querySelectorAll('.sidebar .brand, .sidebar .nav-caption, .sidebar nav a').forEach((node, i) => node.style.setProperty('--motion-i', String(i)));
        document.body.classList.add('ark-boot');
        setTimeout(() => document.body.classList.remove('ark-boot'), 1800);
      }
    } else {
      unmountArk();
    }
    for (const option of document.querySelectorAll('.preset-option')) option.setAttribute('aria-pressed', String(option.dataset.preset === name));
  }

  // 切换预设：水平擦除转场（不支持 View Transitions 或减少动态时直接切换）
  // requested 记录最近一次选择：转场回调要等下一帧才执行，期间再次点击应以最新的选择为准
  let requested = current;
  function switchTo(name) {
    if (name === requested) return;
    requested = name;
    if (!document.startViewTransition || reduced()) { apply(name, { boot: true }); return; }
    root.classList.add('preset-switching');
    const transition = document.startViewTransition(() => { if (requested !== current) apply(requested, { boot: true }); });
    // 窗口隐藏或最小化时页面不渲染，转场回调会一直等待；超时后跳过动画直接应用
    const fallback = setTimeout(() => transition.skipTransition(), 600);
    transition.updateCallbackDone.finally(() => clearTimeout(fallback));
    transition.ready.then(() => {
      root.animate({ clipPath: ['inset(0 100% 0 0)', 'inset(0 0 0 0)'] }, { duration: 700, easing: 'cubic-bezier(.2,.9,.25,1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
    transition.finished.finally(() => root.classList.remove('preset-switching'));
  }

  // ---------- 预设选择器 ----------
  function buildPicker() {
    const menu = document.querySelector('.topbar-more > div');
    if (!menu || menu.querySelector('.preset-picker')) return;
    const picker = el('div', 'preset-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '主题预设');
    picker.append(el('span', '', '主题预设'));
    for (const [name, preset] of Object.entries(PRESETS)) {
      const option = el('button', 'preset-option');
      option.type = 'button';
      option.dataset.preset = name;
      option.setAttribute('aria-pressed', String(name === current));
      const text = el('span');
      text.append(el('strong', '', preset.label), el('small', '', preset.note));
      option.append(el('i', 'preset-swatch ' + preset.swatch), text);
      option.addEventListener('click', () => { switchTo(name); menu.closest('details')?.removeAttribute('open'); });
      picker.append(option);
    }
    const layouts = el('div', 'preset-picker ark-layout-picker');
    layouts.setAttribute('role', 'group');
    layouts.setAttribute('aria-label', '主看板');
    layouts.append(el('span', '', '主看板'));
    for (const [name, item] of Object.entries(LAYOUTS)) {
      const option = el('button', 'preset-option');
      option.type = 'button';
      option.dataset.arkLayout = name;
      option.setAttribute('aria-pressed', String(name === layout));
      const text = el('span');
      text.append(el('strong', '', item.label), el('small', '', item.note));
      option.append(el('i', 'preset-swatch ' + item.swatch), text);
      option.addEventListener('click', () => { setLayout(name); menu.closest('details')?.removeAttribute('open'); });
      layouts.append(option);
    }
    menu.append(picker, layouts);
  }

  // 主看板随指针轻微视差（对应游戏里随陀螺仪移动的投影面板），作用于当前显示的那一种布局
  function installDeckParallax() {
    let frame = 0, last = null;
    document.addEventListener('pointermove', event => {
      const board = [parts.home, parts.deck].find(part => part?.isConnected && !part.hidden);
      if (!board || event.pointerType !== 'mouse' || reduced()) return;
      last = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const grid = board.querySelector('.ark-home-grid, .ark-deck-grid');
        grid.style.setProperty('--ark-px', (last.clientX / innerWidth * 2 - 1).toFixed(3));
        grid.style.setProperty('--ark-py', (last.clientY / innerHeight * 2 - 1).toFixed(3));
      });
    }, { passive: true });
  }

  // 立体卡片：可交互的卡片随指针微倾，指针所在的一侧下沉（角度写入 --ark-rx/--ark-ry，见 theme-presets.css "立体卡片"）
  const TILT_TARGETS = '.ark-tile,.ark-home-service,.metrics>.card,.power-card,.role-item,.chat-picker-item,.mode-option,.sticker-card,.extension-tile';
  function installCardTilt() {
    let frame = 0, last = null, tilted = null;
    const reset = () => {
      if (!tilted) return;
      tilted.classList.remove('ark-tilting');
      tilted.style.removeProperty('--ark-rx');
      tilted.style.removeProperty('--ark-ry');
      tilted = null;
    };
    document.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse') return;
      last = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const card = isArk(current) && !reduced() ? last.target.closest?.(TILT_TARGETS) : null;
        if (card !== tilted) reset();
        if (!card || card.disabled) return;
        const rect = card.getBoundingClientRect();
        const nx = (last.clientX - rect.left) / rect.width * 2 - 1;
        const ny = (last.clientY - rect.top) / rect.height * 2 - 1;
        // 窄卡片倾斜角大、宽面板倾斜角小，使边缘的起伏幅度接近
        const max = Math.min(7, Math.max(2, 1500 / rect.width));
        card.style.setProperty('--ark-rx', (-ny * max).toFixed(2) + 'deg');
        card.style.setProperty('--ark-ry', (nx * max).toFixed(2) + 'deg');
        card.classList.add('ark-tilting');
        tilted = card;
      });
    }, { passive: true });
    // 指针离开窗口时回正
    document.addEventListener('pointerout', event => { if (!event.relatedTarget) reset(); });
  }

  function init() {
    buildPicker();
    if (current !== 'glass') apply(current);
    installDeckParallax();
    // 启动时被改到主界面、但这台电脑还需要首次配置（控制台会显示"首次配置"入口）：改去配置页
    const setupNav = document.querySelector('#setup-nav');
    if (bootHome && setupNav) new MutationObserver((_, observer) => {
      observer.disconnect();
      if (!setupNav.hidden && pageKey() === HOME) location.hash = '#setup';
    }).observe(setupNav, { attributes: true, attributeFilter: ['hidden'] });
    // 主界面上按 Esc 进入控制台（有弹窗打开时交给弹窗）
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !parts.home?.isConnected || parts.home.hidden || document.querySelector('dialog[open]')) return;
      location.hash = '#overview';
    });
    installCardTilt();
    // 页面切换：深色转场、主看板与主界面显隐、标题解码
    addEventListener('hashchange', () => {
      if (!isArk(current)) return;
      const page = pageKey();
      if (page !== lastPage) playTransit(parts.transit);
      lastPage = page;
      syncLayout();
    });
    // console.js 渲染新页面时会改写标题文字；忽略解码自身的写入
    const title = document.querySelector('#page-title');
    if (title) new MutationObserver(() => {
      if (!isArk(current) || title.textContent === titleWrite) return;
      if (title.textContent !== titleText) syncHeading();
    }).observe(title, { childList: true, characterData: true, subtree: true });
    const count = document.querySelector('#nav-chat-count');
    if (count) new MutationObserver(() => { if (parts.deck?.isConnected) syncLayout(); }).observe(count, { childList: true, characterData: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
