const percent = value => (Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '—');
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—');
export function sessionUsage(usage) {
  if (!usage) return '<p class="subtle">用量统计等待插件更新或新请求。</p>';
  const { recent, cumulative, latest } = usage;
  const when = value =>
    Number.isFinite(value)
      ? new Date(value).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '时间未知';
  const range = recent.calls ? `${when(recent.firstAt)} 至 ${when(recent.lastAt)}` : '暂无请求';
  const purpose =
    latest?.purpose === 'format-repair' ? '格式修正' : latest?.purpose === 'history-summary' ? '历史摘要' : '聊天请求';
  return `<div class="session-usage" aria-label="聊天 Token 用量"><div class="session-usage-rates"><div><span>近期命中率 · 最近 ${count(recent.calls)} 次</span><strong>${percent(recent.cacheReadRate)}</strong></div><div><span>账本累计命中率</span><strong>${percent(cumulative.cacheReadRate)}</strong></div></div><p class="subtle">${range} · 最多 ${count(usage.recentLimit)} 次模型请求</p>${latest ? `<p class="session-usage-latest">最近一次 ${percent(latest.cacheReadRate)} · ${purpose}<br>未缓存输入 ${count(latest.U)} / 总输入 ${count(latest.P)} · 输出 ${count(latest.O)} token</p>` : ''}<p class="subtle">近期含格式修正 ${count(recent.formatRepairs)} 次、历史摘要 ${count(recent.historySummaries)} 次${recent.missingUsage ? '；' + count(recent.missingUsage) + ' 次用量缺失，未计入比例' : ''}。</p><details class="usage-notes"><summary>统计口径说明</summary><p>统计包含工具续接和失败重试；累计范围为当前聊天的本地账本，命中率不等于费用节省比例。</p></details></div>`;
}
