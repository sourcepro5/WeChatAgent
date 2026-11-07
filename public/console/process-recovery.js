const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const needsWeChatRepair = output =>
  /HOOK_CLIENT_UNHEALTHY|HOOK_INITIALIZATION_TIMEOUT|HOOK_NOT_LISTENING|HOOK_COMPONENT_UPDATE_PENDING|HOOK_AUTH_FAILED|HOOK_CONNECTION_RESET|HOOK_HEALTH_FAILED|HOOK_MULTIPLE_ACCOUNT_DATABASES|HOOK_ACCOUNT_METADATA_INVALID|HOOK_ACCOUNT_MISMATCH/.test(
    String(output ?? ''),
  );
const detail = item =>
  `<strong>${escape(item.name)} <span class="subtle">PID ${Number(item.pid)}</span></strong><span>${escape(item.reason)}</span><code>${escape(item.path || '无法确认程序路径')}</code>`;

export async function openProcessRecovery({ api, modal, refreshStatus, toast, repairWeChat = false, onRecovered }) {
  let active = true,
    busy = false,
    checking = false,
    scan;
  modal(
    '检查占用进程',
    '<p class="modal-description" role="status">正在检查配置端口和微信进程，此步骤不会停止程序…</p>',
    {
      className: 'process-recovery-modal',
      onClose: () => {
        active = false;
      },
      beforeClose: () => !busy,
    },
  );
  const body = document.querySelector('#modal-content');
  const title = text => {
    document.querySelector('#modal-title').textContent = text;
  };
  const error = message => {
    const element = body.querySelector('[data-recovery-error]');
    if (element) element.textContent = message;
  };
  const showList = async () => {
    if (checking) return;
    checking = true;
    body.querySelectorAll('button').forEach(button => {
      button.disabled = true;
    });
    try {
      scan = await api('/api/process-recovery' + (repairWeChat ? '?purpose=hook-repair' : ''));
      if (!active) return;
      if (repairWeChat && scan.purpose !== 'hook-repair')
        throw Error('当前后台尚未加载修复功能，请从托盘退出并重新打开 WeChatAgent，再重试。');
      title('选择需要停止的进程');
      body.innerHTML = `<p class="modal-description">${repairWeChat ? '将重新打开配置中的匹配微信，可能需要重新登录。仅列出该客户端的进程；请核对路径，停止前还需要再次确认。' : '只列出异常端口的占用者和其他微信客户端。先核对程序名称、路径与 PID；选中后还需要再次确认。'}</p><div class="process-list">${scan.items.length ? scan.items.map(item => `<label class="process-row"><input type="checkbox" value="${escape(item.id)}" ${item.canStop ? (repairWeChat ? 'checked' : '') : 'disabled'} aria-label="选择 ${escape(item.name)}，PID ${Number(item.pid)}"><div>${detail(item)}${item.canStop ? '' : `<span class="inline-error">${escape(item.blockedReason)}</span>`}</div></label>`).join('') : `<p class="modal-description">${repairWeChat ? '匹配微信尚未运行，可以直接打开。' : '未发现可处理的占用进程。端口也可能被 Windows 保留或拒绝绑定，请在连接设置中修改该端口，或查看原始错误详情。'}</p>`}</div><p class="inline-error" data-recovery-error role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button" data-recovery-rescan>重新检查</button>${repairWeChat && !scan.items.length ? '<button class="button primary" data-recovery-open>打开匹配微信</button>' : '<button class="button danger" data-recovery-prepare disabled>停止选中进程…</button>'}</div>`;
      body.querySelector('[data-recovery-rescan]').onclick = showList;
      const next = body.querySelector('[data-recovery-prepare]');
      if (!next) {
        body.querySelector('[data-recovery-open]')?.addEventListener('click', () => onRecovered?.());
        return;
      }
      next.disabled = !body.querySelector('input[type=checkbox]:checked');
      body.querySelectorAll('input[type=checkbox]').forEach(
        input =>
          (input.onchange = () => {
            next.disabled = !body.querySelector('input[type=checkbox]:checked');
          }),
      );
      next.onclick = async () => {
        next.disabled = true;
        error('');
        try {
          const ids = [...body.querySelectorAll('input[type=checkbox]:checked')].map(input => input.value);
          const prepared = await api('/api/process-recovery/prepare', { scanId: scan.scanId, ids });
          if (!active) return;
          showConfirmation(prepared);
        } catch (failure) {
          if (active) {
            error(failure.message);
            next.disabled = false;
          }
        }
      };
    } catch (failure) {
      if (active) {
        body.innerHTML = `<p class="inline-error" role="alert">${escape(failure.message)}</p><div class="modal-actions"><button class="button" data-close>关闭</button><button class="button" data-recovery-rescan>重新检查</button></div>`;
        body.querySelector('[data-recovery-rescan]')?.addEventListener('click', showList);
      }
    } finally {
      checking = false;
    }
  };
  const showConfirmation = prepared => {
    title(repairWeChat ? '再次确认重开匹配微信' : '再次确认停止进程');
    body.innerHTML = `<p class="modal-description">将停止以下 ${prepared.items.length} 个进程，可能中断对应程序的连接和未完成操作。请先保存需要保留的内容；停止微信后可能需要重新登录。</p><div class="process-list">${prepared.items.map(item => `<div class="process-row"><div>${detail(item)}</div></div>`).join('')}</div><p class="inline-error" data-recovery-error role="alert"></p><div class="modal-actions"><button class="button" data-recovery-back autofocus>返回选择</button><button class="button danger" data-recovery-stop>确认停止 ${prepared.items.length} 个进程</button></div>`;
    body.querySelector('[data-recovery-back]').onclick = showList;
    body.querySelector('[data-recovery-back]').focus();
    body.querySelector('[data-recovery-stop]').onclick = async () => {
      if (busy) return;
      busy = true;
      body.querySelectorAll('button').forEach(button => {
        button.disabled = true;
      });
      error('');
      try {
        const result = await api('/api/process-recovery/stop', {
          confirmation: prepared.confirmation,
          confirmed: true,
        });
        if (!active) return;
        if (repairWeChat) {
          busy = false;
          await onRecovered?.();
          return;
        }
        title('进程处理完成');
        body.innerHTML = `<p class="modal-description" role="status">已停止 ${result.stopped.length} 个进程。请重新打开所需程序，再重试原操作。</p><div class="modal-actions"><button class="button" data-recovery-rescan>重新检查</button><button class="button primary" data-close>完成</button></div>`;
        body.querySelector('[data-recovery-rescan]').onclick = showList;
        toast('进程已停止，可以重新配置或重试。');
        await refreshStatus();
      } catch (failure) {
        if (active) {
          error(failure.message);
          body.querySelector('[data-recovery-back]').disabled = false;
        }
      } finally {
        busy = false;
      }
    };
  };
  await showList();
}
