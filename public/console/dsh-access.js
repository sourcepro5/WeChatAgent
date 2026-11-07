import { chatSettingsSnapshot } from './conversation-settings.mjs';
import { renderCatalogOptions, filterCatalogOptions } from './dsh-catalog.mjs';

export function createDshAccessUI({ api, modal, closeModal, escapeHtml: esc, icon, state, renderPage, toast, onSave }) {
  let active = null;
  const keys = () =>
    ['private', 'group'].flatMap(kind =>
      (state.config.wechat.whitelist[kind === 'group' ? 'groups' : 'private'] ?? []).map(id => `wechat:${kind}:${id}`),
    );
  const nameOf = key =>
    state.names.get(key) ?? `${key.includes(':group:') ? '群聊' : '好友'} · ${key.split(':').at(-1)}`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const includes = (config, key) =>
    ['private', 'groups'].some(kind =>
      config.wechat.whitelist[kind].some(id => key === `wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`),
    );

  async function page() {
    let catalog;
    try {
      catalog = await api(
        '/api/dsh-catalog' + (typeof key === 'string' ? '?conversationKey=' + encodeURIComponent(key) : ''),
      );
    } catch {}
    const assigned = keys().filter(key => {
      const a = state.config.wechat.dshAccess?.chats?.[key];
      return a?.mode === 'native' || a?.skills?.length || a?.tools?.length;
    }).length;
    return `<section class="card"><div class="card-header"><div><h2>DSH 技能与工具</h2><p class="card-description">在 DSH 安装与管理能力，在每个会话里独立分配。新添加的聊天默认不分配技能或插件工具。</p></div><button class="button" data-action="dsh-open">打开 DSH</button></div><div class="capability-overview"><span class="status-tag ${catalog ? 'ok' : 'warn'}">${catalog ? 'DSH 已连接' : 'DSH 未连接'}</span><span>${catalog ? `${catalog.plugins?.filter(item => item.kind === 'plugin').length ?? 0} 个插件 · ${catalog.skills.length} 个技能 · ${catalog.tools.length} 个工具` : '连接后可读取可用能力；已保存的分配会保留。'}</span><span>${assigned} / ${keys().length} 个聊天已分配能力</span></div><div class="button-row space-top"><a class="button" href="#chats">${icon('users')}为聊天分配能力</a><a class="text-link" href="#chats">管理聊天与会话 ${icon('arrow')}</a></div></section>`;
  }

  async function dialog(key, initialTab = 'settings') {
    if (!keys().includes(key) || !includes(state.draft, key)) {
      toast('请先保存允许的聊天的更改，再设置此会话。');
      return;
    }
    if (state.savingAll || state.refreshing || state.job?.state === 'running') {
      toast('请等待当前操作完成。');
      return;
    }
    const session = { key, tab: initialTab, saving: false };
    active = session;
    const current = () => active === session;
    modal(`会话设置 · ${nameOf(key)}`, '<div class="loading-state">正在读取此会话的设置…</div>', {
      className: 'conversation-modal',
      onClose: () => {
        if (current()) active = null;
      },
    });
    const results = await Promise.allSettled([
      api('/api/config'),
      api('/api/dsh-catalog' + (typeof key === 'string' ? '?conversationKey=' + encodeURIComponent(key) : '')),
    ]);
    if (!current()) return;
    if (results[0].status === 'rejected') {
      closeModal({ force: true });
      toast(results[0].reason.message);
      return;
    }
    const saved = results[0].value;
    if (!includes(saved.config, key)) {
      closeModal({ force: true });
      toast('允许的聊天已变化，请刷新后重试。');
      return;
    }
    let catalog = results[1].status === 'fulfilled' ? results[1].value : null;
    const original = chatSettingsSnapshot(saved.config, key),
      draft = chatSettingsSnapshot(state.draft, key),
      before = chatSettingsSnapshot(state.config, key);
    const initial = {
      settings: { ...original.settings },
      access: same(before.access, draft.access) ? original.access : draft.access,
    };
    for (const field of Object.keys(initial.settings))
      if (!same(before.settings[field], draft.settings[field])) initial.settings[field] = draft.settings[field];
    let selected = structuredClone(initial.access),
      form,
      viewMode = initial.settings.workMode;
    const modeDrafts = {};
    const options = (items, value) =>
      items
        .map(
          ([id, label]) =>
            `<option value="${esc(id)}" ${String(value ?? 'inherit') === String(id) ? 'selected' : ''}>${esc(label)}</option>`,
        )
        .join('');
    const select = (field, label, items, value, help = '') =>
      `<div class="field"><label for="chat-${field}">${label}</label><select id="chat-${field}" data-chat-field="${field}">${options(items, value)}</select>${help ? `<small>${esc(help)}</small>` : ''}</div>`;
    const inherited = enabled => `继承默认（${enabled ? '开启' : '关闭'}）`;
    const settings = initial.settings,
      w = saved.config.wechat;
    const settingsPanel = `<div class="form-grid">${select(
      'workMode',
      '工作模式',
      [
        ['social', '聊天模式'],
        ['assistant', '助手模式'],
      ],
      settings.workMode,
      '两种模式各自保留 DSH 上下文，切回即可继续原历史。按本聊天的能力配置执行任务；群聊默认唤醒后执行。审批方式可在能力与权限中选择。',
    )}<div id="chat-assistant-access" class="field full" ${settings.workMode === 'assistant' ? '' : 'hidden'}>${key.includes(':group:') ? `<div class="switch-row"><div><strong>群友聊天与管理员任务</strong><p>所有群友都能按本群回复方式聊天；只有指定管理员能调用工具、技能、联网、文件和任务控制。两种通道独立保存上下文。</p></div><span hidden><input type="checkbox" id="chat-adminOnly" ${settings.adminOnly ? 'checked' : ''} disabled></span></div>` : '<p>私聊助手仅允许指定管理员使用。</p>'}<div class="switch-row"><div><label for="chat-fileTransfer">微信文件收发</label><p>允许当前聊天接收文件并回传当前 DSH 工作区中的成果，单个文件最多 50 MB。电脑微信需已下载完整文件；文件内容不会自动执行。</p></div><label class="switch-control"><input type="checkbox" role="switch" id="chat-fileTransfer" ${settings.fileTransfer ? 'checked' : ''}><span class="switch-track"></span></label></div><p id="chat-admin-notice" class="card-description" role="status"></p><a class="text-link" id="chat-admin-settings" href="#settings/assistant">在助手设置中管理管理员名单</a></div>${select('persona', '人格', [['', `跟随默认（${saved.config.persona.default}）`], ...state.roles.map(role => [role.name, role.name])], settings.persona ?? '', '人格在 WeChatAgent 管理；更改后需重启服务。')}${
      key.includes(':group:')
        ? select(
            'mode',
            '群聊回复方式',
            [
              [
                'inherit',
                `继承默认（${settings.workMode === 'assistant' || w.wake_mode === 'mention' ? '唤醒后回复' : '自然参与'}）`,
              ],
              ['hybrid', '自然参与'],
              ['mention', '唤醒后回复'],
            ],
            settings.mode,
            '仅在此群生效，保存后应用到后续消息。',
          )
        : ''
    }${select(
      'stickers',
      '表情发送',
      [
        ['inherit', inherited(w.stickers?.enabled !== false)],
        ['on', '开启'],
        ['off', '关闭'],
      ],
      settings.stickers === null ? null : settings.stickers ? 'on' : 'off',
    )}${select(
      'search',
      '联网搜索',
      [
        ['inherit', inherited(w.search?.enabled === true)],
        ['on', '开启'],
        ['off', '关闭'],
      ],
      settings.search === null ? null : settings.search ? 'on' : 'off',
      '聊天模式下联网关闭会限制外部能力；助手模式的文件、终端等工具由单独授权与 DSH 审批控制。',
    )}${select(
      'proactive',
      '主动聊天',
      [
        ['off', '关闭'],
        ['on', '开启'],
      ],
      settings.proactive ? 'on' : 'off',
      `总开关当前${w.proactive?.enabled ? '开启' : '关闭'}，还需符合回复设置中的时间与间隔。`,
    )}<div class="field"><label for="chat-context">上下文压缩阈值 / token</label><input id="chat-context" data-chat-field="context" type="number" min="0" max="2000000" step="1" value="${settings.context ?? ''}" placeholder="继承 ${w.context?.maxTokens ?? 100000}"><small>留空继承默认，0 关闭；启用值至少 4,000。总开关当前${w.context?.enabled ? '开启' : '关闭'}。</small></div></div>`;
    const body = `<form id="chat-settings-form" novalidate><p class="conversation-identity"><span class="status-tag ok">${key.includes(':group:') ? '群聊' : '好友'}</span><span class="mono">ID ${esc(key.split(':').at(-1))}</span><span>设置仅用于此聊天，重新初始化上下文后仍保留。</span></p><div class="conversation-tabs" role="tablist" aria-label="会话设置类别"><button type="button" role="tab" id="chat-tab-settings" aria-controls="chat-panel-settings" data-chat-tab="settings">基本设置</button><button type="button" role="tab" id="chat-tab-access" aria-controls="chat-panel-access" data-chat-tab="access">能力与权限 <span id="chat-access-count"></span></button></div><div class="conversation-scroll"><section id="chat-panel-settings" role="tabpanel" aria-labelledby="chat-tab-settings">${settingsPanel}</section><section id="chat-panel-access" role="tabpanel" aria-labelledby="chat-tab-access"><p class="modal-description">技能提供任务说明；工具按 DSH 真实插件名称分组，实际操作需勾选组内的具体工具。先保存助手模式并初始化会话，再刷新清单以选择文件、终端等工具。可选择使用 DSH 可用能力，或保留逐项授权。助手模式会按管理员开关和真实发送者核验权限；关闭群管理员模式后，群成员可使用本群授权能力。原生权限与审批继续生效。</p><div id="assistant-capability-profile" class="form-grid" ${settings.workMode === 'assistant' ? '' : 'hidden'}><div class="field full"><label for="chat-native-preset">DSH 任务预设</label><select id="chat-native-preset">${[...new Map([['wechat-assistant', { id: 'wechat-assistant', name: '微信助手（默认）' }], ...(catalog?.presets ?? []).map(item => [item.id, item]), ...(selected.preset ? [[selected.preset, { id: selected.preset, name: selected.preset }]] : [])]).values()].map(item => '<option value="' + esc(item.id) + '" ' + ((selected.preset ?? 'wechat-assistant') === item.id ? 'selected' : '') + '>' + esc(item.name) + '</option>').join('')} </select><small>选用 DSH 已安装的任务预设，例如 standard。更改后会建立保留历史的续接会话，旧会话归档；所有工具仍经过本聊天权限检查。</small></div><div class="field full"><label for="chat-access-mode">助手能力配置</label><select id="chat-access-mode"><option value="custom" ${selected.mode !== 'native' ? 'selected' : ''}>逐项授权（保留当前勾选）</option><option value="native" ${selected.mode === 'native' ? 'selected' : ''}>使用 DSH 可用能力</option></select><small>使用当前助手 Agent 能访问的 DSH 工具与技能；以后新安装的能力也会随 DSH 更新。原生权限与审批继续生效，纯界面插件不属于可执行工具。</small></div><div class="field"><label for="chat-task-timeout">任务时限（分钟）</label><input id="chat-task-timeout" type="number" min="5" max="120" value="${selected.timeoutMinutes ?? 30}"></div><div class="field"><label for="chat-tool-limit">工具调用上限</label><input id="chat-tool-limit" type="number" min="10" max="1000" value="${selected.toolLimit ?? 200}"></div><div class="field full"><label><input id="chat-remote-approval" type="checkbox" ${selected.remoteApproval ? 'checked' : ''}>允许指定管理员通过微信确认原生审批</label><small>每次审批展示具体操作，回复一次性编号确认；默认仍在 DSH 本机审批。过期、撤权或无法完整展示的操作不会获得微信批准。</small></div><p class="card-description full">微信命令：助手帮助、助手能力、任务列表、任务状态、取消任务、继续任务、工作区列表。状态和取消不会排在模型任务之后。</p></div><div class="capability-toolbar"><input id="chat-capability-search" type="search" aria-label="搜索插件、技能或工具" placeholder="搜索插件、技能或工具"><label><input type="checkbox" id="chat-selected-only">仅看已选</label><button type="button" class="button small" id="chat-catalog-refresh">刷新清单</button></div><p id="chat-catalog-status" class="card-description" role="status"></p><div id="chat-capability-options"></div><p id="chat-capability-empty" class="empty-state" hidden>没有匹配的技能或工具，试试其他关键词。</p></section></div><div class="conversation-footer"><p id="chat-save-error" class="extension-error" role="alert" hidden></p><div id="chat-discard-prompt" class="notice" hidden><span>此会话有未保存的修改。</span><button class="button small" type="button" id="chat-keep-editing">继续编辑</button><button class="button small" type="button" id="chat-discard">放弃修改</button></div><div class="conversation-save-row"><span id="chat-save-state" class="subtle" role="status"></span><div class="button-row"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存此会话</button></div></div></div></form>`;
    modal(`会话设置 · ${nameOf(key)}`, body, {
      className: 'conversation-modal',
      beforeClose: () => {
        if (session.saving) return false;
        if (dirty()) {
          form.querySelector('#chat-discard-prompt').hidden = false;
          form.querySelector('#chat-keep-editing').focus();
          return false;
        }
        return true;
      },
      onClose: () => {
        if (current()) active = null;
      },
    });
    active = session;
    form = document.querySelector('#chat-settings-form');
    const tabList = form.querySelector('[role=tablist]'),
      advanced = document.createElement('section');
    advanced.id = 'chat-panel-advanced';
    advanced.setAttribute('role', 'tabpanel');
    advanced.setAttribute('aria-labelledby', 'chat-tab-advanced');
    advanced.innerHTML = '<p class="modal-description">上下文阈值仅用于此聊天；助手任务限额不会改变 DSH 原生权限。</p>';
    const advancedTab = document.createElement('button');
    advancedTab.type = 'button';
    advancedTab.id = 'chat-tab-advanced';
    advancedTab.dataset.chatTab = 'advanced';
    advancedTab.setAttribute('role', 'tab');
    advancedTab.setAttribute('aria-controls', advanced.id);
    advancedTab.textContent = '高级';
    tabList.append(advancedTab);
    form.querySelector('.conversation-scroll').append(advanced);
    for (const id of ['chat-context', 'chat-task-timeout', 'chat-tool-limit']) {
      const input = form.querySelector('#' + id),
        field = input.closest('.field');
      if (id !== 'chat-context') field.dataset.assistantAdvanced = '';
      advanced.append(field);
    }
    const accessPanel = form.querySelector('#chat-panel-access'),
      capabilityFields = document.createElement('div');
    capabilityFields.className = 'form-grid';
    for (const id of ['chat-stickers', 'chat-search'])
      capabilityFields.append(form.querySelector('#' + id).closest('.field'));
    accessPanel.prepend(capabilityFields);
    accessPanel.prepend(form.querySelector('#chat-assistant-access'));
    const identity = form.querySelector('.conversation-identity .mono');
    if (identity) advanced.append(identity);
    form.querySelector('#chat-admin-settings').href = '#settings/assistant';
    const read = () => ({
      settings: {
        persona: form.querySelector('#chat-persona').value === '' ? null : form.querySelector('#chat-persona').value,
        workMode: form.querySelector('#chat-workMode').value,
        adminOnly: key.includes(':group:') ? form.querySelector('#chat-adminOnly').checked : true,
        fileTransfer: form.querySelector('#chat-fileTransfer').checked,
        mode: key.includes(':group:')
          ? form.querySelector('#chat-mode').value === 'inherit'
            ? null
            : form.querySelector('#chat-mode').value
          : null,
        ...Object.fromEntries(
          ['stickers', 'search'].map(field => {
            const value = form.querySelector(`#chat-${field}`).value;
            return [field, value === 'inherit' ? null : value === 'on'];
          }),
        ),
        proactive: form.querySelector('#chat-proactive').value === 'on',
        context:
          form.querySelector('#chat-context').value === '' ? null : Number(form.querySelector('#chat-context').value),
      },
      access: {
        ...selected,
        ...Object.fromEntries(['skills', 'tools'].map(kind => [kind, [...selected[kind]].sort()])),
      },
    });
    const dirty = () => !same(read(), original);
    const button = form.querySelector('[type=submit]');
    function paint() {
      const proactive = form.querySelector('#chat-proactive'),
        assistant = form.querySelector('#chat-workMode').value === 'assistant';
      proactive.disabled = session.saving || assistant;
      proactive.closest('.field').hidden = assistant;
      for (const field of form.querySelectorAll('[data-assistant-advanced]')) field.hidden = !assistant;
      proactive.parentElement.querySelector('small').textContent = assistant
        ? '助手模式不会主动执行任务；主动聊天仅在聊天模式生效。'
        : `总开关当前${w.proactive?.enabled ? '开启' : '关闭'}，还需符合回复设置中的时间与间隔。`;
      form.querySelector('#assistant-capability-profile').hidden = !assistant;
      const inherited = assistant && selected.mode === 'native';
      for (const input of form.querySelectorAll('[data-dsh-kind]')) input.disabled = session.saving || inherited;
      form.querySelector('#chat-capability-options').hidden = inherited;
      form.querySelector('#chat-capability-search').hidden = inherited;
      form.querySelector('#chat-selected-only').parentElement.hidden = inherited;
      if (inherited) {
        form.querySelector('#chat-capability-empty').hidden = true;
        form.querySelector('#chat-catalog-status').textContent =
          '使用所选 DSH 预设当前可用的工具与技能，执行时仍检查原生权限。原先逐项勾选的列表已保留，切回逐项授权即可继续使用。';
      }
      const accessPanel = form.querySelector('#chat-assistant-access');
      accessPanel.hidden = !assistant;
      form.querySelector('#chat-fileTransfer').disabled = session.saving || !assistant;
      const adminSwitch = form.querySelector('#chat-adminOnly');
      if (adminSwitch) adminSwitch.disabled = true;
      const admins = w.assistant?.administrators ?? [];
      form.querySelector('#chat-admin-notice').textContent = admins.length
        ? '当前账号已指定 ' + admins.length + ' 位管理员；群友聊天不受管理员名单限制，执行权限仅属于管理员。'
        : key.includes(':group:')
          ? '尚未指定管理员。群友仍可聊天，但无人可执行任务；请到助手设置添加管理员。'
          : '尚未指定管理员，私聊助手暂不可用；请到助手设置添加管理员。';
      const changed = dirty();
      button.disabled = session.saving || session.refreshing || !changed;
      button.textContent = session.saving ? '正在保存…' : '保存此会话';
      form.querySelector('#chat-save-state').textContent = session.saving
        ? '正在保存当前聊天'
        : changed
          ? '有未保存的修改'
          : '此会话设置已保存';
      form.querySelector('#chat-access-count').textContent = inherited
        ? 'DSH'
        : selected.skills.length + selected.tools.length;
    }
    function filter() {
      filterCatalogOptions(form);
    }
    function paintCatalog() {
      const presetSelect = form.querySelector('#chat-native-preset');
      presetSelect.innerHTML = [
        ...new Map([
          ['wechat-assistant', { id: 'wechat-assistant', name: '微信助手（默认）' }],
          ...(catalog?.presets ?? []).map(item => [item.id, item]),
          ...(selected.preset && !catalog?.presets?.some(item => item.id === selected.preset)
            ? [[selected.preset, { id: selected.preset, name: selected.preset }]]
            : []),
        ]).values(),
      ]
        .map(
          item =>
            '<option value="' +
            esc(item.id) +
            '" ' +
            ((selected.preset ?? 'wechat-assistant') === item.id ? 'selected' : '') +
            '>' +
            esc(item.name) +
            '</option>',
        )
        .join('');
      form.querySelector('#chat-catalog-status').textContent = !catalog
        ? 'DSH 未连接，已有授权保留；暂时无法读取插件名称和新能力。'
        : catalog.apiVersion < 2
          ? '工具清单已连接；重启 DSH 后可加载真实插件名称与来源分组。'
          : catalog.metadataAvailable
            ? '插件名称来自 DSH；按真实来源分组，勾选工具后还需保存。'
            : '工具清单已连接；DSH 插件名称服务暂不可用，来源无法确认的工具会单独显示。';
      form.querySelector('#chat-capability-options').innerHTML = renderCatalogOptions(
        catalog,
        selected,
        original.access,
        esc,
      );
      filter();
      paint();
    }
    function switchTab(tab) {
      session.tab = tab;
      for (const name of ['settings', 'access', 'advanced']) {
        const tabButton = form.querySelector(`[data-chat-tab="${name}"]`);
        tabButton.setAttribute('aria-selected', String(tab === name));
        tabButton.tabIndex = tab === name ? 0 : -1;
        form.querySelector(`#chat-panel-${name}`).hidden = tab !== name;
      }
    }
    form.addEventListener('input', event => {
      if (event.target.id === 'chat-workMode') {
        modeDrafts[viewMode] = { ...read(), settings: { ...read().settings, workMode: viewMode } };
        viewMode = event.target.value;
        const next = modeDrafts[viewMode] ?? chatSettingsSnapshot(saved.config, key, viewMode);
        selected = structuredClone(next.access);
        for (const [name, value] of Object.entries(next.settings)) {
          const field = form.querySelector('#chat-' + name);
          if (!field) continue;
          if (['adminOnly', 'fileTransfer'].includes(name)) {
            field.checked = value;
            continue;
          }
          field.value =
            name === 'persona' || name === 'context'
              ? (value ?? '')
              : ['stickers', 'search'].includes(name)
                ? value === null
                  ? 'inherit'
                  : value
                    ? 'on'
                    : 'off'
                : name === 'proactive'
                  ? value
                    ? 'on'
                    : 'off'
                  : (value ?? 'inherit');
        }
        const inheritedMode = form.querySelector('#chat-mode option[value=inherit]');
        if (inheritedMode)
          inheritedMode.textContent =
            '继承默认（' + (viewMode === 'assistant' || w.wake_mode === 'mention' ? '唤醒后回复' : '自然参与') + '）';
        form.querySelector('#chat-native-preset').value = selected.preset ?? 'wechat-assistant';
        form.querySelector('#chat-access-mode').value = selected.mode ?? 'custom';
        form.querySelector('#chat-remote-approval').checked = selected.remoteApproval === true;
        form.querySelector('#chat-task-timeout').value = selected.timeoutMinutes ?? 30;
        form.querySelector('#chat-tool-limit').value = selected.toolLimit ?? 200;
        catalog = null;
        paintCatalog();
      }
      if (
        event.target.matches(
          '#chat-native-preset,#chat-access-mode,#chat-remote-approval,#chat-task-timeout,#chat-tool-limit',
        )
      ) {
        const field =
          event.target.id === 'chat-native-preset'
            ? 'preset'
            : event.target.id === 'chat-access-mode'
              ? 'mode'
              : event.target.id === 'chat-remote-approval'
                ? 'remoteApproval'
                : event.target.id === 'chat-task-timeout'
                  ? 'timeoutMinutes'
                  : 'toolLimit';
        const value =
          field === 'remoteApproval'
            ? event.target.checked
            : ['mode', 'preset'].includes(field)
              ? event.target.value
              : Number(event.target.value);
        const fallback = {
          preset: 'wechat-assistant',
          mode: 'custom',
          remoteApproval: false,
          timeoutMinutes: 30,
          toolLimit: 200,
        };
        if (value === fallback[field] && !Object.hasOwn(initial.access, field)) delete selected[field];
        else selected[field] = value;
      }
      if (event.target.matches('#chat-capability-search,#chat-selected-only')) filter();
      if (event.target.dataset.dshKind) {
        const kind = event.target.dataset.dshKind,
          name = event.target.value;
        selected[kind] = event.target.checked
          ? [...selected[kind], name]
          : selected[kind].filter(value => value !== name);
        form.querySelector(`[data-kind-count="${kind}"]`).textContent = selected[kind].length;
        filter();
      }
      const context = form.querySelector('#chat-context'),
        value = Number(context.value);
      context.setCustomValidity(
        context.value !== '' && value !== 0 && (!Number.isSafeInteger(value) || value < 4000)
          ? '填 0 关闭，或输入至少 4,000 token；留空继承默认。'
          : '',
      );
      form.querySelector('#chat-discard-prompt').hidden = true;
      paint();
    });
    form.addEventListener('click', event => {
      const tab = event.target.closest('[data-chat-tab]');
      if (tab) switchTab(tab.dataset.chatTab);
    });
    form.querySelector('[role=tablist]').addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const tabs = ['settings', 'access', 'advanced'],
          index = tabs.indexOf(session.tab);
        switchTab(
          event.key === 'Home'
            ? 'settings'
            : event.key === 'End'
              ? 'advanced'
              : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3],
        );
        form.querySelector('[data-chat-tab="' + session.tab + '"]').focus();
      }
    });
    form.querySelector('#chat-keep-editing').addEventListener('click', () => {
      form.querySelector('#chat-discard-prompt').hidden = true;
      form.querySelector(`[data-chat-tab="${session.tab}"]`).focus();
    });
    form.querySelector('#chat-admin-settings').addEventListener('click', event => {
      event.preventDefault();
      if (closeModal() !== false && !document.querySelector('#chat-settings-form'))
        location.hash = 'settings/assistant';
    });
    form.querySelector('#chat-discard').addEventListener('click', () => closeModal({ force: true }));
    form.querySelector('#chat-catalog-refresh').addEventListener('click', async event => {
      if (session.saving) return;
      const refresh = event.currentTarget;
      refresh.disabled = true;
      session.refreshing = true;
      paint();
      try {
        catalog = await api(
          '/api/dsh-catalog' + (typeof key === 'string' ? '?conversationKey=' + encodeURIComponent(key) : ''),
        );
      } catch {
        catalog = null;
      }
      if (current()) {
        session.refreshing = false;
        refresh.disabled = false;
        paintCatalog();
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (session.saving || session.refreshing || !dirty()) return;
      if (!form.checkValidity()) {
        const invalid = form.querySelector(':invalid');
        switchTab(invalid?.closest('[role=tabpanel]')?.id.replace('chat-panel-', '') ?? 'settings');
        form.reportValidity();
        return;
      }
      session.saving = true;
      paint();
      form.querySelector('#chat-save-error').hidden = true;
      for (const input of form.querySelectorAll('input,select')) input.disabled = true;
      try {
        const payload = read();
        if (payload.settings.workMode !== 'assistant')
          for (const field of ['mode', 'preset', 'remoteApproval', 'timeoutMinutes', 'toolLimit'])
            delete payload.access[field];
        const result = await api('/api/chat-settings', { revision: saved.revision, key, ...payload });
        if (!current()) return;
        onSave(result, key);
        closeModal({ force: true });
        await renderPage();
        toast(
          result.workModeChanged
            ? result.modeReady
              ? '模式已切换，原历史保留。可在能力与权限中分配此模式的能力。'
              : '模式已保存。请连接 DSH 并重开服务，再分配工具。'
            : result.personaChanged
              ? '此会话已保存；人格更改需重启服务，其他设置在后续消息中应用。'
              : '此会话已保存，设置在后续消息中应用。',
        );
      } catch (error) {
        if (current()) {
          const field = form.querySelector('#chat-save-error');
          field.textContent =
            error.message + (error.status === 409 ? ' 当前选择已保留，请取消后重新打开以读取最新设置。' : '');
          field.hidden = false;
        }
      } finally {
        session.saving = false;
        if (current()) {
          for (const input of form.querySelectorAll('input,select')) input.disabled = false;
          paint();
        }
      }
    });
    switchTab(initialTab);
    paintCatalog();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-dsh-chat],[data-chat-settings]');
    if (button)
      dialog(
        button.dataset.dshChat ?? button.dataset.chatSettings,
        button.dataset.dshChat ? 'access' : 'settings',
      ).catch(error => toast(error.message));
  });
  return { page };
}
