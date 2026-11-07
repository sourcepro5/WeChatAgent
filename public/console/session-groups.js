export function createSessionGroupUI({
  api,
  modal,
  closeModal,
  escapeHtml: esc,
  icon,
  renderPage,
  toast,
  query = s => document.querySelector(s),
}) {
  let data = { available: false, groups: [], assignments: {} },
    sessions = [],
    keys = [],
    selected = 'all';
  const groupId = key =>
    sessions.find(item => item.conversationKey === key)?.groupId ?? data.assignments?.[key] ?? null;
  const options = current =>
    data.groups
      .map(
        group =>
          `<option value="${esc(group.id)}" ${group.id === current ? 'selected' : ''}>${esc(group.title)} · ${esc(group.path)}</option>`,
      )
      .join('');
  function prepare(value, items, allowed) {
    data = value;
    sessions = items;
    keys = [...allowed];
    if (!['all', 'unassigned', ...data.groups.map(group => group.id)].includes(selected)) selected = 'all';
  }
  function visible(key) {
    if (selected === 'all') return true;
    return selected === 'unassigned' ? !groupId(key) : groupId(key) === selected;
  }
  function toolbar() {
    if (!data.available)
      return `<section class="card session-groups"><h2>工作区分组</h2><p class="subtle">${esc(data.message ?? 'DSH 工作区服务暂不可用。请准备配置并从托盘完整退出、重开 DSH；原有会话仍可继续使用。')}</p></section>`;
    const active = data.groups.find(group => group.id === selected);
    const filters = [{ id: 'all', title: '全部会话' }, { id: 'unassigned', title: '未分组' }, ...data.groups];
    return `<section class="card session-groups"><div class="card-header"><div><h2>工作区分组</h2><p class="card-description">与 DSH 工作区同步，每个聊天保留独立上下文。</p></div><button class="button primary" data-session-group-new>${icon('plus')}新建分组</button></div><nav class="session-group-filters" aria-label="按工作区筛选会话">${filters.map(group => `<button class="session-group-filter" data-session-group-filter="${esc(group.id)}" aria-pressed="${selected === group.id}">${esc(group.title)}<span>${keys.filter(key => group.id === 'all' || (group.id === 'unassigned' && !groupId(key)) || groupId(key) === group.id).length}</span></button>`).join('')}</nav>${active ? `<div class="session-group-location"><div><span class="subtle">工作区目录</span><p>${esc(active.path)}</p></div><div class="button-row"><button class="button" data-session-group-rename="${esc(active.id)}">重命名</button><button class="button danger" data-session-group-delete="${esc(active.id)}" ${active.sessionIds.length || keys.some(key => groupId(key) === active.id) ? 'disabled title="请先移走此工作区内的所有 DSH 会话"' : ''}>移除空分组</button></div></div>` : ''}</section>`;
  }
  function control(key) {
    if (!data.available) return '';
    const group = data.groups.find(item => item.id === groupId(key));
    return `<div class="session-group-membership"><span>工作区：${esc(group?.title ?? '未分组')}</span><button class="button small" data-session-group-move="${esc(key)}">移动到分组</button></div>`;
  }
  function form(title, markup, onSave) {
    let saving = false;
    modal(
      title,
      `<form id="session-group-form">${markup}<p id="session-group-error" class="inline-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit" id="session-group-submit">保存</button></div></form>`,
      { beforeClose: () => !saving },
    );
    const element = query('#session-group-form');
    element.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      const button = query('#session-group-submit');
      button.disabled = true;
      button.textContent = '正在保存…';
      element.querySelectorAll('input,select,button').forEach(input => {
        input.disabled = true;
      });
      try {
        const result = await onSave();
        saving = false;
        closeModal();
        await renderPage();
        toast(result?.archivePending ? '会话已移动，原会话已保留；历史备份尚未归档。' : '已保存工作区分组。');
      } catch (error) {
        query('#session-group-error').textContent = error.message;
      } finally {
        saving = false;
        element.querySelectorAll('input,select,button').forEach(input => {
          input.disabled = false;
        });
        button.textContent = '保存';
      }
    });
    return element;
  }
  function create() {
    const revision = data.revision;
    const element = form(
      '新建工作区分组',
      `<p class="modal-description">为分组选择一个已有文件夹，分组会同步显示在 DSH。若目录已经是 DSH 工作区，将沿用原名称。</p><label class="field-label" for="session-group-title">分组名称</label><input id="session-group-title" required maxlength="60" placeholder="例如：日常聊天"><label class="field-label space-top" for="session-group-path">工作区目录</label><div class="session-group-path-picker"><input id="session-group-path" required placeholder="选择一个文件夹"><button class="button" type="button" id="session-group-browse">浏览…</button></div>`,
      () =>
        api('/api/session-groups/create', {
          title: query('#session-group-title').value.trim(),
          path: query('#session-group-path').value.trim(),
          revision,
        }),
    );
    element.querySelector('#session-group-browse').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api('/api/browse', { kind: 'workspace' });
        if (result.path && element.isConnected) query('#session-group-path').value = result.path;
      } catch (error) {
        const box = query('#session-group-error');
        if (box) box.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
  function move(key) {
    if (!data.groups.length) {
      toast('请先新建一个工作区分组。');
      return create();
    }
    const current = groupId(key),
      session = sessions.find(item => item.conversationKey === key);
    form(
      '移动会话到工作区分组',
      `<p class="modal-description">${esc(session?.title ?? key)}</p><label class="field-label" for="session-group-target">目标分组</label><select id="session-group-target" required>${options(current)}</select><div class="notice plain space-top">同目录整理沿用原会话。跨目录移动会在目标工作区建立继承完整历史的续接会话，原会话保留并归档。人格、技能与聊天范围保持现有设置。正在回复时请稍后重试。</div><label class="session-group-confirm"><input id="session-group-confirm" type="checkbox" required>我已了解跨目录移动时的历史保留方式</label>`,
      () =>
        api('/api/session-groups/move', {
          conversationKey: key,
          groupId: query('#session-group-target').value,
          expectedSessionId: session?.sessionId ?? null,
          confirmed: query('#session-group-confirm').checked,
        }),
    );
  }
  function rename(id) {
    const revision = data.revision,
      group = data.groups.find(item => item.id === id);
    if (!group) return;
    form(
      '重命名工作区分组',
      `<p class="modal-description">DSH 中对应工作区的名称也会更新。</p><label class="field-label" for="session-group-title">分组名称</label><input id="session-group-title" value="${esc(group.title)}" required maxlength="60">`,
      () =>
        api('/api/session-groups/rename', { groupId: id, title: query('#session-group-title').value.trim(), revision }),
    );
  }
  function remove(id) {
    const revision = data.revision,
      group = data.groups.find(item => item.id === id);
    if (!group || group.sessionIds.length || keys.some(key => groupId(key) === id)) return;
    form(
      '移除空分组',
      `<p class="modal-description">确认从 DSH 移除「${esc(group.title)}」的工作区登记？文件夹和历史文件会保留。</p>`,
      () => api('/api/session-groups/delete', { groupId: id, revision, confirmed: true }),
    );
  }
  function click(button) {
    if (button.dataset.sessionGroupFilter !== undefined) {
      selected = button.dataset.sessionGroupFilter;
      renderPage();
      return true;
    }
    if (button.hasAttribute('data-session-group-new')) {
      create();
      return true;
    }
    if (button.dataset.sessionGroupMove) {
      move(button.dataset.sessionGroupMove);
      return true;
    }
    if (button.dataset.sessionGroupRename) {
      rename(button.dataset.sessionGroupRename);
      return true;
    }
    if (button.dataset.sessionGroupDelete) {
      remove(button.dataset.sessionGroupDelete);
      return true;
    }
    return false;
  }
  return {
    prepare,
    visible,
    toolbar,
    control,
    click,
    isAvailable: () => data.available === true,
    unavailableMessage: () => data.message ?? '',
  };
}
