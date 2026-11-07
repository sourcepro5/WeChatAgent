import { featureLocation, CAPABILITY_SECTIONS } from './layout-model.mjs';
import { createExtensionMarket } from './extension-market.js';
import { createDshAccessUI } from './dsh-access.js';
import { createPluginUI } from './plugins.js';
export function createExtensionUI({
  api,
  modal,
  closeModal,
  confirmAction,
  escapeHtml: esc,
  icon,
  state,
  renderPage,
  toast,
  onDshSave,
  onProjectSave,
}) {
  const permissionLabels = {
    web_fetch: '访问公开网络',
    history_read: '读取当前聊天历史',
    storage: '保存当前聊天的数据',
    reply: '申请向当前聊天回复',
  };
  const dshUI = createDshAccessUI({
    api,
    modal,
    closeModal,
    escapeHtml: esc,
    icon,
    state,
    renderPage,
    toast,
    onSave: onDshSave,
  });
  let catalog,
    opening = false;
  const market = createExtensionMarket({ api, modal, toast, escapeHtml: esc, icon });
  const plugins = createPluginUI({
    api,
    modal,
    closeModal,
    confirmAction,
    escapeHtml: esc,
    state,
    renderPage,
    toast,
    icon,
  });
  const names = key => state.names.get(key) ?? key;
  const summary = item =>
    item.featureState
      ? `功能默认值：${item.featureState.globalEnabled ? '开启' : '关闭'} · 当前开启 ${item.featureState.effectiveCount}/${item.featureState.totalCount} 个允许的聊天`
      : `扩展开关：${item.enabled ? '已开启' : '已关闭'} · 聊天范围：${item.chats === null ? '所有允许的聊天' : (item.chats ?? []).length + ' 个聊天'}`;
  const status = item =>
    `<span class="status-tag ${esc(item.statusTone ?? '')}" data-extension-status>${esc(item.statusLabel ?? (item.enabled ? '已开启' : '已关闭'))}</span>`;
  async function page() {
    catalog = await api('/api/extensions');
    const extensionsMarkup = await market.page(catalog, await dshUI.page());
    const tabs =
      '<nav class="workspace-tabs" aria-label="能力分类">' +
      Object.entries(CAPABILITY_SECTIONS)
        .map(
          ([id, name]) =>
            '<a href="#extensions/' +
            id +
            '"' +
            (id === 'catalog' ? ' aria-current="page"' : '') +
            '>' +
            esc(name) +
            '</a>',
        )
        .join('') +
      '</nav>';
    return tabs + plugins.installMarkup(catalog) + extensionsMarkup;
  }
  const footer = () =>
    '<p class="extension-error" id="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存扩展设置</button></div>';
  function errorInForm(error) {
    const field = document.querySelector('#extension-error');
    if (field) {
      field.textContent = error.message;
      field.hidden = false;
    } else toast(error.message);
  }
  function watchToggle(form) {
    const input = form.querySelector('#extension-enabled');
    input.addEventListener('change', () => {
      form.querySelector('#extension-toggle-state').textContent = (input.checked ? '已开启' : '已关闭') + '（待保存）';
    });
  }
  async function dialog(id, direct = false) {
    if (opening) return;
    opening = true;
    try {
      catalog = await api('/api/extensions');
      const item = catalog.extensions.find(item => item.id === id);
      if (!item) throw Error('扩展已变化，请刷新列表。');
      const location = featureLocation(id);
      if (location && !direct) {
        window.location.hash = location;
        return;
      }
      if (item.management === 'project') {
        await projectDialog(item);
        return;
      }
      const allowed = [
        ...state.config.wechat.whitelist.private.map(id => 'wechat:private:' + id),
        ...state.config.wechat.whitelist.groups.map(id => 'wechat:group:' + id),
      ];
      const fields = Object.entries(item.configSchema ?? {})
        .map(([key, schema], index) => {
          const value = item.settings[key] ?? schema.default ?? '',
            fieldId = 'extension-setting-' + index;
          if (schema.type === 'boolean')
            return `<label class="extension-option"><input type="checkbox" id="${fieldId}" data-extension-setting="${esc(key)}" ${value ? 'checked' : ''}>${esc(schema.title ?? key)}</label>`;
          if (schema.enum)
            return `<div class="field"><label for="${fieldId}">${esc(schema.title ?? key)}</label><select id="${fieldId}" data-extension-setting="${esc(key)}">${schema.enum.map(option => `<option value="${esc(option)}" ${value === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></div>`;
          if (!['string', 'number', 'integer'].includes(schema.type))
            return `<p class="card-description">${esc(key)} 为复杂设置，请使用扩展 API 配置。</p>`;
          return `<div class="field"><label for="${fieldId}">${esc(schema.title ?? key)}</label><input id="${fieldId}" data-extension-setting="${esc(key)}" type="${schema.secret ? 'password' : ['number', 'integer'].includes(schema.type) ? 'number' : 'text'}" value="${esc(value)}" ${schema.minimum !== undefined ? `min="${schema.minimum}"` : ''} ${schema.maximum !== undefined ? `max="${schema.maximum}"` : ''} ${schema.type === 'integer' ? 'step="1"' : ''} ${schema.secret ? 'placeholder="留空保留已有凭据" autocomplete="off"' : ''}><small>${esc(schema.description ?? '')}</small></div>`;
        })
        .join('');
      modal(
        item.name,
        `<form id="extension-form"><p class="extension-summary">已保存：${esc(summary(item))}</p><p class="card-description">${esc(item.reason ?? '')}</p><label class="extension-option"><input type="checkbox" id="extension-enabled" aria-label="允许此扩展运行" ${item.enabled ? 'checked' : ''}>允许此扩展运行 <strong id="extension-toggle-state">${item.enabled ? '已开启' : '已关闭'}</strong></label>${item.builtin ? '<p class="modal-description">功能开关仍沿用回复设置。允许扩展运行后，还需开启对应功能并选择聊天。</p><a class="text-link" href="#extensions/network" data-extension-config>前往回复设置</a>' : item.format === 'code' ? '<p class="modal-description">代码扩展会执行本地 JavaScript，请只启用你信任的扩展。</p>' : ''}<fieldset class="extension-fieldset"><legend>允许的能力</legend>${item.requestedPermissions.length ? item.requestedPermissions.map(permission => `<label class="extension-option"><input type="checkbox" name="extension-permission" value="${permission}" ${item.permissions.includes(permission) ? 'checked' : ''}>${permissionLabels[permission]}</label>`).join('') : '<p class="card-description">未申请额外权限。</p>'}</fieldset><fieldset class="extension-fieldset"><legend>聊天范围</legend><label class="extension-option"><input type="checkbox" id="extension-all-chats" ${item.chats === null ? 'checked' : ''}>所有已允许的聊天</label>${allowed.map(key => `<label class="extension-option"><input type="checkbox" name="extension-chat" value="${esc(key)}" ${item.chats === null || item.chats?.includes(key) ? 'checked' : ''}>${esc(names(key))}</label>`).join('')}${allowed.length ? '' : '<p class="card-description">先在聊天范围中添加好友或群聊。</p>'}</fieldset><div class="form-grid">${fields}</div>${footer()}</form>`,
      );
      const form = document.querySelector('#extension-form'),
        all = form.querySelector('#extension-all-chats');
      const paintAll = () => {
        for (const input of form.querySelectorAll('[name="extension-chat"]')) {
          input.disabled = all.checked;
          if (all.checked) input.checked = true;
        }
      };
      all.addEventListener('change', paintAll);
      paintAll();
      watchToggle(form);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.submitter;
        button.disabled = true;
        const settings = { ...item.settings };
        for (const input of form.querySelectorAll('[data-extension-setting]')) {
          const schema = item.configSchema[input.dataset.extensionSetting];
          settings[input.dataset.extensionSetting] =
            schema.type === 'boolean'
              ? input.checked
              : ['number', 'integer'].includes(schema.type)
                ? Number(input.value)
                : input.value;
        }
        try {
          await api('/api/extensions/' + id, {
            revision: catalog.revision,
            enabled: form.querySelector('#extension-enabled').checked,
            permissions: [...form.querySelectorAll('[name="extension-permission"]:checked')].map(input => input.value),
            chats: all.checked
              ? null
              : [...form.querySelectorAll('[name="extension-chat"]:checked')].map(input => input.value),
            settings,
          });
          closeModal();
          await renderPage();
          toast('扩展设置已保存，列表状态已更新。');
        } catch (error) {
          errorInForm(error);
          button.disabled = false;
        }
      });
    } catch (error) {
      toast(error.message);
    } finally {
      opening = false;
    }
  }
  async function projectDialog(item) {
    const saved = await api('/api/config'),
      settings = saved.config.wechat?.[item.feature] ?? {},
      chats = (item.groupOnly ? ['group'] : ['private', 'group']).flatMap(kind =>
        (saved.config.wechat.whitelist[kind === 'group' ? 'groups' : 'private'] ?? []).map(
          id => 'wechat:' + kind + ':' + id,
        ),
      );
    const enabled = settings.enabled ?? item.defaultEnabled;
    const rows = chats
      .map(key => {
        const value = settings.chats?.[key];
        const badge = `<span class="status-tag" data-feature-effective="${esc(key)}"></span>`;
        if (item.chatMode === 'override')
          return `<div class="extension-chat-row"><label for="chat-${esc(key)}">${esc(names(key))}</label><select id="chat-${esc(key)}" data-feature-chat="${esc(key)}">${[
            ['inherit', '继承全局', value === undefined],
            ['on', '开启', value === true],
            ['off', '关闭', value === false],
          ]
            .map(
              ([option, label, selected]) =>
                `<option value="${option}" ${selected ? 'selected' : ''}>${label}</option>`,
            )
            .join('')}</select>${badge}</div>`;
        if (item.chatMode === 'all')
          return `<div class="extension-chat-row"><span>${esc(names(key))}</span>${badge}</div>`;
        const selected = item.chatMode === 'context' ? value !== 0 : value === true;
        return `<label class="extension-option"><input type="checkbox" data-feature-chat="${esc(key)}" ${selected ? 'checked' : ''}>${esc(names(key))}${item.chatMode === 'context' ? ' · ' + (value ?? settings.maxTokens ?? 100000) + ' token' : ''}${badge}</label>`;
      })
      .join('');
    modal(
      item.name,
      `<form id="extension-form"><p class="extension-summary" id="extension-effective-summary"></p><label class="extension-option"><input type="checkbox" id="extension-enabled" aria-label="${item.chatMode === 'override' ? '全局默认开启' : '启用此功能'}" ${enabled ? 'checked' : ''}>${item.chatMode === 'override' ? '全局默认开启' : '启用此功能'} <strong id="extension-toggle-state">${enabled ? '已开启' : '已关闭'}</strong></label><p class="modal-description">${item.chatMode === 'override' ? '单个聊天可覆盖全局默认值，实际开启范围见下方。' : item.chatMode === 'selected' ? '总开关开启后，只向下方勾选的聊天主动发送。' : item.chatMode === 'context' ? '总开关开启后，向勾选的聊天应用现有压缩阈值。' : '对所有已允许的聊天生效。'}保存后生效。</p>${item.id === 'dsh-meme' ? `<div class="meme-import-option"><label class="extension-option"><input id="meme-allow-import" type="checkbox" ${settings.allowImport ? 'checked' : ''}>允许联网补图入库</label><small>还需为相应聊天开启联网搜索；已有图库检索不需要联网。新图会提交给当前 DSH 模型核验并产生模型消耗。本次发送无需等待收藏；长期收藏仍限 50 张，满池由 DS 筛选。</small><a class="text-link" href="https://github.com/yyh-001/dsh-meme#安装" target="_blank" rel="noopener noreferrer">查看官方安装说明</a></div>` : ''}<fieldset class="extension-fieldset"><legend>聊天范围</legend>${rows || '<p class="card-description">尚未选择聊天，请先到聊天范围添加。</p>'}</fieldset><a class="text-link" href="${item.id === 'dsh-meme' ? '#stickers/sources' : '#chats'}" data-extension-config>${item.id === 'dsh-meme' ? '返回表情来源设置' : '在聊天中查看设置'}</a>${footer()}</form>`,
    );
    const form = document.querySelector('#extension-form');
    watchToggle(form);
    const paintProject = () => {
      const global = form.querySelector('#extension-enabled').checked;
      let count = 0;
      for (const badge of form.querySelectorAll('[data-feature-effective]')) {
        const input = [...form.querySelectorAll('[data-feature-chat]')].find(
          input => input.dataset.featureChat === badge.dataset.featureEffective,
        );
        const on =
          item.chatMode === 'all'
            ? global
            : input.tagName === 'SELECT'
              ? input.value === 'inherit'
                ? global
                : input.value === 'on'
              : global && input.checked;
        if (on) count++;
        badge.textContent = on ? '开启' : '关闭';
        badge.className = 'status-tag ' + (on ? 'ok' : 'muted');
      }
      form.querySelector('#extension-effective-summary').textContent =
        `当前设置：${item.chatMode === 'override' ? '全局默认' : '总开关'}${global ? '开启' : '关闭'} · 开启 ${count}/${chats.length} 个允许的聊天`;
    };
    form.addEventListener('change', paintProject);
    paintProject();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      const chatSettings = Object.fromEntries(
        [...form.querySelectorAll('[data-feature-chat]')].map(input => [
          input.dataset.featureChat,
          input.tagName === 'SELECT' ? (input.value === 'inherit' ? 'inherit' : input.value === 'on') : input.checked,
        ]),
      );
      try {
        const result = await api('/api/extensions/' + item.id, {
          revision: saved.revision,
          enabled: form.querySelector('#extension-enabled').checked,
          chatSettings,
          ...(item.id === 'dsh-meme'
            ? { settings: { allowImport: form.querySelector('#meme-allow-import').checked } }
            : {}),
        });
        onProjectSave?.(result, item.feature);
        closeModal();
        await renderPage();
        toast('扩展设置已保存，列表状态已更新。');
      } catch (error) {
        errorInForm(error);
        button.disabled = false;
      }
    });
  }
  function importDialog() {
    modal(
      '导入本地扩展',
      `<p class="modal-description">选择扩展所在目录。导入后默认关闭，你可以检查权限并选择聊天范围。</p><div class="field"><label for="extension-source">扩展目录</label><div class="input-with-button"><input id="extension-source" placeholder="选择包含清单或 SKILL.md 的目录"><button class="button" data-browse="folder" data-target="extension-source">${icon('folder')}选择</button></div></div><p id="extension-import-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="confirm-import-extension">导入</button></div>`,
    );
    document.querySelector('#confirm-import-extension').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api('/api/extensions/import', { path: document.querySelector('#extension-source').value });
        closeModal();
        await renderPage();
        toast('扩展已导入，请在设置中启用。');
      } catch (error) {
        document.querySelector('#extension-import-error').textContent = error.message;
        document.querySelector('#extension-import-error').hidden = false;
        button.disabled = false;
      }
    });
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-extension-config]')) {
      closeModal();
      return;
    }
    const button = event.target.closest('button');
    if (button?.id === 'import-extension') {
      importDialog();
      return;
    }
    if (button?.dataset.uninstallExtension) {
      const id = button.dataset.uninstallExtension;
      confirmAction('卸载扩展', '扩展文件会归档，本地数据保留。', '卸载', async () => {
        try {
          await api('/api/extensions/' + id + '/uninstall', { revision: catalog.revision });
          await renderPage();
          toast('扩展已卸载。');
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }
    if (button?.dataset.extensionDetails) {
      dialog(button.dataset.extensionDetails, true);
      return;
    }
    const id =
      button?.dataset.extension ??
      (!event.target.closest('a,input,select,textarea,button')
        ? event.target.closest('[data-extension-card]')?.dataset.extensionCard
        : null);
    if (id) dialog(id);
  });
  return {
    page,
    dshPage: () => dshUI.page(),
    pluginPage: id => plugins.page(id),
    mountPluginPage: () => plugins.mountPage(),
    disposePluginPage: () => plugins.disposePage(),
  };
}
