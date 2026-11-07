import { personaReferences } from './persona-files.mjs';

export function createPersonaDeletion({
  state,
  roleSaves,
  api,
  modal,
  closeModal,
  escapeHtml,
  renderPage,
  updateDraftUI,
  toast,
  query = selector => document.querySelector(selector),
}) {
  return function deletePersona() {
    const role = state.roles.find(item => item.name === state.selectedRole);
    if (!role) return;
    if (state.savingAll || roleSaves.size || state.deletingRole || state.job?.state === 'running')
      return toast('有操作正在进行，请完成后再删除。');
    const references = [state.config?.persona, state.draft?.persona].map(persona =>
      personaReferences(persona, role.name),
    );
    if (references.some(item => item.default))
      return toast('此人格是已保存或草稿中的默认人格，请先切换默认人格并保存设置。');
    if (references.some(item => item.chats.length))
      return toast('有聊天正在使用此人格，请先在聊天范围切换人格并保存设置。');
    let deleting = false;
    const draftNotice = state.roleDrafts.has(role.name) ? '此卡片未保存的编辑也会丢弃。' : '';
    modal(
      '删除人格',
      `<p class="modal-description">确定删除「${escapeHtml(role.name)}」？原文件会自动备份。${draftNotice}</p><div id="role-delete-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button danger" id="confirm-role-delete">确认删除</button></div>`,
      { beforeClose: () => !deleting },
    );
    query('#confirm-role-delete').addEventListener('click', async () => {
      if (deleting) return;
      deleting = true;
      state.deletingRole = role.name;
      const button = query('#confirm-role-delete');
      button.disabled = true;
      button.textContent = '正在删除…';
      updateDraftUI();
      try {
        await api('/api/roles/delete', { name: role.name, revision: role.revision, confirmed: true });
        const index = state.roles.indexOf(role);
        state.roles = state.roles.filter(item => item !== role);
        state.roleDrafts.delete(role.name);
        if (state.selectedRole === role.name)
          state.selectedRole = state.roles[Math.min(Math.max(index, 0), state.roles.length - 1)]?.name ?? '';
        deleting = false;
        closeModal();
        await renderPage();
        toast('人格已删除，原文件已备份。');
      } catch (error) {
        const box = query('#role-delete-error');
        if (box) box.textContent = error.message;
        else toast(error.message);
      } finally {
        deleting = false;
        state.deletingRole = null;
        button.disabled = false;
        button.textContent = '确认删除';
        updateDraftUI();
      }
    });
  };
}
