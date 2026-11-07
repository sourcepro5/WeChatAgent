const unknown = {
  id: 'unverified',
  name: '来源未确认的工具',
  kind: 'unknown',
  description: '只显示已加载的工具；尚未取得可靠的插件来源，不把工具 ID 当作插件名称。',
};
const unloaded = {
  id: 'unloaded',
  name: '已分配但未加载的工具',
  kind: 'unavailable',
  description: '已有授权保留。可以取消分配；在 DSH 恢复对应插件后刷新清单。',
};
const builtin = {
  id: 'dsh-builtin',
  name: 'DSH 内置能力',
  kind: 'builtin',
  enabled: true,
  description: 'DSH 提供的文件、终端等内置工具。展开后可分别授权。',
};
const isCore = source => source?.kind === 'builtin' || source?.packageName === '@deepseek-ai/dsh-base';

/** Display-only groups. Never derive authorization IDs from a plugin title. */
export function catalogGroups(catalog, selected, original) {
  const available = new Map((catalog?.tools ?? []).map(item => [item.name, item]));
  const sources = new Map((catalog?.plugins ?? []).map(item => [item.id, item]));
  const groups = new Map();
  const add = (source, tool, loaded) => {
    if (!groups.has(source.id)) groups.set(source.id, { ...source, tools: [] });
    groups.get(source.id).tools.push({ ...tool, loaded });
  };
  for (const tool of available.values()) {
    const source = sources.get(tool.sourceId);
    add(isCore(source) ? builtin : (source ?? unknown), tool, true);
  }
  for (const name of new Set([...(original?.tools ?? []), ...(selected?.tools ?? [])])) {
    if (!available.has(name)) add(unloaded, { name, description: '当前 DSH 未加载此项，已有授权保留。' }, false);
  }
  const rank = { plugin: 0, builtin: 1, unknown: 2, unavailable: 3 };
  return {
    groups: [...groups.values()]
      .sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || a.name.localeCompare(b.name, 'zh-CN'))
      .map(group => ({ ...group, tools: group.tools.sort((a, b) => a.name.localeCompare(b.name)) })),
    informational: [...sources.values()]
      .filter(source => source.kind === 'plugin' && !isCore(source) && !groups.has(source.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  };
}

export function renderCatalogOptions(catalog, selected, original, esc) {
  const row = (item, kind, source = '') =>
    `<label class="extension-option dsh-option" data-capability-row data-search="${esc([source, item.name, item.description].join(' ').toLowerCase())}"><input type="checkbox" data-dsh-kind="${kind}" value="${esc(item.name)}" ${selected[kind].includes(item.name) ? 'checked' : ''}><span class="capability-copy"><strong>${esc(item.name)} ${item.loaded === false ? '<span class="status-tag warn">未加载</span>' : ''}</strong><small>${esc(item.description ?? '')}</small></span></label>`;
  const skills = new Map((catalog?.skills ?? []).map(item => [item.name, { ...item, loaded: true }]));
  for (const name of new Set([...(original.skills ?? []), ...selected.skills]))
    if (!skills.has(name))
      skills.set(name, { name, description: '当前 DSH 未加载此技能，已有授权保留。', loaded: false });
  const view = catalogGroups(catalog, selected, original);
  const groups = view.groups
    .map(group => {
      const content = `${group.packageName ? `<p class="capability-package mono">${esc(group.packageName)}${group.version ? ' · ' + esc(group.version) : ''}</p>` : ''}${group.description ? `<p class="capability-source-description">${esc(group.description)}</p>` : ''}${group.tools.map(tool => row(tool, 'tools', [group.name, group.packageName ?? ''].join(' '))).join('')}`;
      const heading = `${esc(group.name)}${group.kind === 'builtin' ? '<span class="status-tag">内置</span>' : ''}<span data-group-count></span>`;
      return group.kind === 'builtin' && group.tools.length > 4
        ? `<details class="extension-fieldset capability-list capability-source capability-fold" data-capability-group data-capability-fold><summary>${heading}</summary><div role="group" aria-label="${esc(group.name)}">${content}</div></details>`
        : `<fieldset class="extension-fieldset capability-list capability-source" data-capability-group><legend>${heading}</legend>${content}</fieldset>`;
    })
    .join('');
  const informational = view.informational.length
    ? `<details class="capability-inventory" data-capability-info><summary>其他已安装的 DSH 插件（${view.informational.length}）</summary><p class="card-description">以下插件在当前会话没有已确认归属的可授权工具。界面类插件继续在 DSH 使用；工具来源未确认时会单独列出。</p>${view.informational.map(plugin => `<article class="capability-plugin-info" data-plugin-info data-search="${esc([plugin.name, plugin.packageName, plugin.description].join(' ').toLowerCase())}"><div><strong>${esc(plugin.name)}</strong><span class="status-tag ${plugin.enabled ? '' : 'warn'}">${plugin.enabled ? 'DSH 已启用' : 'DSH 未启用'}</span></div><small class="mono">${esc(plugin.packageName ?? '')}${plugin.version ? ' · ' + esc(plugin.version) : ''}</small>${plugin.packageName === 'dsh-meme' ? '<p class="card-description">表情库由 WeChatAgent 的 dsh-meme 扩展接入，请在扩展页面按聊天配置。</p>' : ''}</article>`).join('')}</details>`
    : '';
  return `<fieldset class="extension-fieldset capability-list" data-capability-group><legend>技能 <span data-kind-count="skills">${selected.skills.length}</span></legend>${[...skills.values()].map(skill => row(skill, 'skills', '技能')).join('') || '<p class="card-description" data-no-capabilities>尚无可选技能。</p>'}</fieldset><div class="capability-section-heading"><h3>可调用工具</h3><span>已选 <span data-kind-count="tools">${selected.tools.length}</span> 项</span></div><p class="card-description">按来源插件分组；勾选具体工具才会授权。工具 ID 用于保存权限，不是插件名称。</p>${groups}${!view.groups.length ? '<p class="card-description" data-no-capabilities>当前模式尚无可分配工具。助手模式保存并初始化后可刷新清单。</p>' : ''}${informational}`;
}

export function filterCatalogOptions(form) {
  const query = form.querySelector('#chat-capability-search').value.trim().toLowerCase(),
    only = form.querySelector('#chat-selected-only').checked;
  let visible = 0;
  for (const row of form.querySelectorAll('[data-capability-row]')) {
    row.hidden = !row.dataset.search.includes(query) || (only && !row.querySelector('input').checked);
    if (!row.hidden) visible++;
  }
  for (const group of form.querySelectorAll('[data-capability-group]')) {
    const rows = [...group.querySelectorAll('[data-capability-row]')],
      chosen = rows.filter(row => row.querySelector('input').checked).length;
    const count = group.querySelector('[data-group-count]');
    if (count) count.textContent = `已选 ${chosen} / ${rows.length}`;
    group.hidden = rows.length ? rows.every(row => row.hidden) : !!query || only;
    if (group.hasAttribute('data-capability-fold') && (query || only) && !group.hidden) group.open = true;
  }
  let infoVisible = 0;
  for (const info of form.querySelectorAll('[data-plugin-info]')) {
    info.hidden = only || !info.dataset.search.includes(query);
    if (!info.hidden) infoVisible++;
  }
  const inventory = form.querySelector('[data-capability-info]');
  if (inventory) {
    inventory.hidden = infoVisible === 0;
    if (query && infoVisible) inventory.open = true;
  }
  for (const empty of form.querySelectorAll('[data-no-capabilities]')) empty.hidden = !!query || only;
  form.querySelector('#chat-capability-empty').hidden = visible + infoVisible > 0 || (!query && !only);
}
