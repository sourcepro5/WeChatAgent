export function createMemoryUI({
  api,
  state,
  escapeHtml: esc,
  icon,
  renderPage,
  toast,
}) {
  let overview,
    selected = '',
    query = '',
    status = 'all',
    source = 'all',
    offset = 0,
    section = '',
    sequence = 0,
    rows = [];
  const date = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录');
  const mode = value =>
    ({ assistant: '助手任务', 'assistant-chat': '助手群聊', social: '聊天模式' })[value] ?? '聊天模式';
  const name = chat =>
    state.names.get(chat.key) || (chat.kind === 'groups' ? '群聊' : '好友') + ' · ' + chat.id.slice(-4);
  const pagination = data =>
    data.total > 24
      ? `<div class="memory-pagination"><span>第 ${Math.floor(offset / 24) + 1} / ${Math.ceil(data.total / 24)} 页 · ${data.total} 条</span><div class="button-row"><button class="button" data-memory-page="-1" ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="button" data-memory-page="1" ${offset + 24 >= data.total ? 'disabled' : ''}>下一页</button></div></div>`
      : '';
  const tags = member =>
    member.tags.length
      ? member.tags
          .map(
            tag =>
              `<span class="memory-tag ${tag.status === 'tentative' ? 'tentative' : ''}">${esc(tag.label)}<small>${tag.status === 'tentative' ? '待观察' : '多次观察'} · ${tag.evidenceCount} 条证据</small></span>`,
          )
          .join('')
      : '<p class="subtle">尚未形成互动标签</p>';
  function memberCard(member) {
    return `<article class="memory-member"><div class="memory-person"><span class="avatar">${esc((member.names[0] ?? '群').slice(0, 1))}</span><div><h2>${esc(member.names[0] || '未记录昵称')}</h2><p class="subtle">最近互动 ${date(member.lastSeenAt)}</p></div></div><div class="memory-tags">${tags(member)}</div><details class="memory-identity"><summary>成员身份与记录</summary><dl><div><dt>聊天成员 ID</dt><dd class="mono">${esc(member.senderId || '未记录')}</dd></div><div><dt>稳定标识</dt><dd class="mono">${esc(member.memberId)}</dd></div><div><dt>历史昵称</dt><dd>${esc(member.names.join('、') || '未记录')}</dd></div><div><dt>首次记录</dt><dd>${date(member.firstSeenAt)}</dd></div></dl></details></article>`;
  }
  function summaryCard(row, index) {
    return `<article class="memory-timeline-item"><div class="memory-time"><time>${date(row.at)}</time><span>${row.source === 'native' ? 'DSH 原生压缩' : '本地历史摘要'}</span></div><details class="memory-summary" ${index === 0 ? 'open' : ''}><summary><span><strong>${esc(row.source === 'native' ? '会话压缩摘要' : '聊天历史摘要')}</strong><small>${mode(row.mode)} · ${Number(row.characters ?? row.text.length).toLocaleString()} 字符${row.coveredTokens != null ? ' · 覆盖 ' + Number(row.coveredTokens).toLocaleString() + ' token' : ''}</small></span>${icon('arrow')}</summary><div class="memory-summary-body"><pre>${esc(row.text)}</pre>${row.truncated ? '<p class="scope-note">内容较长，此处展示前 60,000 字符。</p>' : ''}<div class="memory-summary-footer"><span class="mono">${esc(row.id)}</span><button class="button small" data-memory-copy="${index}">复制摘要</button></div></div></details></article>`;
  }
  async function page() {
    const request = ++sequence,
      nextSection = state.memorySection ?? 'members';
    if (section !== nextSection) {
      section = nextSection;
      offset = 0;
      selected = '';
    }
    const tabs = `<nav class="workspace-tabs" aria-label="记忆分类"><a href="#memory/members" ${section === 'members' ? 'aria-current="page"' : ''}>群友记忆</a><a href="#memory/summaries" ${section === 'summaries' ? 'aria-current="page"' : ''}>压缩记忆</a></nav>`;
    overview = await api('/api/memory');
    if (!overview.available)
      return (
        tabs +
        `<section class="card"><div class="empty-state"><h2>先连接微信账号</h2><p>${esc(overview.message ?? '连接后可查看该账号的记忆。')}</p><a class="button" href="#settings/connections">前往连接设置</a></div></section>`
      );
    const chats = overview.chats.filter(chat => section !== 'members' || chat.kind === 'groups');
    if (!chats.some(chat => chat.key === selected)) selected = chats[0]?.key ?? '';
    if (!selected)
      return (
        tabs +
        `<section class="card"><div class="empty-state"><h2>${section === 'members' ? '还没有允许的群聊' : '还没有允许的聊天'}</h2><p>先在聊天中添加允许范围，再回来查看已保存的记忆。</p><a class="button" href="#chats">管理聊天</a></div></section>`
      );
    const common =
      '?scope=' +
      encodeURIComponent(overview.accountScope) +
      '&conversationKey=' +
      encodeURIComponent(selected) +
      '&offset=' +
      offset;
    let data,
      error = '';
    try {
      data = await api(
        '/api/memory/' +
          (section === 'members' ? 'members' : 'summaries') +
          common +
          (section === 'members' ? '&query=' + encodeURIComponent(query) + '&status=' + status : '&source=' + source),
      );
    } catch (e) {
      error = e.message;
    }
    if (request !== sequence) return '';
    rows = data?.summaries ?? [];
    const selector = `<section class="card memory-controls"><form id="memory-filter-form"><div class="field"><label for="memory-chat">${section === 'members' ? '选择群聊' : '选择会话'}</label><select id="memory-chat">${chats.map(chat => `<option value="${esc(chat.key)}" ${chat.key === selected ? 'selected' : ''}>${esc(name(chat))} · ${esc(chat.id)}</option>`).join('')}</select></div>${
      section === 'members'
        ? `<div class="field"><label for="memory-query">查找群友</label><input id="memory-query" type="search" maxlength="80" placeholder="昵称、成员 ID 或标签" value="${esc(query)}"></div><div class="field"><label for="memory-status">标签状态</label><select id="memory-status">${[
            ['all', '全部群友'],
            ['observed', '多次观察'],
            ['tentative', '待观察'],
            ['untagged', '尚无标签'],
          ]
            .map(([id, label]) => `<option value="${id}" ${status === id ? 'selected' : ''}>${label}</option>`)
            .join('')}</select></div>`
        : `<div class="field"><label for="memory-source">摘要来源</label><select id="memory-source">${[
            ['all', '全部来源'],
            ['history', '本地历史摘要'],
            ['native', 'DSH 原生压缩'],
          ]
            .map(([id, label]) => `<option value="${id}" ${source === id ? 'selected' : ''}>${label}</option>`)
            .join('')}</select></div>`
    }<button class="button" type="button" data-memory-refresh>${icon('refresh')}刷新</button></form></section>`;
    let body;
    if (error)
      body = `<section class="card" role="alert"><h2>记忆暂时无法读取</h2><p>${esc(error)}</p><button class="button" data-memory-refresh>重新读取</button></section>`;
    else if (section === 'members')
      body = `<div class="memory-stat-strip" aria-label="此群的记忆统计"><p><strong>${data.stats.members}</strong> 已记录群友</p><p><strong>${data.stats.tags}</strong> 互动标签</p><p><strong>${data.stats.tentative}</strong> 待观察标签</p><span>${data.enabled ? '正在记录此群' : '此群记录已暂停，已有记忆保留'}</span></div><p class="scope-note">${icon('info')}标签来自有限互动，仅作接话参考；少于 3 条独立证据为待观察，90 天前的证据不再计入。同名群友按稳定标识区分。</p><div class="memory-member-grid">${data.members.map(memberCard).join('') || `<section class="card empty-state"><h2>${query || status !== 'all' ? '没有匹配的群友' : '此群尚无群友记忆'}</h2><p>${query || status !== 'all' ? '试试其他昵称、成员 ID 或标签状态。' : '开启群友记忆后，在已允许的群聊中交流，记录会自动出现在这里。'}</p></section>`}</div>${pagination(data)}`;
    else
      body = `<div class="memory-stat-strip"><p><strong>${data.historyTotal}</strong> 本地历史摘要</p><span>${source === 'history' ? '当前仅查看本地历史摘要' : data.nativeStatus === 'saved' ? '正在查看已保存的 DSH 原生摘要' : data.nativeAvailable ? 'DSH 原生摘要已连接' : 'DSH 原生摘要暂不可用，可继续查看本地历史摘要'}</span></div><p class="scope-note">${icon('info')}本地历史摘要供历史检索使用；DSH 原生摘要用于会话上下文压缩。摘要可能遗漏细节，查看不会重新生成摘要。</p>${data.historyError ? `<p class="inline-error" role="alert">${esc(data.historyError)}</p>` : ''}<div class="memory-timeline">${rows.map(summaryCard).join('') || '<section class="card empty-state"><h2>此来源尚无可查看的压缩记忆</h2><p>完成历史摘要或 DSH 压缩后刷新；连接已加载该会话的 DSH 可读取最新摘要。</p></section>'}</div>${pagination(data)}<p class="subtle">展示最近 200 份本地历史摘要与最近 50 份已保存或已加载会话的 DSH 原生摘要。${data.historyLimited ? '更早的本地摘要仍保存在数据库中。' : ''}</p>`;
    return tabs + `<div class="section-stack memory-page">${selector}${body}</div>`;
  }
  function mount() {
    const form = document.getElementById('memory-filter-form');
    if (!form) return;
    const update = () => {
      selected = document.getElementById('memory-chat').value;
      query = document.getElementById('memory-query')?.value ?? query;
      status = document.getElementById('memory-status')?.value ?? status;
      source = document.getElementById('memory-source')?.value ?? source;
      offset = 0;
      const refocus = document.activeElement?.id === 'memory-query',
        caret = document.activeElement?.selectionStart ?? 0;
      void renderPage().then(() => {
        if (!refocus) return;
        const input = document.getElementById('memory-query');
        input?.focus();
        input?.setSelectionRange(caret, caret);
      });
    };
    form.onsubmit = event => {
      event.preventDefault();
      update();
    };
    for (const id of ['memory-chat', 'memory-status', 'memory-source'])
      document.getElementById(id)?.addEventListener('change', update);
    // 搜索框停止输入 300ms 后自动查询（服务器端搜索，避免每个字符都请求一次）
    let queryTimer = 0;
    document.getElementById('memory-query')?.addEventListener('input', () => {
      clearTimeout(queryTimer);
      queryTimer = setTimeout(update, 300);
    });
  }
  function click(button) {
    if (button.dataset.memoryOpen) {
      selected = button.dataset.memoryOpen;
      section = button.dataset.memorySection === 'members' ? 'members' : 'summaries';
      state.memorySection = section;
      offset = 0;
      const hash = '#memory/' + section;
      if (location.hash === hash) void renderPage();
      else location.hash = hash;
      return true;
    }
    if (button.hasAttribute('data-memory-refresh')) {
      void renderPage();
      return true;
    }
    if (button.dataset.memoryPage) {
      offset = Math.max(0, offset + Number(button.dataset.memoryPage) * 24);
      void renderPage();
      return true;
    }
    if (button.dataset.memoryCopy !== undefined) {
      const row = rows[Number(button.dataset.memoryCopy)];
      if (row)
        navigator.clipboard.writeText(row.text).then(
          () => toast('摘要已复制'),
          () => toast('复制失败，请展开摘要后手动复制。'),
        );
      return true;
    }
    return false;
  }
  return { page, mount, click };
}
