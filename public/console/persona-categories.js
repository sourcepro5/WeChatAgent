export function createPersonaCategoryUI({
  state,
  api,
  modal,
  closeModal,
  escapeHtml: esc,
  renderPage,
  toast,
  query = selector => document.querySelector(selector),
}) {
  let data = { categories: [], assignments: {}, revision: '' },
    selected = 'all';
  const category = name => (Object.hasOwn(data.assignments, name) ? data.assignments[name] : '');
  function setData(value) {
    data = value ?? { categories: [], assignments: {}, revision: '' };
    if (selected !== 'all' && selected !== '' && !data.categories.some(item => item.id === selected)) selected = 'all';
  }
  const visible = () => state.roles.filter(role => selected === 'all' || category(role.name) === selected);
  function reveal(name) {
    if (selected !== 'all' && category(name) !== selected) selected = category(name);
  }
  function toolbar() {
    if (data.error) return `<div class="notice" role="alert">${esc(data.error)} 人格内容仍可正常编辑。</div>`;
    const filters = [{ id: 'all', title: '全部' }, { id: '', title: '未分类' }, ...data.categories];
    return `<div class="persona-category-toolbar"><div class="persona-category-filters" role="group" aria-label="按人格分类筛选">${filters.map(item => `<button class="button small ${selected === item.id ? 'category-selected' : ''}" data-persona-category-filter="${esc(item.id)}" aria-pressed="${selected === item.id}"><span>${esc(item.title)}</span><span class="persona-category-count">${item.id === 'all' ? state.roles.length : state.roles.filter(role => category(role.name) === item.id).length}</span></button>`).join('')}</div><div class="button-row"><button class="button small" data-persona-category-new>新建分类</button><button class="button small" data-persona-category-manage ${data.categories.length ? '' : 'disabled'}>管理分类</button></div></div>`;
  }
  function control(name) {
    if (data.error) return '';
    const label = data.categories.find(item => item.id === category(name))?.title ?? '未分类';
    return `<div class="persona-category-control"><span class="subtle">分类：${esc(label)}</span><button class="button small" data-persona-category-move="${esc(name)}">移动分类</button></div>`;
  }
  function form(title, html, operation, { label = '保存', success = '人格分类已保存。' } = {}) {
    let saving = false;
    modal(
      title,
      `<form id="persona-category-form">${html}<div id="persona-category-error" class="inline-error" role="alert"></div><div class="modal-actions"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary" id="persona-category-submit">${label}</button></div></form>`,
      { beforeClose: () => !saving },
    );
    const element = query('#persona-category-form'),
      button = query('#persona-category-submit');
    element.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      const body = operation();
      saving = true;
      button.disabled = true;
      button.textContent = '正在保存…';
      query('#persona-category-error').textContent = '';
      try {
        setData(await api('/api/persona-categories', { ...body, revision: data.revision }));
        if (body.action === 'assign') reveal(body.name);
        saving = false;
        closeModal();
        await renderPage();
        toast(success);
      } catch (error) {
        if (error.status === 409) {
          try {
            setData(await api('/api/persona-categories'));
          } catch {}
        }
        query('#persona-category-error').textContent = error.message;
      } finally {
        saving = false;
        button.disabled = false;
        button.textContent = label;
      }
    });
    query('#persona-category-title')?.focus();
  }
  function create() {
    form(
      '新建人格分类',
      '<label class="field-label" for="persona-category-title">分类名称</label><input id="persona-category-title" required maxlength="60" placeholder="例如：日常聊天、创作角色">',
      () => ({ action: 'create', title: query('#persona-category-title').value.trim() }),
    );
  }
  function manage() {
    modal(
      '管理人格分类',
      `<p class="modal-description">删除分类后，其中的人格会移入“未分类”，卡片内容和聊天绑定均保留。</p><div class="persona-category-manager">${data.categories.map(group => `<div class="persona-category-row"><strong>${esc(group.title)}</strong><div class="button-row"><button class="button small" data-persona-category-rename="${group.id}">重命名</button><button class="button small danger" data-persona-category-delete="${group.id}">删除分类</button></div></div>`).join('')}</div>`,
    );
  }
  function rename(id) {
    const group = data.categories.find(item => item.id === id);
    if (!group) return;
    form(
      '重命名人格分类',
      `<label class="field-label" for="persona-category-title">分类名称</label><input id="persona-category-title" required maxlength="60" value="${esc(group.title)}">`,
      () => ({ action: 'rename', categoryId: id, title: query('#persona-category-title').value.trim() }),
    );
  }
  function remove(id) {
    const group = data.categories.find(item => item.id === id);
    if (!group) return;
    form(
      '删除人格分类',
      `<p class="modal-description">确认删除“${esc(group.title)}”？其中的 ${state.roles.filter(role => category(role.name) === id).length} 个人格将移入“未分类”。人格内容、默认人格和聊天绑定会保留。</p>`,
      () => ({ action: 'delete', categoryId: id, confirmed: true }),
      { label: '删除分类', success: '分类已删除，人格已保留。' },
    );
  }
  function move(name) {
    if (!data.categories.length) {
      toast('请先新建一个人格分类。');
      create();
      return;
    }
    const current = category(name);
    form(
      '移动人格分类',
      `<p class="modal-description">${esc(name)}</p><label class="field-label" for="persona-category-target">目标分类</label><select id="persona-category-target"><option value="">未分类</option>${data.categories.map(group => `<option value="${group.id}" ${group.id === current ? 'selected' : ''}>${esc(group.title)}</option>`).join('')}</select><p class="subtle space-top">分类立即保存，编辑中的人格内容和其他草稿会保留。</p>`,
      () => ({ action: 'assign', name, categoryId: query('#persona-category-target').value }),
    );
  }
  function click(button) {
    if (button.dataset.personaCategoryFilter !== undefined) {
      selected = button.dataset.personaCategoryFilter;
      renderPage();
      return true;
    }
    if (button.hasAttribute('data-persona-category-new')) {
      create();
      return true;
    }
    if (button.hasAttribute('data-persona-category-manage')) {
      manage();
      return true;
    }
    if (button.dataset.personaCategoryRename) {
      rename(button.dataset.personaCategoryRename);
      return true;
    }
    if (button.dataset.personaCategoryDelete) {
      remove(button.dataset.personaCategoryDelete);
      return true;
    }
    if (button.dataset.personaCategoryMove) {
      move(button.dataset.personaCategoryMove);
      return true;
    }
    return false;
  }
  return { setData, visible, reveal, toolbar, control, click };
}
