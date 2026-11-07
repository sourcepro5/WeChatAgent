export function createAssistantFeedbackUI({ api, modal, closeModal, escapeHtml: esc, icon, toast }) {
  let active = null;
  const card = () =>
    `<section class="card"><div class="card-header"><div><h2>助手任务反馈</h2><p class="card-description">AI 即兴反馈配合长任务定时提醒；等待期间也会反馈，必要时增加一次小型文案请求。</p></div><button type="button" class="button" data-feedback-edit>${icon('sliders')}管理语录</button></div><p class="subtle">可选择 AI 即兴、自定义语录、普通或关闭，调整间隔与每任务上限。AI 反馈沿用当前人格，普通闲聊不播报；审批与提问会完整提醒。</p></section>`;
  async function open() {
    const session = { saving: false, replacing: false };
    active = session;
    modal('助手任务反馈', '<div class="loading-state" role="status">正在读取语录库…</div>', {
      onClose: () => {
        if (active === session && !session.replacing) active = null;
      },
    });
    let saved;
    try {
      saved = await api('/api/assistant-feedback');
    } catch (error) {
      if (active === session) modal('助手任务反馈', `<p class="inline-error" role="alert">${esc(error.message)}</p>`);
      return;
    }
    if (active !== session) return;
    let draft = structuredClone(saved.settings),
      stage = saved.stages[0].id,
      form;
    const body = `<form id="feedback-form"><div class="conversation-scroll"><p class="modal-description">AI 即兴根据任务生成公开进度，不照搬本地语录。下方语录库仅用于“自定义语录”档位，内容不会作为模型指令；最终结果单独发送。</p><div class="form-grid"><div class="field full"><label for="feedback-mode">反馈档位</label><select id="feedback-mode"><option value="off">关闭进度播报</option><option value="basic">普通：只显示真实状态</option><option value="playful">AI 即兴：根据任务俏皮反馈</option><option value="quotes">自定义语录：从下方文案库选择</option></select><small>AI 即兴与自定义语录隐藏任务编号、排队与工具明细；执行较久但没有公开输出时会定时反馈；文案服务无响应时显示真实耗时。审批、提问与错误保留必要详情。</small></div><div class="field"><label for="feedback-interval">常规反馈间隔 / 秒</label><input id="feedback-interval" type="number" required min="15" max="120" step="1"><small>15–120 秒；审批、提问及最终状态不受间隔限制。</small></div><div class="field"><label for="feedback-limit">每任务最多播报 / 条</label><input id="feedback-limit" type="number" required min="1" max="5" step="1"><small>1–5 条；AI 输出与等待提醒共用上限；排队时不播报，不固定发送接单或完成语；不含审批与提问。</small></div></div><hr><div class="field"><label for="feedback-stage">任务阶段</label><select id="feedback-stage">${saved.stages.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><small id="feedback-stage-help"></small></div><div class="field"><label for="feedback-lines">本阶段语录（每行一句）</label><textarea id="feedback-lines" rows="7" placeholder="输入你希望助手说的话，每行一句"></textarea><small id="feedback-count" role="status"></small><small>可直接添加、修改或删除任意一行。每阶段最多 30 条，每条最多 160 字；自定义语录档位留空时显示简短阶段名称；AI 即兴不使用此文案库。失败时保留错误详情。</small></div><div class="button-row"><button type="button" class="button small" id="feedback-add">添加语录</button><button type="button" class="button small" id="feedback-defaults">恢复本阶段默认语录</button></div><div class="notice plain space-top"><span id="feedback-preview" style="white-space:pre-wrap;overflow-wrap:anywhere"></span></div><p id="feedback-error" class="inline-error" role="alert" hidden></p><div id="feedback-discard" class="notice space-top" hidden><span>语录有未保存的修改。</span><button type="button" class="button small" id="feedback-continue">继续编辑</button><button type="button" class="button small" id="feedback-discard-confirm">放弃修改</button></div></div><div class="conversation-footer"><div class="modal-actions"><span style="margin-right:auto" id="feedback-save-state" class="subtle" role="status">没有未保存的修改</span><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary" id="feedback-save" disabled>保存语录</button></div></div></form>`;
    const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved.settings);
    session.replacing = true;
    modal('助手任务反馈', body, {
      className: 'conversation-modal',
      beforeClose: () => {
        if (session.saving) return false;
        if (dirty()) {
          form.querySelector('#feedback-discard').hidden = false;
          return false;
        }
        return true;
      },
      onClose: () => {
        if (active === session) active = null;
      },
    });
    session.replacing = false;
    form = document.querySelector('#feedback-form');
    const q = selector => form.querySelector(selector),
      lines = () =>
        q('#feedback-lines')
          .value.split(/\r?\n/)
          .map(text => text.trim())
          .filter(Boolean);
    const textValid = () => {
      const value = lines();
      return value.length <= 30 && value.every(text => text.length <= 160 && !/[\x00-\x1f\x7f]/.test(text));
    };
    function capture() {
      draft.mode = q('#feedback-mode').value;
      draft.intervalSeconds = Number(q('#feedback-interval').value);
      draft.maxUpdates = Number(q('#feedback-limit').value);
      draft.phrases[stage] = [...new Set(lines())];
    }
    function paint() {
      q('#feedback-count').textContent = lines().length + ' / 30 条';
      const preview = lines()[0];
      q('#feedback-preview').textContent =
        draft.mode === 'off'
          ? '示例：不发送常规进度，仍会提醒审批与提问。'
          : draft.mode === 'basic'
            ? '示例：任务 T… · 执行中，真实状态由任务系统提供。'
            : draft.mode === 'playful'
              ? 'AI 即兴：沿用当前人格生成简短反馈；执行较久而没有公开输出时也会定时提醒，不读取思考链。'
              : '语录预览：\n🐟 ' +
                (preview || saved.stages.find(item => item.id === stage).name) +
                (stage === 'failed' ? '\n（实际发送时会附上具体错误）' : '');
      q('#feedback-save').disabled = session.saving || !dirty() || !textValid();
      q('#feedback-save').textContent = session.saving ? '正在保存…' : '保存语录';
      q('#feedback-save-state').textContent = session.saving
        ? '正在保存'
        : dirty()
          ? '有未保存的修改'
          : '没有未保存的修改';
      q('#feedback-lines').setCustomValidity(textValid() ? '' : '最多 30 条，每条 1–160 字，不含控制字符。');
    }
    function showStage() {
      q('#feedback-lines').value = draft.phrases[stage].join('\n');
      q('#feedback-stage-help').textContent = saved.stages.find(item => item.id === stage).description;
      paint();
    }
    q('#feedback-mode').value = draft.mode;
    q('#feedback-interval').value = draft.intervalSeconds;
    q('#feedback-limit').value = draft.maxUpdates;
    showStage();
    form.addEventListener('input', () => {
      capture();
      q('#feedback-discard').hidden = true;
      paint();
    });
    q('#feedback-stage').addEventListener('change', event => {
      stage = event.target.value;
      showStage();
    });
    q('#feedback-mode').addEventListener('change', () => {
      capture();
      paint();
    });
    q('#feedback-add').addEventListener('click', () => {
      const field = q('#feedback-lines');
      field.value = field.value.replace(/\s+$/, '') + (field.value.trim() ? '\n' : '');
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      toast('在新的一行输入语录即可。');
    });
    q('#feedback-defaults').addEventListener('click', () => {
      draft.phrases[stage] = [...saved.defaults.phrases[stage]];
      showStage();
    });
    q('#feedback-continue').addEventListener('click', () => {
      q('#feedback-discard').hidden = true;
      q('#feedback-lines').focus();
    });
    q('#feedback-discard-confirm').addEventListener('click', () => closeModal({ force: true }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      capture();
      if (session.saving || !dirty() || !form.reportValidity()) return;
      session.saving = true;
      q('#feedback-error').hidden = true;
      paint();
      for (const input of form.querySelectorAll('input,select,textarea,button')) input.disabled = true;
      try {
        await api('/api/assistant-feedback', { revision: saved.revision, settings: draft });
        if (active !== session) return;
        active = null;
        closeModal({ force: true });
        toast('反馈设置已保存，后续任务使用新设置，无需重启。');
      } catch (error) {
        if (active === session) {
          q('#feedback-error').textContent = error.message;
          q('#feedback-error').hidden = false;
        }
      } finally {
        session.saving = false;
        if (active === session) {
          for (const input of form.querySelectorAll('input,select,textarea,button')) input.disabled = false;
          paint();
        }
      }
    });
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-feedback-edit]')) void open().catch(error => toast(error.message));
  });
  return { card };
}
