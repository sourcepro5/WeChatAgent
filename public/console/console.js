'use strict';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const state = { token: '', config: null, draft: null, revision: '', page: 'overview', roles: [], roleDrafts: new Map(), selectedRole: '', chatKind: 'private', names: new Map(), status: null, job: null, logs: null, loading: false, reader: null };
const pages = {
  setup: ['首次配置', '按下面的步骤连接自己的微信与模型，无需命令行。'],
  overview: ['概览', '微信助手的运行情况，一眼看清。'],
  chats: ['聊天范围', '只回复你允许的好友和群聊。'],
  roles: ['人格', '设置助手的性格、语气与聊天习惯。'],
  sessions: ['会话', '每个聊天都有独立上下文，在这里查看与整理。'],
  behavior: ['回复设置', '决定何时回复，以及回复的频率。'],
  connections: ['连接设置', '连接本机微信、读取服务与 DSH。'],
  logs: ['运行日志', '查看最近的运行记录，定位连接与收发问题。'],
  tools: ['工具', '安装、检查与维护，通过按钮完成。'],
};
const actions = {
  start: ['启动服务', '正在检查账号与连接，启动通常需要几十秒。'],
  stop: ['停止服务', '停止本项目管理的服务，控制台会继续保持打开。'],
  restart: ['重启并应用', '正在重新读取设置并重启本项目服务。'],
  prepare: ['准备配置', '生成连接配置与插件设置。'],
  setup: ['安装依赖', '按现有锁文件安装依赖，需要联网，可能耗时几分钟。'],
  'wechat-open': ['打开匹配微信', '校验现有客户端和发送组件，然后打开微信。'],
  'dsh-open': ['打开 DSH', '打开模型程序，在 DSH 中登录并启用本项目插件。'],
  'reader-check': ['检查读取配置', '只读检查当前数据库与凭据是否有效。'],
  'hook-check': ['检查发送连接', '校验发送组件、微信版本和账号。'],
  'hook-build': ['构建发送组件', '使用现有构建脚本，需要已准备的源码与 C++ 工具。'],
  'hook-pin': ['开启客户端保护', '对本项目的匹配微信目录设置写保护，并停用目录内的更新程序。'],
  'hook-unpin': ['解除客户端保护', '恢复此前备份的目录权限。'],
  'sessions-configure': ['同步会话名称', '按聊天名称和当前人格更新 DSH 会话名称。'],
  'sessions-compact': ['压缩上下文', '在同一 DSH 会话内生成摘要，这会调用模型。'],
};
const getPath = (object, path) => {const value=path.split('.').reduce((value,key)=>value?.[key],object);return value===undefined&&['wechat.stickers.enabled','wechat.stickers.labelCache'].includes(path)?true:value;};
function setPath(object, path, value) { const keys = path.split('.'); const last = keys.pop(); let target = object; for (const key of keys) target = target[key] ??= {}; target[last] = value; }
const configDirty = () => state.config && JSON.stringify(state.config) !== JSON.stringify(state.draft);
const readerDirty = () => !!state.readerDraft && (state.readerDraft.dbPath !== (state.reader?.dbPath ?? '') || state.readerDraft.myWxid !== (state.reader?.myWxid ?? '') || !!state.readerDraft.decryptKey);
const hasDraft = () => configDirty() || state.roleDrafts.size > 0 || readerDirty();
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function showError(message) { $('#connection-error').textContent = message; $('#connection-error').hidden = false; }
function updateDraftUI() {
  $('#save-bar').hidden = !hasDraft(); document.body.classList.toggle('has-draft', hasDraft());
  $('#nav-chat-count').textContent = state.draft ? state.draft.wechat.whitelist.private.length + state.draft.wechat.whitelist.groups.length : '—';
  $('#save-button').disabled = !!state.job && state.job.state === 'running';
}
async function api(route, body, retry = true) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Console-Token': state.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(route === '/api/browse' ? 180000 : 20000) });
  const result = await response.json();
  if (response.status === 401 && retry) {
    const info = await fetch('/api/info').then(r => r.json());
    if (info.root !== state.root) throw new Error('控制台连接到其他项目，请重新打开当前项目入口。');
    state.token = info.token; return api(route, body, false);
  }
  if (!response.ok) throw new Error(result.error ?? '操作失败，请重试。');
  return result;
}
function modal(title, content) { $('#modal-title').textContent = title; $('#modal-content').innerHTML = content; if (!$('#modal').open) $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function confirmAction(title, description, label, callback) {
  modal(title, `<p class="modal-description">${escapeHtml(description)}</p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="confirm-action">${escapeHtml(label)}</button></div>`);
  $('#confirm-action').addEventListener('click', () => { closeModal(); callback(); }, { once: true });
}
function field(label, path, { type = 'text', help = '', placeholder = '', transform = '', min, max, step, full = false, browse = '' } = {}) {
  let value = getPath(state.draft, path);
  if (transform === 'lines') value = (value ?? []).join('\n');
  if (transform === 'seconds') value /= 1000;
  const id = 'field-' + path.replaceAll('.', '-');
  const attrs = `id="${id}" data-path="${path}" data-transform="${transform}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${step ? `step="${step}"` : ''}`;
  const input = transform === 'lines' ? `<textarea ${attrs} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>` : `<input ${attrs} type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
  return `<div class="field ${full ? 'full' : ''}"><label for="${id}">${label}</label>${browse ? `<div class="input-with-button">${input}<button class="button" data-browse="${browse}" data-target="${id}">${icon('folder')}选择</button></div>` : input}${help ? `<small>${help}</small>` : ''}</div>`;
}
function toggle(label, path, help) {
  const id = 'switch-' + path.replaceAll('.', '-');
  return `<div class="switch-row"><div><label for="${id}">${label}</label><p>${help}</p></div><label class="switch-control"><input type="checkbox" role="switch" id="${id}" data-path="${path}" ${getPath(state.draft, path) ? 'checked' : ''} aria-label="${label}"><span class="switch-track"></span></label></div>`;
}
function header(title, description = '', right = '', name = '') { return `<div class="card-header"><div class="${name ? 'section-label' : ''}">${name ? `<span class="section-icon">${icon(name)}</span>` : ''}<div><h2>${title}</h2>${description ? `<p class="card-description">${description}</p>` : ''}</div></div>${right}</div>`; }
function empty(title, description, button = '', name = 'chat') { return `<div class="empty-state">${icon(name)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${button}</div>`; }
function modeSelector() {
  return `<div class="mode-selector"><button class="mode-option ${state.draft.wechat.wake_mode === 'hybrid' ? 'selected' : ''}" data-mode="hybrid" aria-pressed="${state.draft.wechat.wake_mode === 'hybrid'}"><strong>自然参与</strong><span>普通群消息也可判断回复</span></button><button class="mode-option ${state.draft.wechat.wake_mode === 'mention' ? 'selected' : ''}" data-mode="mention" aria-pressed="${state.draft.wechat.wake_mode === 'mention'}"><strong>唤醒后回复</strong><span>识别昵称提示与唤醒词</span></button></div>`;
}
function overviewPage() {
  const c = state.draft;
  return `<div class="dashboard-grid">
    <section class="card power-card"><div class="power-top"><div class="power-copy"><span class="eyebrow">微信助手</span><h2 id="power-title">正在检查连接</h2><p id="power-description">等待本机服务响应。</p></div><button class="power-control" id="power-button" data-action="start" aria-label="启动服务">${icon('power')}</button></div><div class="power-bottom"><span id="power-tag" class="status-tag">检查中</span><div class="button-row"><button class="button small" data-action="wechat-open">${icon('chat')}打开微信</button><button class="button small" data-action="restart">${icon('refresh')}重启</button></div></div></section>
    <section class="card">${header('群聊回复方式', '', '<a class="text-link" href="#behavior">设置' + icon('arrow') + '</a>')}<div id="overview-mode">${modeSelector()}</div><p class="mode-footnote">仅对允许的群聊生效。私聊按现有规则回复。</p></section>
    <section class="card wide">${header('连接检查', '', '<a class="text-link" href="#connections">连接设置' + icon('arrow') + '</a>')}<div class="service-track" id="service-track"><div class="loading-state">检查本机连接中…</div></div></section>
    <div class="metrics wide"><section class="card"><div class="metric-label">${icon('chat')}缓存消息</div><div class="metric-value" id="metric-messages">—<span>条</span></div><p class="metric-note" id="metric-note">本机保留的消息记录</p></section><section class="card"><div class="metric-label">${icon('person')}允许的好友</div><div class="metric-value">${c.wechat.whitelist.private.length}<span>位</span></div><a class="text-link metric-note" href="#chats">管理聊天范围 ${icon('arrow')}</a></section><section class="card"><div class="metric-label">${icon('users')}允许的群聊</div><div class="metric-value">${c.wechat.whitelist.groups.length}<span>个</span></div><p class="metric-note">独立人格与会话上下文</p></section></div>
    <section class="card">${header('最近记录', '', '<a class="text-link" href="#sessions">查看会话' + icon('arrow') + '</a>')}<div id="recent-list"><div class="loading-state">读取记录中…</div></div></section>
    <section class="card">${header('当前设置', '', '<a class="text-link" href="#connections">编辑' + icon('arrow') + '</a>')}<dl class="settings-summary"><div><dt>账号昵称</dt><dd>${escapeHtml(c.account.nicknames.join('、'))}</dd></div><div><dt>默认人格</dt><dd>${escapeHtml(c.persona.default)}</dd></div><div><dt>模型</dt><dd class="mono">${escapeHtml(c.dsh.model)}</dd></div><div><dt>群回复间隔</dt><dd>${c.social.min_interval_ms / 1000} 秒</dd></div><div><dt>群回复上限</dt><dd>${c.social.max_per_minute} 条 / 分钟</dd></div></dl><div class="quick-actions"><button class="button" data-action="reader-check">${icon('check')}检查读取</button><button class="button" data-action="hook-check">${icon('plug')}检查发送</button></div></section>
  </div>`;
}
function paintStatus() {
  const s = state.status; if (!s) return;
  $('#connection-label').innerHTML = `<i class="dot online"></i>本机已连接`;
  $('#updated-label').textContent = '更新于 ' + new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
  $('#pending-banner').hidden = !s.pendingApply && !s.dshRestartRequired;
  $('#pending-message').textContent = s.dshRestartRequired ? '模型或插件端口有更改：先在工具页准备配置，从托盘退出并重开 DSH，再重启服务。' : '设置已保存，重启服务后生效。';
  if (state.page !== 'overview') return;
  const runningJob = state.job?.state === 'running';
  $('#power-title').textContent = runningJob ? '正在' + (actions[state.job.action]?.[0] ?? '操作') : s.ready ? '运行中' : s.running ? '连接待完成' : '服务未启动';
  $('#power-description').textContent = runningJob ? '操作完成后会自动更新运行状态。' : s.ready ? '收发连接已就绪，按当前设置自动回复。' : s.running ? '部分连接尚未就绪，查看下方连接检查。' : '登录匹配微信后，点击右侧按钮启动。';
  const power = $('#power-button'); power.dataset.action = s.running ? 'stop' : 'start'; power.setAttribute('aria-label', s.running ? '停止服务' : '启动服务'); power.classList.toggle('active', s.ready); power.disabled = runningJob;
  $('#power-tag').className = 'status-tag ' + (s.ready ? 'ok' : s.running ? 'warn' : '');
  $('#power-tag').innerHTML = `<i class="dot ${s.ready ? 'online' : s.running ? 'warning' : ''}"></i>${s.ready ? '全部连接正常' : s.running ? '需要检查连接' : '等待启动'}`;
  $('#service-track').innerHTML = s.services.map(service => `<div class="service-node"><div class="service-node-top"><i class="dot ${service.ready ? 'online' : 'warning'}"></i><strong>${escapeHtml(service.label)}</strong><span class="port">:${service.port}</span></div><p>${escapeHtml(service.detail)}</p><span class="status-tag ${service.ready ? 'ok' : 'warn'}">${service.ready ? '已就绪' : '待连接'}</span></div>`).join('');
  $('#metric-messages').innerHTML = `${s.stats.received + s.stats.sent}<span>条</span>`;
  $('#metric-note').textContent = `接收 ${s.stats.received} · 发出 ${s.stats.sent} · 待处理 ${s.stats.pending}`;
  $('#recent-list').innerHTML = s.recent.length ? s.recent.map(row => `<div class="recent-row"><span class="avatar">${escapeHtml((row.name || '聊').slice(0, 1))}</span><div class="recent-copy"><strong>${escapeHtml(row.name || row.key)}</strong><p>${escapeHtml(row.text || '附件消息')}</p></div><div class="recent-meta">${new Date(row.timestamp * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}<div class="direction">${row.outgoing ? '发出' : '接收'}</div></div></div>`).join('') : empty('还没有消息记录', '服务启动后，允许的好友和群聊消息会出现在这里。', '', 'history');
}
function roleOptions(value, includeDefault = false) {
  return (includeDefault ? '<option value="">跟随默认人格</option>' : '') + state.roles.map(r => `<option value="${escapeHtml(r.name)}" ${r.name === value ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
}
function chatsPage() {
  const kind = state.chatKind; const list = state.draft.wechat.whitelist[kind];
  return `<section class="card"><div class="page-toolbar"><div class="segmented" aria-label="聊天类型"><button data-kind="private" class="${kind === 'private' ? 'selected' : ''}" aria-pressed="${kind === 'private'}">好友 · ${state.draft.wechat.whitelist.private.length}</button><button data-kind="groups" class="${kind === 'groups' ? 'selected' : ''}" aria-pressed="${kind === 'groups'}">群聊 · ${state.draft.wechat.whitelist.groups.length}</button></div><button class="button primary" id="add-chat">${icon('plus')}添加${kind === 'groups' ? '群聊' : '好友'}</button></div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>聊天</th><th>人格</th><th>表情发送</th><th>回复权限</th><th></th></tr></thead><tbody>${list.map(id => {
      const key = `wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`; const name = state.names.get(key);
      const stickerValue=state.draft.wechat.stickers?.chats?.[key];
      const stickerOptions=[['inherit','继承全局',stickerValue===undefined],['on','开启',stickerValue===true],['off','关闭',stickerValue===false]].map(([value,label,selected])=>`<option value="${value}" ${selected?'selected':''}>${label}</option>`).join('');
      return `<tr><td><div class="name-cell"><span class="avatar">${icon(kind === 'groups' ? 'users' : 'person')}</span><div><strong>${escapeHtml(name || (kind === 'groups' ? '群聊' : '好友') + ' · ' + String(id).slice(-4))}</strong><small class="mono">ID ${escapeHtml(id)}</small></div></div></td><td><select class="table-select" data-persona-key="${key}" aria-label="${escapeHtml(name || id)}的人格">${roleOptions(state.draft.persona.chats?.[key], true)}</select></td><td><select class="table-select" data-sticker-key="${key}" aria-label="${escapeHtml(name || id)}的表情发送">${stickerOptions}</select></td><td><span class="status-tag ok">已允许</span></td><td class="row-actions"><button class="icon-button" data-remove-id="${id}" aria-label="移出聊天范围 ${escapeHtml(name || id)}" title="移出聊天范围">${icon('close')}</button></td></tr>`;
    }).join('')}</tbody></table></div>` : empty(kind === 'groups' ? '尚未允许任何群聊' : '尚未允许任何好友', '点击添加，搜索聊天名称并勾选；也可以填写已有的数字 ID。', '<button class="button" id="empty-add-chat">' + icon('plus') + '添加聊天</button>', 'users')}
    <div class="notice plain">${icon('shield')}<span>表情开关保存后生效，不改变人格。聊天范围与人格等其他更改需重启应用。</span></div></section>`;
}
function addChats() {
  const kind = state.chatKind; const picked = new Map();
  modal(kind === 'groups' ? '添加群聊' : '添加好友', `<p class="modal-description">搜索电脑微信中的${kind === 'groups' ? '群聊' : '好友昵称或备注'}，勾选需要允许的聊天。</p><form id="contact-search-form" class="contact-search"><input id="contact-keyword" aria-label="聊天名称" placeholder="输入名称搜索"><button class="button" type="submit">${icon('search')}搜索</button></form><div class="contact-results" id="contact-results">${empty('输入名称，开始搜索', '需要读取服务已启动。服务未启动时，可使用下方的 ID 添加。', '', 'search')}</div><details class="advanced"><summary>使用已有的数字 ID 添加</summary><div class="field"><label for="manual-ids">聊天 ID</label><textarea id="manual-ids" placeholder="每行一个数字 ID"></textarea><small>填写已有 OneBot 数字 ID；群名与微信账号标识不能代替数字 ID。</small></div></details><div id="contact-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="contact-add">添加到聊天范围</button></div>`);
  $('#contact-search-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('#contact-error').textContent = '';
    try {
      const data = await api(`/api/contacts?kind=${kind}&keyword=${encodeURIComponent($('#contact-keyword').value)}`);
      $('#contact-results').innerHTML = data.contacts.length ? data.contacts.map(c => `<label class="contact-result"><input type="checkbox" value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" ${c.ambiguous || state.draft.wechat.whitelist[kind].map(String).includes(c.id) ? 'disabled' : ''} ${picked.has(c.id) ? 'checked' : ''}><span><strong>${escapeHtml(c.name)}</strong><small>ID ${c.id}${c.ambiguous ? ' · 名称重复，无法唯一识别' : state.draft.wechat.whitelist[kind].map(String).includes(c.id) ? ' · 已添加' : ''}</small></span></label>`).join('') : empty('没有找到匹配的聊天', '检查名称或备注，确认电脑微信已同步联系人。', '', 'search');
    } catch (error) { $('#contact-results').innerHTML = empty('暂时无法搜索', '请先在概览页启动服务，或填写已有数字 ID。', '', 'search'); $('#contact-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#contact-results').addEventListener('change', event => { const input = event.target; if (input.matches('input[type=checkbox]')) input.checked ? picked.set(input.value, input.dataset.name) : picked.delete(input.value); });
  $('#contact-add').addEventListener('click', () => {
    const manual = $('#manual-ids').value.trim().split(/[\s,，]+/).filter(Boolean);
    if (manual.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) { $('#contact-error').textContent = 'ID 应为正整数，请检查输入。'; return; }
    if (!manual.length && !picked.size) { $('#contact-error').textContent = '请勾选聊天或填写数字 ID。'; return; }
    state.draft.wechat.whitelist[kind] = [...new Set([...state.draft.wechat.whitelist[kind].map(String), ...picked.keys(), ...manual])];
    for (const [id, name] of picked) state.names.set(`wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`, name);
    closeModal(); renderPage(); updateDraftUI(); toast('已加入草稿，保存后重启应用。');
  });
}
function rolesPage() {
  const selected = state.roles.find(r => r.name === state.selectedRole) ?? state.roles[0];
  if (!selected) return `<section class="card">${empty('创建第一个人格', '填写人格名称、性格和语气，保存后即可在聊天中使用。', '<button class="button primary" id="new-role">创建人格</button>', 'person')}</section>`;
  state.selectedRole = selected.name;
  const content = state.roleDrafts.get(selected.name)?.content ?? selected.content;
  return `<div class="page-toolbar"><span class="subtle">${state.roles.length} 个人格 · 可为每个聊天单独指定</span><button class="button" id="new-role">${icon('plus')}新建人格</button></div><div class="role-layout"><div class="role-list">${state.roles.map(r => `<button class="role-item ${r.name === selected.name ? 'selected' : ''}" data-role="${escapeHtml(r.name)}" aria-pressed="${r.name === selected.name}"><strong>${escapeHtml(r.name)}</strong><small>${state.draft.persona.default === r.name ? '用于跟随默认的聊天' : '可指定给好友或群聊'}</small>${state.draft.persona.default === r.name ? '<span class="status-tag ok">默认人格</span>' : ''}</button>`).join('')}</div><section class="card">${header(escapeHtml(selected.name), '直接编辑性格与说话习惯，保存后重启应用。')}<label class="field-label" for="role-content">人格内容</label><textarea class="role-editor" id="role-content">${escapeHtml(content)}</textarea><div class="role-editor-toolbar"><span class="subtle" id="role-char-count">${content.length} 字</span><button class="button" id="set-default-role" ${state.draft.persona.default === selected.name ? 'disabled' : ''}>${icon('check')}${state.draft.persona.default === selected.name ? '已是默认人格' : '设为默认人格'}</button></div><p class="subtle">聊天中的切换人格请求不会修改这里的设置。</p></section></div>`;
}
function newRole() {
  modal('新建人格', `<div class="field"><label for="new-role-name">人格名称</label><input id="new-role-name" maxlength="61" placeholder="例如：温和助手"><small>名称也是本机文件名；不需要填写扩展名。</small></div><div class="field space-top"><label for="new-role-content">性格与语气</label><textarea id="new-role-content" rows="7" placeholder="描述助手的性格、说话习惯与边界。"></textarea></div><div id="role-create-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="create-role">创建人格</button></div>`);
  $('#create-role').addEventListener('click', async () => {
    const button = $('#create-role'); button.disabled = true;
    try { const name = $('#new-role-name').value.trim(); const content = $('#new-role-content').value; const result = await api('/api/roles', { name, content }); state.roles.push({ name, content, revision: result.revision }); state.selectedRole = name; closeModal(); renderPage(); await refreshStatus(); toast('人格已创建，可设为默认或指定给聊天。'); }
    catch (error) { $('#role-create-error').textContent = error.message; } finally { button.disabled = false; }
  });
}
function behaviorPage() {
  return `<div class="section-stack"><section class="card">${header('群聊参与', '聊天范围中的群聊使用以下方式。', '', 'chat')}<div id="behavior-mode">${modeSelector()}</div><div class="form-grid space-top">${field('唤醒词', 'wechat.wake_words', { transform: 'lines', help: '每行一个。群里识别这些文字后进入回复判断。', placeholder: '小助手' })}${field('账号昵称提示', 'account.nicknames', { transform: 'lines', help: '每行一个。填写账号在聊天中使用的昵称。' })}</div><div class="notice plain">${icon('info')}<span>“自然参与”也会判断普通群消息，选择沉默时仍可能调用模型。拍一拍回应继续使用原有规则。</span></div></section>
    <section class="card">${header('回复节奏', '控制消息合并、发送间隔与群聊频率。', '', 'sliders')}<div class="form-grid">${field('消息合并等待 / 秒', 'social.batch_ms', { type: 'number', transform: 'seconds', min: 0, max: 60, step: .1, help: '把短时间内收到的消息合并到同一轮判断。' })}${field('私聊回复最小间隔 / 秒', 'social.private_min_interval_ms', { type: 'number', transform: 'seconds', min: 0, max: 3600, step: .1 })}${field('群聊回复最小间隔 / 秒', 'social.min_interval_ms', { type: 'number', transform: 'seconds', min: 0, max: 3600, step: 1 })}${field('每分钟群回复上限 / 条', 'social.max_per_minute', { type: 'number', min: 1, max: 1000, step: 1 })}${field('每十分钟群回复上限 / 条', 'social.max_per_ten_minutes', { type: 'number', min: 1, max: 10000, step: 1 })}</div></section>
    <section class="card">${header('原生表情发送', '使用独立开关控制能力，继续沿用当前人格。', '', 'chat')}${toggle('允许发送原生表情包', 'wechat.stickers.enabled', '全局默认值；可在聊天范围中为好友或群聊单独开启或关闭。保存后生效，关闭保留已下载资源。')}${toggle('学习并复用表情标签', 'wechat.stickers.labelCache', '正常看图时顺便保存内容与情绪标签，不额外调用模型。已识别表情优先使用文字标签，减少重复看图。关闭保留缓存。')}</section>
    <section class="card">${header('图片与表情包', '普通图片继续从本机读取；以下选项仅影响表情包。', '', 'folder')}${toggle('允许从腾讯下载缺失的表情包', 'wechat.media.allowStickerCdn', '本机缓存缺失时，用白名单原消息提供的地址下载，并核验原消息摘要。')}${toggle('允许兼容旧版表情包地址', 'wechat.media.allowStickerCdnAlias', '将旧腾讯域名映射至兼容域名，仍使用 HTTPS 并核验摘要。')}</section></div>`;
}
function connectionsPage() {
  const r = state.reader;
  state.readerDraft ??= { dbPath: r?.dbPath ?? '', myWxid: r?.myWxid ?? '', decryptKey: '' };
  return `<div class="section-stack"><section class="card">${header('模型连接', '使用你已在 DSH 中配置的模型。', '', 'plug')}<div class="form-grid">${field('DSH 程序位置', 'runtime.dshDesktop', { full: true, browse: 'exe', placeholder: '选择 DeepSeek Harness.exe', help: '启动时若 DSH 尚未打开，会尝试打开这个程序。' })}${field('模型提供方标识', 'dsh.provider', { help: '与 DSH 中的 provider 标识一致。' })}${field('模型标识', 'dsh.model', { help: '图片理解需要当前模型支持图片输入。' })}</div><div class="notice plain">${icon('info')}<span>修改模型后：保存设置 → 在工具页准备配置 → 从托盘完全退出并重新打开 DSH → 重启服务。</span></div></section>
    <section class="card">${header('微信与读取程序', '选择本机已准备的程序。', '', 'chat')}<div class="form-grid">${field('匹配微信程序位置', 'hook.wechatExecutable', { full: true, browse: 'exe', help: '当前发送后端固定匹配 4.1.10.27。选择程序不会改变兼容版本。' })}${field('Python 程序位置', 'runtime.python', { full: true, browse: 'exe', help: '选择已有环境的 python.exe，也可填写可用的 Python 命令。' })}</div></section>
    <section class="card">${header('数据库读取设置', '保留已有设置；新环境在这里填入有效的本机配置。', '', 'folder')}<div class="form-grid"><div class="field full"><label for="reader-path">微信数据库目录</label><div class="input-with-button"><input id="reader-path" data-reader="dbPath" value="${escapeHtml(state.readerDraft.dbPath)}" placeholder="${r?.hasPath && !r.dbPath ? '已保存受保护目录；留空保留原值' : '包含账号目录或 db_storage 的本机目录'}"><button class="button" data-browse="folder" data-target="reader-path">${icon('folder')}选择</button></div></div><div class="field"><label for="reader-account">账号标识</label><input id="reader-account" data-reader="myWxid" value="${escapeHtml(state.readerDraft.myWxid)}" placeholder="${r?.hasAccount && !r.myWxid ? '已保存；留空保留' : '与数据库对应的账号标识'}"><small>对应原读取配置的 myWxid。</small></div><div class="field"><label for="reader-key">读取凭据</label><input id="reader-key" data-reader="decryptKey" value="${escapeHtml(state.readerDraft.decryptKey)}" type="password" autocomplete="new-password" placeholder="${r?.hasKey ? '已有凭据；留空保留' : '输入有效读取凭据'}"><small>新凭据使用 Windows 当前用户保护，已有凭据不会显示。</small></div></div><div class="button-row space-top"><button class="button" id="save-reader">保存读取设置</button><button class="button" data-action="reader-check">${icon('check')}检查读取</button></div><p id="reader-save-error" class="inline-error" role="alert"></p></section>
    <section class="card">${header('高级连接选项', '通常无需修改。端口需要互不重复。', '', 'sliders')}<details><summary>展开端口与发送超时设置</summary><div class="form-grid">${field('读取服务端口', 'ports.weflow', { type: 'number', min: 1024, max: 65535 })}${field('消息桥接端口', 'ports.onebot', { type: 'number', min: 1024, max: 65535 })}${field('适配器状态端口', 'ports.adapter', { type: 'number', min: 1024, max: 65535 })}${field('DSH 插件端口', 'ports.dshPlugin', { type: 'number', min: 1024, max: 65535 })}${field('发送后端地址', 'hook.baseUrl', { full: true, help: '必须为本机回环 HTTP 地址，例如 http://127.0.0.1:30001。' })}${field('发送请求超时 / 秒', 'hook.requestTimeoutMs', { type: 'number', transform: 'seconds', min: 1, max: 5, step: .1 })}${field('回执等待超时 / 秒', 'hook.receiptTimeoutMs', { type: 'number', transform: 'seconds', min: 1, max: 18, step: .1 })}${field('并发发送上限', 'hook.maxConcurrentSends', { type: 'number', min: 1, max: 4, step: 1 })}</div></details></section></div>`;
}
function toolsPage() {
  const row = (title, help, action, label = '执行') => `<div class="tool-row"><div><h3>${title}</h3><p>${help}</p></div><button class="button" data-action="${action}">${label}</button></div>`;
  return `<div class="tool-grid"><section class="card">${header('启动与配置', '', '', 'power')}${row('打开匹配微信', '校验并打开已准备的微信，随后在微信中登录。', 'wechat-open', '打开')}${row('准备项目配置', '更新连接配置与 DSH 插件的模型设置。', 'prepare', '准备')}${row('安装项目依赖', '按原安装脚本安装读取器与插件依赖。', 'setup', '安装')}</section><section class="card">${header('连接诊断', '', '', 'plug')}${row('检查数据库读取', '核验当前账号、数据库目录与读取凭据。', 'reader-check', '检查')}${row('检查后台发送', '只检查匹配版本、发送后端与账号是否就绪。', 'hook-check', '检查')}<div class="tool-row"><div><h3>模型或端口更改已处理</h3><p>从 DSH 托盘菜单完全退出并重新打开后，点击确认，然后重启服务。</p></div><button class="button" id="ack-dsh">已重开 DSH</button></div></section><section class="card">${header('发送组件', '', '', 'tool')}${row('构建原生发送组件', '需已有匹配源码和 C++ 构建工具。', 'hook-build', '构建')}</section><section class="card">${header('客户端维护', '', '', 'shield')}${row('开启客户端写保护', '只作用于项目 state/hook 下的客户端目录。', 'hook-pin', '开启')}${row('解除客户端写保护', '恢复原有目录权限；不修改版本适配。', 'hook-unpin', '解除')}<p class="subtle space-top">目录保护不保证旧版微信持续可登录。</p></section></div>`;
}
function setupPage() {
  const hasReader = state.deployment?.configured;
  return `<div class="section-stack"><div class="notice plain">${icon('shield')}<span>此安装包使用独立的本机数据目录。账号、读取凭据和聊天范围需要由你配置，初始聊天范围为空。</span></div><div class="tool-grid">
    <section class="card">${header('检查运行环境', 'Node.js、Python 和读取依赖均已内置。', '', 'check')}<p class="modal-description">不需要安装开发工具或系统 Python。可先检查安装文件是否完整。</p><button class="button" data-action="setup">验证内置环境</button></section>
    <section class="card">${header('登录匹配微信', '使用安装包准备的独立匹配客户端。', '', 'chat')}<p class="modal-description">打开微信并登录自己的账号，等待消息同步。目前发送组件适配 4.1.10.27；如果微信要求升级，请保留提示并检查兼容性。</p><button class="button" data-action="wechat-open">打开微信</button></section>
    <section class="card">${header('连接 DSH', '登录你自己的模型账号，添加本机插件。', '', 'plug')}<p class="modal-description">打开 DSH，在插件页面添加本应用的插件目录。添加并启用后，从托盘完整退出并重新打开 DSH。</p><div class="button-row"><button class="button" data-action="dsh-open">打开 DSH</button><button class="button" id="copy-plugin-path">复制插件路径</button><button class="button" id="open-plugin-folder">打开插件目录</button></div></section>
    <section class="card">${header('配置数据库读取', '', '<span class="status-tag ' + (hasReader ? 'ok' : 'warn') + '">' + (hasReader ? '已填写' : '待填写') + '</span>', 'folder')}<p class="modal-description">选择当前账号的微信数据库目录，填写对应账号标识与有效读取凭据。新凭据使用 Windows 当前用户保护，不会随安装包共享。</p><a class="button" href="#connections">填写读取设置</a></section>
    </div><section class="card">${header('启动并选择聊天范围', '前面的设置完成后，启动服务并检查连接。', '', 'power')}<p class="modal-description">启动后，在“聊天范围”搜索自己的好友或群聊。添加后保存并重启，助手只会处理允许的聊天。</p><div class="button-row"><button class="button primary" data-action="start">启动服务</button><a class="button" href="#chats">选择聊天范围</a><a class="button" href="#overview">查看连接状态</a></div></section></div>`;
}
async function sessionsPage() {
  const { sessions } = await api('/api/sessions');
  const allowed = new Set([...state.config.wechat.whitelist.private.map(id => 'wechat:private:' + id), ...state.config.wechat.whitelist.groups.map(id => 'wechat:group:' + id)]);
  const list = sessions.filter(session => allowed.has(session.conversationKey));
  const missing = [...allowed].filter(key => !list.some(session => session.conversationKey === key));
  return `<div class="section-stack"><div class="notice plain">${icon('info')}<span>压缩保留当前会话，需要额外调用模型。要归档会话，请在 DSH 中归档；新消息会按现有规则创建新会话。</span></div>${list.length ? `<div class="session-grid">${list.map(session => `<section class="card session-card">${header(escapeHtml(session.title || state.names.get(session.conversationKey) || session.conversationKey), '', '<span class="status-tag ok">独立上下文</span>')}<div class="session-id">${escapeHtml(session.conversationKey)}</div><div class="session-id">Session · ${escapeHtml(session.sessionId)}</div><div class="session-details"><div><strong>${session.initializations}</strong><span>人格初始化</span></div><div><strong>${session.compactions}</strong><span>上下文压缩</span></div><div><strong>${session.previousSessionCount}</strong><span>历史会话</span></div></div><div class="button-row"><button class="button" data-action="sessions-configure" data-key="${session.conversationKey}">同步名称</button><button class="button" data-action="sessions-compact" data-key="${session.conversationKey}">${icon('history')}压缩上下文</button></div></section>`).join('')}</div>` : `<section class="card">${empty('还没有已允许聊天的原生会话', '收到新消息后会自动建立；也可以用下方按钮初始化已保存的聊天。', '', 'history')}</section>`}${missing.length ? `<section class="card">${header('等待初始化的聊天')}<div class="section-stack">${missing.map(key => `<div class="tool-row"><div><h3>${escapeHtml(state.names.get(key) || key)}</h3><p>名称来自读取服务；当前聊天需已同步到电脑微信。</p></div><button class="button" data-action="sessions-configure" data-key="${key}">初始化会话</button></div>`).join('')}</div></section>` : ''}</div>`;
}
async function logsPage() {
  state.logs = await api('/api/logs' + (state.logs?.file ? '?file=' + encodeURIComponent(state.logs.file) : ''));
  return `<section class="card">${header('本机运行日志', '显示所选文件最近 120 KB 的内容。')}<div class="log-toolbar"><select id="log-file" aria-label="日志文件">${state.logs.files.map(file => `<option ${file === state.logs.file ? 'selected' : ''}>${escapeHtml(file)}</option>`).join('')}</select><input id="log-filter" aria-label="过滤日志" placeholder="筛选关键词"><button class="button" id="export-log">${icon('download')}导出当前日志</button></div><pre class="log-view" id="log-view" tabindex="0">${escapeHtml(state.logs.content || '当前没有日志记录。')}</pre><div class="log-caption"><span>连接令牌与受保护凭据已隐藏</span><button class="link-button" id="reload-log">刷新日志</button></div></section>`;
}
let renderSequence = 0;
async function renderPage() {
  if (!state.config) return;
  const sequence = ++renderSequence; const page = state.page;
  $('#page-title').textContent = pages[page][0]; $('#breadcrumb-page').textContent = pages[page][0]; $('#page-description').textContent = pages[page][1];
  document.title = pages[page][0] + ' · WeChatAgent';
  document.querySelectorAll('[data-page]').forEach(a => page === a.dataset.page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  let markup;
  try {
    if (['sessions', 'logs'].includes(page)) $('#page-body').innerHTML = '<div class="loading-state">正在读取…</div>';
    if (page === 'overview') markup = overviewPage();
    if (page === 'chats') markup = chatsPage();
    if (page === 'roles') markup = rolesPage();
    if (page === 'behavior') markup = behaviorPage();
    if (page === 'connections') { if (!state.reader) state.reader = await api('/api/reader-config'); markup = connectionsPage(); }
    if (page === 'tools') markup = toolsPage();
    if (page === 'setup') markup = setupPage();
    if (page === 'sessions') markup = await sessionsPage();
    if (page === 'logs') markup = await logsPage();
  } catch (error) {
    markup = `<section class="card">${empty('暂时无法读取', error.message, '<button class="button" id="retry-page">重试</button><a class="button" href="#overview">前往概览</a>', 'plug')}</section>`;
  }
  if (sequence !== renderSequence || state.page !== page) return;
  $('#page-body').innerHTML = markup; updateDraftUI(); paintStatus();
  $('#role-content')?.addEventListener('input', event => {
    const role = state.roles.find(r => r.name === state.selectedRole); const content = event.target.value;
    if (content === role.content) state.roleDrafts.delete(role.name); else state.roleDrafts.set(role.name, { name: role.name, content, revision: role.revision });
    $('#role-char-count').textContent = content.length + ' 字'; updateDraftUI();
  });
  $('#log-file')?.addEventListener('change', async event => { state.logs.file = event.target.value; await renderPage(); });
  $('#log-filter')?.addEventListener('input', event => { const value = event.target.value.toLowerCase(); $('#log-view').textContent = state.logs.content.split('\n').filter(line => line.toLowerCase().includes(value)).join('\n') || '没有匹配的日志。'; });
}
async function refreshStatus() {
  if (state.closed) return;
  try {
    state.status = await api('/api/status'); $('#connection-error').hidden = true; paintStatus();
    if (state.status.activeJob) {
      if (!state.job || state.job.id !== state.status.activeJob.id) $('#job-panel').hidden = false;
      state.job = state.status.activeJob; paintJob(); pollJob();
    } else if (state.status.latestJob && (!state.job || state.job.id === state.status.latestJob.id)) {
      state.job = state.status.latestJob; paintJob();
    }
  } catch (error) {
    $('#connection-label').innerHTML = '<i class="dot failed"></i>控制台未连接';
    showError(error.message + ' 若后台控制台已关闭，请重新双击控制台入口。');
    if (state.page === 'overview' && $('#power-button')) { $('#power-title').textContent = '状态暂不可用'; $('#power-button').disabled = true; }
  }
}
async function saveAll() {
  const invalid = [...document.querySelectorAll('[data-path]')].find(input => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  $('#save-button').disabled = true;
  try {
    for (const [name, draft] of state.roleDrafts) {
      const result = await api('/api/roles', draft); const role = state.roles.find(r => r.name === name);
      role.content = draft.content; role.revision = result.revision; state.roleDrafts.delete(name);
    }
    if (configDirty()) {
      const result = await api('/api/config', { config: state.draft, revision: state.revision });
      state.config = result.config; state.draft = structuredClone(result.config); state.revision = result.revision;
    }
    if (readerDirty()) await persistReader();
    updateDraftUI(); await refreshStatus(); toast('设置已保存，重启服务后生效。');
  } catch (error) { showError(error.message); }
  finally { $('#save-button').disabled = false; updateDraftUI(); }
}
function paintJob() {
  const job = state.job; if (!job) return;
  const name = actions[job.action]?.[0] ?? '操作'; const running = job.state === 'running';
  $('#job-title').textContent = name + (running ? '中' : job.state === 'succeeded' ? '完成' : '失败');
  $('#job-dot').className = 'dot ' + (running ? 'warning' : job.state === 'succeeded' ? 'online' : 'failed');
  $('#job-description').textContent = job.state === 'failed' ? job.message || '检查下方详细信息，修正配置或完成准备后重试。' : actions[job.action]?.[1] ?? '';
  const output = $('#job-output'); const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
  output.textContent = job.output || '操作已开始，等待结果…'; if (wasAtBottom) output.scrollTop = output.scrollHeight;
  $('#job-state').textContent = running ? '正在执行 · 可收起此窗口' : job.state === 'succeeded' ? '操作成功' : `操作未完成 · 退出码 ${job.exitCode}`;
  $('#job-retry').hidden = job.state !== 'failed';
  $('#activity-button').hidden = false;
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = running; }); updateDraftUI(); paintStatus();
}
let jobPolling = false;
async function pollJob() {
  if (jobPolling) return; jobPolling = true;
  try {
    while (state.job?.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 1200));
      state.job = await api('/api/job?id=' + encodeURIComponent(state.job.id)); paintJob();
    }
    await refreshStatus();
    if ($('#job-panel').hidden && state.job) toast((actions[state.job.action]?.[0] ?? '操作') + (state.job.state === 'succeeded' ? '已完成。' : '未完成，点击右上角操作记录查看原因。'));
    if (state.job?.state === 'succeeded' && state.page === 'sessions') await renderPage();
  } catch (error) { showError('操作状态暂时无法获取：' + error.message + '。正在通过运行状态重新检查，请勿重复执行。'); }
  finally { jobPolling = false; }
}
async function runAction(action, conversationKey) {
  if (hasDraft() && !['reader-check', 'hook-check'].includes(action)) {
    toast('请先保存或放弃草稿，再执行操作。'); return;
  }
  const run = async () => {
    try {
      const body = { action, ...(conversationKey ? { conversationKey } : {}) };
      state.job = await api('/api/jobs', body); state.jobBody = body; $('#job-panel').hidden = false; paintJob(); pollJob();
    } catch (error) { showError(error.message); }
  };
  if (action === 'sessions-compact') return confirmAction('压缩这个聊天的上下文', '会调用当前模型生成摘要，可能消耗额度；会话仍保留，完成后继续在同一会话中聊天。', '开始压缩', run);
  if (['setup', 'hook-build', 'hook-pin', 'hook-unpin'].includes(action)) return confirmAction(actions[action][0], actions[action][1], actions[action][0], run);
  await run();
}
async function browse(button) {
  button.disabled = true;
  try { const result = await api('/api/browse', { kind: button.dataset.browse }); if (result.path) { const input = document.getElementById(button.dataset.target); input.value = result.path; input.dispatchEvent(new Event('input', { bubbles: true })); } }
  catch (error) { toast(error.message); } finally { button.disabled = false; }
}
async function saveReader() {
  const button = $('#save-reader'); button.disabled = true;
  try {
    await persistReader(); await refreshStatus(); updateDraftUI(); toast('读取设置已保存，重启服务后生效。');
    $('#reader-save-error').textContent = '';
  } catch (error) { $('#reader-save-error').textContent = error.message; } finally { button.disabled = false; }
}
async function persistReader() {
  if (!state.reader) throw new Error('读取设置尚未载入，请刷新页面。');
  await api('/api/reader-config', { revision: state.reader.revision, ...state.readerDraft });
  if ($('#reader-key')) $('#reader-key').value = '';
  state.reader = await api('/api/reader-config'); state.readerDraft = { dbPath: state.reader.dbPath, myWxid: state.reader.myWxid, decryptKey: '' };
  if (state.deployment) { state.deployment.configured = true; $('#setup-banner').hidden = true; }
}
async function load() {
  const info = await fetch('/api/info').then(response => response.json()); state.token = info.token; state.root = info.root;
  const [config, roles, chats, deployment] = await Promise.all([api('/api/config'), api('/api/roles'), api('/api/chats'), api('/api/deployment').catch(() => ({installed:false}))]);
  state.deployment = deployment;
  state.config = config.config; state.draft = structuredClone(config.config); state.revision = config.revision; state.roles = roles.roles;
  for (const chat of chats.chats) state.names.set(chat.key, chat.name);
  state.page = pages[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  if (deployment.installed) {
    $('#setup-nav').hidden = false; $('#setup-banner').hidden = deployment.configured;
    if (!location.hash && !deployment.configured) state.page = 'setup';
    actions.setup = ['检查内置依赖', '验证安装包内置的运行环境，无需安装系统 Python。'];
    $('.version').textContent = deployment.version + ' · 关闭窗口收起到托盘';
  }
  await renderPage(); await refreshStatus();
}
document.addEventListener('input', event => {
  const input = event.target;
  if (input.dataset.reader) { state.readerDraft[input.dataset.reader] = input.value; updateDraftUI(); return; }
  if (!input.dataset.path || !state.draft) return;
  let value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  if (input.dataset.transform === 'lines') value = input.value.split('\n').map(v => v.trim()).filter(Boolean);
  if (input.dataset.transform === 'seconds') value = Math.round(Number(input.value) * 1000);
  setPath(state.draft, input.dataset.path, value); updateDraftUI();
});
document.addEventListener('change', event => {
  if(event.target.dataset.stickerKey){const key=event.target.dataset.stickerKey;state.draft.wechat.stickers??={};state.draft.wechat.stickers.chats??={};if(event.target.value==='inherit')delete state.draft.wechat.stickers.chats[key];else state.draft.wechat.stickers.chats[key]=event.target.value==='on';updateDraftUI();return;}
  if (event.target.dataset.personaKey) {
    const key = event.target.dataset.personaKey;
    state.draft.persona.chats ??= {};
    if (event.target.value) state.draft.persona.chats[key] = event.target.value; else delete state.draft.persona.chats[key];
    updateDraftUI();
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-close')) return closeModal();
  if (button.dataset.action) return runAction(button.dataset.action, button.dataset.key);
  if (button.dataset.browse) return browse(button);
  if (button.dataset.mode) { state.draft.wechat.wake_mode = button.dataset.mode; const selector = state.page === 'overview' ? '#overview-mode' : '#behavior-mode'; $(selector).innerHTML = modeSelector(); updateDraftUI(); return; }
  if (button.dataset.kind) { state.chatKind = button.dataset.kind; renderPage(); return; }
  if (button.dataset.role) { state.selectedRole = button.dataset.role; renderPage(); return; }
  if (button.dataset.removeId) { state.draft.wechat.whitelist[state.chatKind] = state.draft.wechat.whitelist[state.chatKind].filter(id => String(id) !== button.dataset.removeId); const key = `wechat:${state.chatKind === 'groups' ? 'group' : 'private'}:${button.dataset.removeId}`; delete state.draft.persona.chats?.[key]; renderPage(); updateDraftUI(); return; }
  if (['add-chat', 'empty-add-chat'].includes(button.id)) return addChats();
  if (button.id === 'new-role') return newRole();
  if (button.id === 'set-default-role') { state.draft.persona.default = state.selectedRole; renderPage(); updateDraftUI(); return; }
  if (button.id === 'save-reader') return saveReader();
  if (button.id === 'copy-plugin-path') { window.desktop?.copyPluginPath().then(() => toast('插件路径已复制。')).catch(() => toast('复制失败，请打开插件目录。')); return; }
  if (button.id === 'open-plugin-folder') { window.desktop?.openPluginFolder().catch(() => toast('无法打开插件目录。')); return; }
  if (['retry-page', 'reload-log'].includes(button.id)) return renderPage();
  if (button.id === 'export-log') {
    if (window.desktop) { window.desktop.exportLog($('#log-view').textContent, state.logs?.file || 'wechatagent.log').then(result => { if (result.saved) toast('日志已保存。'); }).catch(() => toast('无法保存日志，请重试。')); return; }
    const blob = new Blob([$('#log-view').textContent], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = state.logs?.file || 'wechatagent.log'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  if (button.id === 'ack-dsh') {
    confirmAction('确认已完整重开 DSH', '请先在工具页准备配置，再从 DSH 托盘完全退出并重新打开。此确认会清除重开提示，不会替你退出 DSH。', '确认已重开', async () => { try { await api('/api/dsh-reopened', {}); await refreshStatus(); toast('已确认，请重启服务应用设置。'); } catch (error) { showError(error.message); } });
  }
});
$('#save-button').addEventListener('click', saveAll);
$('#discard-button').addEventListener('click', () => confirmAction('放弃未保存的更改', '已保存的设置和人格不会受影响。', '放弃更改', () => { state.draft = structuredClone(state.config); state.roleDrafts.clear(); state.readerDraft = null; renderPage(); updateDraftUI(); }));
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const bounds = $('#modal').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal(); } });
$('#job-close').addEventListener('click', () => { $('#job-panel').hidden = true; if (state.job?.state === 'running') toast('操作继续在后台执行，完成后可刷新查看结果。'); });
$('#activity-button').addEventListener('click', () => { if (state.job) { $('#job-panel').hidden = false; paintJob(); } });
$('#job-retry').addEventListener('click', () => { if (state.jobBody) runAction(state.jobBody.action, state.jobBody.conversationKey); else toast('请回到对应页面重新执行。'); });
$('#menu-button').addEventListener('click', () => { document.body.classList.toggle('nav-open'); $('#menu-button').setAttribute('aria-expanded', document.body.classList.contains('nav-open')); });
$('#quit-console').addEventListener('click', () => {
  if (hasDraft()) return toast('请先保存或放弃草稿，再退出控制台。');
  confirmAction(window.desktop ? '退出应用' : '退出控制台', window.desktop ? '退出 WeChatAgent 桌面应用，微信聊天服务继续运行。下次双击 WeChatAgent.exe 即可重新打开。' : '只关闭本机控制台，微信聊天服务继续运行。下次双击控制台入口即可重新打开。', window.desktop ? '退出应用' : '退出控制台', async () => {
    try { await api('/api/quit', {}); state.closed = true; $('#connection-label').innerHTML = '<i class="dot"></i>控制台已关闭'; $('#page-body').innerHTML = empty('控制台已关闭', '聊天服务继续运行。需要管理时，重新双击 WeChatAgent-Console.vbs。', '', 'power'); }
    catch (error) { showError(error.message); }
  });
});
if (window.desktop) {
  document.body.classList.add('desktop-mode');
  $('.brand span').textContent = '桌面应用';
  $('.breadcrumb > span:first-of-type').textContent = 'WeChatAgent';
  $('.version').textContent = '0.2.0 · 关闭窗口收起到托盘';
  $('#quit-console').textContent = '退出应用';
}
document.addEventListener('click', event => { if (document.body.classList.contains('nav-open') && !event.target.closest('.sidebar') && !event.target.closest('#menu-button')) document.body.classList.remove('nav-open'); });
window.addEventListener('hashchange', () => { state.page = pages[location.hash.slice(1)] ? location.hash.slice(1) : 'overview'; document.body.classList.remove('nav-open'); renderPage(); });
window.addEventListener('beforeunload', event => { if (hasDraft()) { event.preventDefault(); event.returnValue = ''; } });
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('#theme-button').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); $('#theme-button').setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题'); window.desktop?.setTheme(theme).catch(() => {}); }
let savedTheme; try { savedTheme = localStorage.getItem('wechatagent-console-theme'); } catch {}
applyTheme(window.desktop?.initialTheme ?? (savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#theme-button').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); try { localStorage.setItem('wechatagent-console-theme', theme); } catch {} });
$('#refresh-button').addEventListener('click', async () => {
  if (!state.config) { try { await load(); } catch (error) { showError(error.message); } return; }
  if (hasDraft()) { await refreshStatus(); toast('状态已刷新，未保存的草稿已保留。'); return; }
  try { const config = await api('/api/config'); state.config = config.config; state.draft = structuredClone(config.config); state.revision = config.revision; state.roles = (await api('/api/roles')).roles; state.reader = null; state.readerDraft = null; await renderPage(); await refreshStatus(); }
  catch (error) { showError(error.message); }
});
load().catch(error => { showError(error.message || '控制台未连接，请重新双击控制台入口。'); $('#page-body').innerHTML = empty('暂时无法打开控制台', '检查本机配置后点击右上角刷新，或重新双击控制台入口。', '', 'plug'); });
setInterval(() => { if (!document.hidden && state.token) refreshStatus(); }, 5000);
