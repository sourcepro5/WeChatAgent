import { PERMISSION_LABELS as permissions } from './plugin-contract.mjs';
import { pluginSettingsMarkup, settingsViewLifecycle } from './plugin-config-ui.mjs';
import { mountPluginFrame } from './plugin-frame.mjs';
export function pluginCard(item, esc, icon) {
  return `<article class="extension-tile plugin-tile" data-plugin-card="${esc(item.id)}"><div class="extension-tile-top"><div><h2><button class="extension-title" data-plugin-settings="${esc(item.id)}">${esc(item.name)}</button></h2></div><div class="plugin-card-actions">${item.ui?.page && !item.invalid ? `<a class="button extension-card-action" href="#plugin/${esc(item.id)}">打开</a>` : ''}<button class="button extension-card-action" data-plugin-settings="${esc(item.id)}">配置</button></div></div><p class="extension-byline">${icon('plug')}<span>${esc(item.author || '本机插件')} · v${esc(item.version ?? '?')}</span></p><p class="extension-card-state"><span class="status-tag ${esc(item.statusTone)}">${esc(item.statusLabel)}</span><span>${item.chats === null ? '所有允许的聊天' : (item.chats ?? []).length + ' 个聊天'}</span></p><p class="extension-card-description">${esc(item.description)}</p>${item.serviceStatus ? `<p class="plugin-service-status"><span class="status-tag ${['ok', 'error', 'warning', 'pending'].includes(item.serviceStatus.state) ? item.serviceStatus.state : 'pending'}">${esc(item.serviceStatus.label)}</span><small>${esc(item.serviceStatus.message)}</small></p>` : ''}<div class="extension-card-tags"><span>WeChatAgent 插件</span><span>API v2</span></div><footer class="extension-card-footer"><small>${esc(item.reason)}</small><button class="text-link" data-plugin-uninstall="${esc(item.id)}">卸载</button></footer></article>`;
}
export function createPluginUI({
  api,
  modal,
  closeModal,
  confirmAction,
  escapeHtml: esc,
  state,
  renderPage,
  toast,
  icon,
}) {
  let sequence = 0,
    ticket = null;
  const names = key => state.names.get(key) ?? key;
  const views = settingsViewLifecycle();
  const allowedChats = () =>
    ['private', 'group'].flatMap(kind =>
      (state.config.wechat.whitelist[kind === 'group' ? 'groups' : 'private'] ?? []).map(
        value => 'wechat:' + kind + ':' + value,
      ),
    );
  // Every handler is bound to one plugin id; the page cannot name another
  // plugin, change permissions, enablement or chat scope.
  function bridgeHandlers(id, mode, { packageRevision, onClose, onSaved, runAllowed = () => false }) {
    const fresh = async () => {
      const catalog = await api('/api/plugins'),
        item = catalog.plugins.find(row => row.id === id);
      if (!item || item.invalid) throw Error('插件已卸载或清单无效。');
      if (item.revision !== packageRevision) throw Error('插件包已更新，请重新打开页面。');
      return { catalog, item };
    };
    const chatsOf = item =>
      allowedChats()
        .filter(key => item.chats === null || item.chats.includes(key))
        .map(key => ({ key, name: names(key) }));
    return {
      'host.info': async () => {
        const { item } = await fresh();
        // voice-input-v1 facts (decoder, latest real voice) for audio_read plugins only.
        const host = item.requestedPermissions.includes('audio_read') ? await api('/api/plugins/' + id + '/host-status') : {};
        return { pluginId: item.id, name: item.name, version: item.version, enabled: item.enabled, active: item.active === true, status: item.statusLabel, mode, chats: chatsOf(item), settingsActions: mode === 'settings' ? item.ui?.settings?.actions ?? [] : [], runAllowed: mode === 'settings' && runAllowed(), ...host };
      },
      'settings.get': async () => {
        const { item } = await fresh();
        return { values: item.settings, schema: item.configSchema };
      },
      'settings.save': async ({ values }) => {
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('设置必须是对象。');
        const { catalog, item } = await fresh();
        const unknown = Object.keys(values).filter(key => !Object.hasOwn(item.configSchema, key));
        if (unknown.length) throw Error('未知设置字段：' + unknown.join('、'));
        const result = await api('/api/plugins/' + id, { revision: catalog.revision, packageRevision: item.revision, enabled: item.enabled, permissions: item.permissions, chats: item.chats, settings: values });
        onSaved?.(result.revision);
        return { ok: true };
      },
      'actions.call': async ({ action, args, key }) => {
        if (typeof action !== 'string' || !/^[a-z][a-z0-9-]{0,19}$/.test(action)) throw Error('动作名称无效。');
        if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw Error('动作参数必须是对象。');
        const { item } = await fresh();
        // Declared settings actions run without DSH or a chat, but only after the
        // user has allowed this plugin's code to run in the dialog.
        if (mode === 'settings' && item.ui?.settings?.actions?.includes(action)) {
          if (!runAllowed()) throw Error('请先勾选“允许此插件运行”，再使用插件提供的检测。');
          return api('/api/plugins/' + id + '/settings-actions/' + action, { packageRevision: item.revision, args: args ?? {} });
        }
        if (!item.enabled) throw Error('插件尚未启用，请先在配置中允许运行。');
        const chats = chatsOf(item),
          target = key ?? (chats.length === 1 ? chats[0].key : undefined);
        if (!chats.some(chat => chat.key === target)) throw Error(chats.length ? '请选择此插件已授权的聊天。' : '此插件尚未分配聊天。');
        return api('/api/plugins/' + id + '/actions/' + action, { key: target, args: args ?? {} });
      },
      'ui.resize': ({ height }, bridge) => bridge.resize(height),
      'ui.toast': ({ text }) => {
        toast(String(text ?? '').slice(0, 200));
        return { ok: true };
      },
      'ui.close': () => {
        onClose();
        return { ok: true };
      },
    };
  }
  let pageFrame = null,
    pendingPage = null,
    pagePluginId = null;
  function disposePage() {
    pageFrame?.dispose();
    pageFrame = null;
    pendingPage = null;
    pagePluginId = null;
  }
  async function page(id) {
    disposePage();
    const catalog = await api('/api/plugins'),
      item = catalog.plugins.find(row => row.id === id);
    if (!item?.ui?.page || item.invalid)
      return `<section class="card"><p class="inline-error">${esc(item?.uiError ?? '这个插件没有提供页面，或已经卸载。')}</p><a class="button" href="#extensions">返回能力目录</a></section>`;
    pendingPage = item;
    document.querySelector('#page-title').textContent = item.ui.page.title;
    document.querySelector('#breadcrumb-page').textContent = item.ui.page.title;
    document.querySelector('#page-description').textContent = item.ui.page.description || item.name + ' 提供的页面，在隔离环境中运行。';
    document.title = item.ui.page.title + ' · WeChatAgent';
    return `<section class="plugin-page" data-plugin-page="${esc(item.id)}"><div class="plugin-page-bar"><span class="status-tag ${esc(item.statusTone)}">${esc(item.statusLabel)}</span><small>${esc(item.name)} · v${esc(item.version)}</small><span class="plugin-page-spacer"></span><a class="button" href="#extensions">能力目录</a><button class="button" data-plugin-settings="${esc(item.id)}">配置</button></div><div class="plugin-page-frame" id="plugin-page-frame"></div></section>`;
  }
  function mountPage() {
    const host = document.querySelector('#plugin-page-frame'),
      item = pendingPage;
    pendingPage = null;
    if (!host || !item) return;
    pagePluginId = item.id;
    pageFrame = mountPluginFrame({
      container: host,
      src: item.ui.page.url,
      title: item.ui.page.title,
      fixedHeight: true,
      handlers: bridgeHandlers(item.id, 'page', {
        packageRevision: item.revision,
        onClose: () => {
          location.hash = '#extensions';
        },
      }),
    });
  }
  const retireSettings = id => {
    if (id !== undefined && pagePluginId === id) disposePage();
    const form = document.querySelector('#plugin-settings-form');
    if (form && (id === undefined || form.dataset.pluginId === id)) closeModal();
    views.retire(id);
  };
  function installMarkup(catalog) {
    if (catalog.pluginError)
      return `<p class="inline-error" role="alert">${esc(catalog.pluginError)} 内置能力继续可用。</p>`;
    return catalog.canInstallZip
      ? `<section class="plugin-install-entry" id="plugin-install-entry" aria-label="安装 WeChatAgent 插件"><div><strong>${icon('plug')} 把新功能放进来</strong><p>拖入 ZIP 插件，或选择文件安装。安装后可单独选择聊天与权限。</p></div><div class="plugin-install-actions"><button class="button primary" data-plugin-install>安装 ZIP 插件</button><a class="text-link" href="/plugin-api.md" download="WeChatAgent-plugin-api-v2.md" aria-label="下载插件开发规范 Markdown">开发规范</a><a class="text-link" href="/plugin-example.zip" download="chat-notes-1.1.0.zip">示例 ZIP</a></div></section>`
      : '';
  }
  const error = message => {
    const field = document.querySelector('#plugin-install-error');
    if (field) field.textContent = message;
    else toast(message);
  };
  function installDialog(file) {
    retireSettings();
    sequence++;
    if (ticket) api('/api/plugins/cancel', { ticket }).catch(() => {});
    ticket = null;
    let installView;
    modal(
      '安装 WeChatAgent 插件',
      `<div id="plugin-install-view"><p class="modal-description">适用于遵循 WeChatAgent API v2 的插件。DSH 插件仍在 DSH 中安装。</p><label class="plugin-dropzone" id="plugin-dropzone" for="plugin-zip"><strong>将一个 ZIP 文件拖到这里</strong><span>或点击选择文件 · 最多 8 MiB</span><input id="plugin-zip" type="file" accept=".zip,application/zip" aria-label="选择 ZIP 插件"></label><div id="plugin-install-preview" aria-live="polite"></div><p id="plugin-install-error" class="inline-error" role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="plugin-install-confirm" disabled>确认安装</button></div></div>`,
      {
        onClose: () => {
          sequence++;
          if (ticket) api('/api/plugins/cancel', { ticket }).catch(() => {});
          ticket = null;
          installView?.remove();
        },
      },
    );
    installView = document.querySelector('#plugin-install-view');
    document.querySelector('#plugin-zip').addEventListener('change', event => inspect(event.target.files[0]));
    document.querySelector('#plugin-install-confirm').addEventListener('click', async event => {
      const preview = document.querySelector('#plugin-install-preview'),
        replace = preview.querySelector('#plugin-replace');
      if (replace && !replace.checked) {
        error('请先确认更新同名插件，或取消安装。');
        return;
      }
      const request = sequence;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api('/api/plugins/install', { ticket, revision: preview.dataset.revision, replace: !!replace?.checked });
        if (request !== sequence) return;
        ticket = null;
        closeModal();
        await renderPage();
        toast('插件已安装，尚未启用。点击插件“配置”选择聊天和权限。');
      } catch (cause) {
        if (request !== sequence) return;
        error(cause.message);
        button.disabled = false;
      }
    });
    if (file) inspect(file);
  }
  async function inspect(file) {
    if (!file) return;
    const button = document.querySelector('#plugin-install-confirm'),
      preview = document.querySelector('#plugin-install-preview');
    button.disabled = true;
    preview.textContent = '正在检查插件…';
    error('');
    if (!file.name.toLowerCase().endsWith('.zip') || file.size > 8 * 1024 * 1024) {
      preview.textContent = '';
      error('请选择不超过 8 MiB 的 ZIP 文件。');
      return;
    }
    if (ticket) {
      api('/api/plugins/cancel', { ticket }).catch(() => {});
      ticket = null;
    }
    const request = ++sequence;
    try {
      const zip = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('无法读取 ZIP 文件。'));
        reader.readAsDataURL(file);
      });
      if (sequence !== request) return;
      const result = await api('/api/plugins/inspect', { name: file.name, zip });
      if (sequence !== request) {
        api('/api/plugins/cancel', { ticket: result.ticket }).catch(() => {});
        return;
      }
      ticket = result.ticket;
      preview.dataset.revision = result.revision;
      preview.innerHTML = `<section class="plugin-preview"><h3>${esc(result.plugin.name)} <small>v${esc(result.plugin.version)}</small></h3><p>${esc(result.plugin.description)}</p><small>${esc(result.plugin.id)} · ${result.files} 个文件 · ${Math.ceil(result.bytes / 1024)} KiB</small><h4>申请的能力</h4><ul>${result.plugin.permissions.length ? result.plugin.permissions.map(value => `<li>${esc(permissions[value])}</li>`).join('') : '<li>不申请额外宿主权限</li>'}</ul>${result.compatibility?.compatible === false ? `<p class="inline-error">${esc(result.compatibility.reason)}</p>` : ''}${result.hasPages ? '<p class="subtle">包含插件自己的页面：页面在隔离环境中显示，只能读写本插件设置并调用本插件动作。</p>' : ''}<p class="subtle">安装阶段不会运行代码。插件启用后会执行本地 JavaScript，请只启用信任的来源。</p>${result.installedVersion ? `<label class="extension-option"><input id="plugin-replace" type="checkbox">更新已有 v${esc(result.installedVersion)}，保留数据并归档旧代码；更新后需重新启用。</label>` : ''}</section>`;
      button.textContent = result.installedVersion ? '确认更新' : '确认安装';
      button.disabled = false;
    } catch (cause) {
      if (sequence === request) {
        preview.textContent = '';
        error(cause.message);
      }
    }
  }
  async function settings(id) {
    retireSettings();
    const view = views.begin(id);
    try {
      const catalog = await api('/api/plugins', undefined, true, { signal: view.signal }),
        item = catalog.plugins.find(item => item.id === id);
      if (!view.current()) return;
      if (!item) throw Error('插件已变化，请刷新列表。');
      const chats = allowedChats();
      const framed = !!item.ui?.settings && !item.invalid;
      const fieldMarkup = (key, schema, index) => {
        const ui = item.configUi?.fieldOptions?.[key] ?? {};
        const value = item.settings[key] ?? schema.default ?? '',
          field = 'plugin-setting-' + index,
          label = esc(ui.label ?? schema.title ?? key),
          attr = `id="${field}" data-plugin-setting="${esc(key)}"`;
        if (schema.type === 'boolean')
          return `<label class="extension-option"><input ${attr} type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
        if (schema.enum)
          return `<div class="field"><label for="${field}">${label}</label><select ${attr}>${schema.enum.map((option, n) => `<option value="${n}" ${option === value ? 'selected' : ''}>${esc(ui.enumLabels?.[n] ?? option)}</option>`).join('')}</select><small>${esc(ui.help ?? schema.description ?? '')}</small></div>`;
        if (['object', 'array'].includes(schema.type))
          return `<div class="field"><label for="${field}">${label}（JSON）</label><textarea ${attr}>${esc(JSON.stringify(value, null, 2))}</textarea></div>`;
        return `<div class="field"><label for="${field}">${label}</label><input ${attr} type="${schema.secret ? 'password' : ['integer', 'number'].includes(schema.type) ? 'number' : 'text'}" value="${esc(value)}" ${ui.placeholder && !schema.secret ? `placeholder="${esc(ui.placeholder)}"` : ''} ${schema.secret ? 'placeholder="留空保留已保存值" autocomplete="off"' : ''}><small>${esc(ui.help ?? schema.description ?? '')}</small></div>`;
      };
      const fieldRows = Object.entries(item.configSchema).map(([key, schema], index) => ({
        key,
        html: fieldMarkup(key, schema, index),
      }));
      const settingsMarkup = framed
        ? '<div class="plugin-frame-host" id="plugin-frame-host"></div>'
        : (item.uiError ? `<p class="inline-error">${esc(item.uiError)}</p>` : '') + pluginSettingsMarkup(item, fieldRows, esc);
      const activation = `<label class="extension-option"><input id="plugin-enabled" type="checkbox" ${item.enabled ? 'checked' : ''} ${item.invalid ? 'disabled' : ''}>允许此插件运行（仅启用信任的代码）</label>`;
      const scopeMarkup = `<fieldset class="extension-fieldset"><legend>授权能力与聊天</legend>${item.requestedPermissions.map(value => `<label class="extension-option"><input name="plugin-permission" type="checkbox" value="${esc(value)}" ${item.permissions.includes(value) ? 'checked' : ''}>${esc(permissions[value])}</label>`).join('') || '<p class="subtle">不需要额外权限。</p>'}<label class="extension-option"><input id="plugin-all-chats" type="checkbox" ${item.chats === null ? 'checked' : ''}>所有已允许的聊天</label>${chats.map(key => `<label class="extension-option"><input name="plugin-chat" type="checkbox" value="${esc(key)}" ${item.chats === null || item.chats.includes(key) ? 'checked' : ''}>${esc(names(key))}</label>`).join('') || '<p class="subtle">请先添加允许的聊天。</p>'}</fieldset>`;
      const description = esc(item.reason) + '。保存后在空闲时或下一轮聊天加载；首次使用 API v2 需重开 DSH。';
      modal(
        item.name,
        `<form id="plugin-settings-form" data-plugin-id="${esc(item.id)}" data-plugin-revision="${esc(item.revision)}">${activation}${scopeMarkup}${settingsMarkup}<p class="modal-description">${description}</p><p class="inline-error" id="plugin-settings-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存插件设置</button></div></form>`,
        { onClose: () => view.close() },
      );
      const form = document.querySelector('#plugin-settings-form'),
        all = form.querySelector('#plugin-all-chats');
      let revision = catalog.revision,
        frame;
      if (framed)
        frame = mountPluginFrame({
          container: form.querySelector('#plugin-frame-host'),
          src: item.ui.settings.url,
          title: item.name + ' 设置',
          height: item.ui.settings.height,
          handlers: bridgeHandlers(item.id, 'settings', {
            packageRevision: item.revision,
            onClose: () => closeModal(),
            onSaved: next => {
              revision = next;
            },
            runAllowed: () => form.querySelector('#plugin-enabled').checked,
          }),
        });
      view.bind(() => { frame?.dispose(); form.remove(); });
      // Lets a settings page know when its declared settings actions become runnable.
      form.querySelector('#plugin-enabled').addEventListener('change', event => frame?.emit('run-allowed', { runAllowed: event.target.checked }));
      // The page owns its fields; the host asks for them when saving. A page
      // without a collect handler keeps the stored settings unchanged.
      const collectFrame = async () => {
        let values;
        try {
          values = await frame.request('collect', { enabled: form.querySelector('#plugin-enabled').checked }, 10000);
        } catch (cause) {
          if (cause.timeout) return {};
          throw cause;
        }
        if (values === null || values === undefined) return {};
        if (typeof values !== 'object' || Array.isArray(values)) throw Error('插件页面返回的设置无效。');
        return values;
      };
      const readValues = () => {
        const values = { ...item.settings };
        for (const input of form.querySelectorAll('[data-plugin-setting]')) {
          const schema = item.configSchema[input.dataset.pluginSetting];
          values[input.dataset.pluginSetting] = schema.enum
            ? schema.enum[Number(input.value)]
            : schema.type === 'boolean'
              ? input.checked
              : ['object', 'array'].includes(schema.type)
                ? JSON.parse(input.value)
                : ['integer', 'number'].includes(schema.type)
                  ? Number(input.value)
                  : input.value;
        }
        return values;
      };
      const scope = () => {
        for (const input of form.querySelectorAll('[name="plugin-chat"]')) input.disabled = all.checked;
      };
      all.addEventListener('change', scope);
      scope();
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!view.current()) return;
        const button = event.submitter ?? form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          const values = frame ? await collectFrame() : readValues();
          if (!view.current()) return;
          await api('/api/plugins/' + item.id, {
            revision,
            packageRevision: item.revision,
            enabled: form.querySelector('#plugin-enabled').checked,
            permissions: [...form.querySelectorAll('[name="plugin-permission"]:checked')].map(input => input.value),
            chats: all.checked
              ? null
              : [...form.querySelectorAll('[name="plugin-chat"]:checked')].map(input => input.value),
            settings: values,
          });
          if (!view.current()) return;
          closeModal();
          await renderPage();
          toast('插件设置已保存。');
        } catch (cause) {
          if (!view.current()) return;
          form.querySelector('#plugin-settings-error').textContent = cause.message;
          button.disabled = false;
        }
      });
    } catch (cause) {
      if (view.current() && cause.name !== 'AbortError') toast(cause.message);
    }
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-plugin-install],[data-plugin-settings],[data-plugin-uninstall]');
    if (!button) return;
    if (button.hasAttribute('data-plugin-install')) installDialog();
    if (button.dataset.pluginSettings) settings(button.dataset.pluginSettings);
    if (button.dataset.pluginUninstall) {
      const id = button.dataset.pluginUninstall;
      retireSettings(id);
      const catalog = await api('/api/plugins').catch(() => null);
      if (!catalog) return toast('无法读取插件列表，请重试。');
      confirmAction('卸载插件', '插件代码会归档，保存的数据保留。', '卸载', async () => {
        try {
          await api('/api/plugins/' + id + '/uninstall', { revision: catalog.revision });
          retireSettings(id);
          await renderPage();
          toast('插件已卸载，数据已保留。');
        } catch (cause) {
          toast(cause.message);
        }
      });
    }
  });
  document.addEventListener('dragover', event => {
    if (
      event.dataTransfer?.types?.includes('Files') &&
      (document.querySelector('#plugin-install-entry') || document.querySelector('#plugin-dropzone'))
    ) {
      event.preventDefault();
      document.querySelector('#plugin-install-entry')?.classList.add('is-dragover');
    }
  });
  document.addEventListener('dragleave', event => {
    if (!event.relatedTarget) document.querySelector('#plugin-install-entry')?.classList.remove('is-dragover');
  });
  document.addEventListener('drop', event => {
    if (!document.querySelector('#plugin-install-entry') && !document.querySelector('#plugin-dropzone')) return;
    event.preventDefault();
    document.querySelector('#plugin-install-entry')?.classList.remove('is-dragover');
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) return toast('一次拖入一个 ZIP 插件即可。');
    installDialog(files[0]);
  });
  return { installMarkup, settings, installDialog, page, mountPage, disposePage, disposeViews: () => { views.retire(); disposePage(); } };
}
