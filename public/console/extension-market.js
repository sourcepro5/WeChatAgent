import { pluginCard } from './plugins.js';
export function createExtensionMarket({ api, modal, toast, escapeHtml: esc, icon }) {
  let query = '',
    category = 'all',
    filter = 'all',
    items = [],
    memeStatus = { available: false },
    runtimeConnected = false;
  const groups = [
    ['all', '全部'],
    ['custom', '本机插件'],
    ['network', '联网与阅读'],
    ['media', '表情与素材'],
    ['chat', '聊天与会话'],
    ['dsh', 'DSH 插件'],
  ];
  const emptyMarkup =
    '<div class="extension-empty"><h3>没有匹配的能力</h3><p>换个关键词，或调整分类和状态筛选。</p><button class="button" data-extension-reset>清除筛选</button></div>';
  const group = item =>
    item.management === 'wechatagent'
      ? 'custom'
      : item.id === 'dsh-meme' || item.id === 'native-stickers'
        ? 'media'
        : ['native-search', 'native-web-reader'].includes(item.id)
          ? 'network'
          : 'chat';
  const installed = item => !item.requiresInstall || memeStatus.available === true;
  const shown = () =>
    items.filter(
      item =>
        (category === 'all' || (category === 'dsh' && item.requiresInstall) || category === group(item)) &&
        (filter === 'all' ||
          (filter === 'installed' && installed(item)) ||
          (filter === 'enabled' &&
            (item.management === 'wechatagent' ? item.enabled : item.featureState?.effectiveCount > 0)) ||
          (filter === 'disabled' && !item.enabled)) &&
        [item.name, item.description, item.author, item.id]
          .join(' ')
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
    );
  function card(item) {
    if (item.management === 'wechatagent') return pluginCard(item, esc, icon);
    const ready = installed(item),
      effective = item.featureState?.effectiveCount ?? 0,
      total = item.featureState?.totalCount ?? 0;
    const label =
      item.requiresInstall && !ready
        ? memeStatus.reason === 'DSH_PLUGIN_UNAVAILABLE'
          ? runtimeConnected
            ? '需更新 DSH 桥接'
            : '等待 DSH 连接'
          : '未检测到插件'
        : item.statusLabel;
    const tone = item.requiresInstall && !ready ? 'warn' : item.statusTone;
    const repository = item.repository ?? 'https://github.com/sourcepro5/WeChatAgent';
    return `<article class="extension-tile" data-extension-card="${esc(item.id)}"><div class="extension-tile-top"><div class="extension-tile-heading"><h2><button class="extension-title" data-extension="${esc(item.id)}">${esc(item.name)}</button></h2><a class="extension-source-link" href="${esc(repository)}" target="_blank" rel="noopener noreferrer" aria-label="查看 ${esc(item.name)} 项目">${icon('arrow')}</a></div><button class="button extension-card-action ${item.requiresInstall && !ready ? 'primary' : ''}" ${item.requiresInstall && !ready ? 'data-meme-guide' : `data-extension="${esc(item.id)}"`}>${item.requiresInstall && !ready ? '安装教程' : '配置'}</button></div><p class="extension-byline">${icon(item.requiresInstall ? 'plug' : 'shield')}<span>${esc(item.author ?? 'WeChatAgent')} · ${item.requiresInstall ? 'DSH 原版插件' : '内置能力'}</span></p><p class="extension-card-state"><span class="status-tag ${esc(tone ?? '')}">${esc(label ?? '已关闭')}</span><span>${effective} / ${total} 个聊天${item.requiresInstall && !ready ? '已配置' : '开启'}</span></p><p class="extension-card-description">${esc(item.description)}</p><div class="extension-card-tags"><span>${groups.find(([id]) => id === group(item))?.[1] ?? '功能'}</span><span>${item.requiresInstall ? '需在 DSH 安装' : '项目内置'}</span></div>${item.requiresInstall ? '<footer class="extension-card-footer"><button class="text-link" data-meme-guide>安装说明</button></footer>' : ''}</article>`;
  }
  function paint() {
    const grid = document.querySelector('#extension-grid');
    if (!grid) return;
    const selected = shown();
    grid.innerHTML = selected.map(card).join('') || emptyMarkup;
    document.querySelector('#extension-result-count').textContent = `显示 ${selected.length} 项，共 ${items.length} 项`;
    document
      .querySelectorAll('[data-extension-category]')
      .forEach(button => button.setAttribute('aria-pressed', String(button.dataset.extensionCategory === category)));
  }
  async function page(catalog, overview) {
    items = [...(catalog.plugins ?? []), ...catalog.extensions];
    runtimeConnected = !!catalog.runtimeConnected;
    try {
      memeStatus = await api('/api/meme-library-status');
    } catch {
      memeStatus = { available: false, reason: 'DSH_PLUGIN_UNAVAILABLE' };
    }
    const markup = `<section class="extension-market" aria-label="能力目录"><div class="extension-search-row"><label class="extension-search">${icon('search')}<input id="extension-search" type="search" value="${esc(query)}" placeholder="搜索能力，例如：联网、表情、上下文…" aria-label="搜索能力"></label><select id="extension-status-filter" aria-label="筛选能力状态">${[
      ['all', '全部状态'],
      ['installed', '已具备'],
      ['enabled', '聊天已开启'],
      ['disabled', '已关闭'],
    ]
      .map(([value, label]) => `<option value="${value}" ${filter === value ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select></div><nav class="extension-category-tabs" aria-label="能力分类">${groups.map(([value, label]) => `<button data-extension-category="${value}" aria-pressed="${value === category}">${label}${value === 'all' ? ' (' + items.length + ')' : ''}</button>`).join('')}</nav><div class="extension-market-meta"><span id="extension-result-count">显示 ${shown().length} 项，共 ${items.length} 项</span><span>${catalog.runtimeConnected ? 'DSH 已连接' : '等待 DSH 连接'} · 开关按聊天生效</span></div><div class="extension-card-grid" id="extension-grid">${shown().map(card).join('') || emptyMarkup}</div><details class="extension-help"><summary>DSH 能力与会话授权</summary>${overview}</details></section>`;
    return markup;
  }
  function guide() {
    modal(
      '安装与使用 dsh-meme',
      `<div class="meme-install-guide"><p class="modal-description">dsh-meme 是独立的 DSH 表情图库插件，由 yyh-001 维护。WeChatAgent 通过它现有的本机接口选图与入库，微信发送仍由本项目确认回执。</p><ol><li><strong>在 DSH 添加插件</strong><p>打开 DSH 侧栏“插件 → 添加插件”，输入下面的包名，按 DSH 提示安装并启用。</p><div class="input-with-button"><input id="meme-package-name" aria-label="插件安装名称" value="dsh-meme" readonly><button class="button" data-copy-meme-name>复制插件名</button></div></li><li><strong>准备图库</strong><p>在 dsh-meme 的“设置 → 表情包”中安装或导入图库，并开启要使用的图库。随后完整退出并重开 DSH，加载当前 WeChatAgent 桥接插件。</p></li><li><strong>启用微信接入</strong><p>进入“表情包 → 来源与搜索”，打开“配置图库接入与聊天范围”，启用接入并选择允许使用的聊天。同时保持这些聊天的“表情发送”开启。</p></li><li><strong>按需开启联网补图</strong><p>在接入配置中开启“允许联网补图”，并为对应聊天打开联网搜索。模型先查询本地图库，没有合适图片时再搜索公开素材、核验并导入。系统会寻找可用素材并核验内容；网站限制或识图失败时继续文字回复，识图可能产生模型消耗。</p></li></ol><div class="notice plain">${icon('info')}<span>选中图片核验后即可准备本次发送；长期收藏最多 50 张，满池新素材等待 DS 筛选，不阻止本次发送。实际送达仍需微信服务器回执。</span></div><p id="meme-connection-check" role="status" aria-live="polite" class="meme-connection-check"></p><div class="button-row"><button class="button" data-action="dsh-open">打开 DSH</button><button class="button" data-meme-check>检查插件连接</button><a class="button" href="https://github.com/yyh-001/dsh-meme" target="_blank" rel="noopener noreferrer">插件项目 ${icon('arrow')}</a></div><p class="subtle space-top">本页提供安装指引，安装确认由 DSH 处理。图库内容受其来源和可用性影响。</p></div>`,
    );
  }
  document.addEventListener('input', event => {
    if (event.target.id === 'extension-search') {
      query = event.target.value;
      paint();
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'extension-status-filter') {
      filter = event.target.value;
      paint();
    }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.extensionCategory) {
      category = button.dataset.extensionCategory;
      paint();
    }
    if (button.hasAttribute('data-extension-reset')) {
      query = '';
      category = 'all';
      filter = 'all';
      document.querySelector('#extension-search').value = '';
      document.querySelector('#extension-status-filter').value = 'all';
      paint();
    }
    if (button.hasAttribute('data-meme-guide')) guide();
    if (button.hasAttribute('data-copy-meme-name')) {
      try {
        await navigator.clipboard.writeText('dsh-meme');
        toast('插件名已复制。');
      } catch {
        document.querySelector('#meme-package-name').select();
        toast('已选中插件名，请按 Ctrl+C 复制。');
      }
    }
    if (button.hasAttribute('data-meme-check')) {
      button.disabled = true;
      const field = document.querySelector('#meme-connection-check');
      try {
        const result = await api('/api/meme-library-status');
        if (field)
          field.textContent = result.available
            ? `已连接 dsh-meme，${result.enabledPacks} 个图库已启用。`
            : '尚未连接到 dsh-meme。请确认 DSH、本项目桥接插件和 dsh-meme 均已启用并重开。';
      } catch {
        if (field) field.textContent = '连接检查失败，请稍后重试。';
      } finally {
        button.disabled = false;
      }
    }
  });
  return { page, guide };
}
