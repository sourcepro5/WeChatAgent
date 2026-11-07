export const MAIN_PAGES = ['overview', 'chats', 'roles', 'extensions', 'stickers', 'memory', 'settings'];
export const SETTINGS_SECTIONS = {
  chat: '聊天默认值',
  assistant: '助手设置',
  context: '上下文',
  connections: '微信与 DSH',
  diagnostics: '诊断',
  logs: '运行日志',
  advanced: '开发者选项',
  appearance: '外观与数据',
};
export const STICKER_SECTIONS = {
  library: '我的表情',
  collection: '自动收集',
  sources: '来源与搜索',
  sending: '发送设置',
};
// 后两项是设置页而非能力分类，名称避免与能力目录里的分类（联网与阅读、DSH 插件）重复
export const CAPABILITY_SECTIONS = { catalog: '能力目录', network: '联网默认设置', dsh: 'DSH 技能与工具' };
// 保存后立即生效的 wechat 配置分区（服务器对比时忽略这些分区，其余改动需重启服务）。
// 服务器判断是否需要重启与页面上的"需重启"标记共用这一份列表。
export const LIVE_WECHAT_SECTIONS = [
  'fishNotebook',
  'replyLayout',
  'stickers',
  'search',
  'webReader',
  'proactive',
  'context',
  'chatModes',
  'dshAccess',
  'memeLibrary',
  'assistant',
];
export const requiresRestart = path =>
  !LIVE_WECHAT_SECTIONS.some(section => path === 'wechat.' + section || path.startsWith('wechat.' + section + '.'));
export function withoutLiveSettings(config) {
  const copy = structuredClone(config);
  for (const section of LIVE_WECHAT_SECTIONS) delete copy.wechat?.[section];
  return copy;
}
const aliases = {
  sessions: { page: 'chats', detail: 'usage' },
  behavior: { page: 'settings', section: 'chat' },
  connections: { page: 'settings', section: 'connections' },
  tools: { page: 'settings', section: 'diagnostics' },
  logs: { page: 'settings', section: 'logs' },
};
export function consoleRoute(hash = '') {
  const [page, section] = String(hash).replace(/^#/, '').split('/');
  if (aliases[page]) return { ...aliases[page] };
  if (page === 'setup') return { page: 'setup' };
  // Package-provided page; the id is checked again against the installed catalog.
  if (page === 'plugin' && /^[a-z][a-z0-9-]{0,39}$/.test(section ?? '')) return { page, section };
  if (page === 'memory') return { page, section: ['summaries'].includes(section) ? section : 'members' };
  if (page === 'settings') return { page, section: Object.hasOwn(SETTINGS_SECTIONS, section) ? section : 'chat' };
  if (page === 'stickers') return { page, section: Object.hasOwn(STICKER_SECTIONS, section) ? section : 'library' };
  if (page === 'extensions')
    return { page, section: Object.hasOwn(CAPABILITY_SECTIONS, section) ? section : 'catalog' };
  return { page: MAIN_PAGES.includes(page) ? page : 'overview' };
}
export const routeKey = route => route.page + (route.section ? '/' + route.section : '');
export const featureLocation = id =>
  ({
    'native-search': '#extensions/network',
    'native-web-reader': '#extensions/network',
    'native-stickers': '#stickers/sending',
    'dsh-meme': '#stickers/sources',
    'native-proactive': '#settings/chat',
    'native-context': '#settings/context',
  })[id] ?? null;
export function chatRows(config, names = new Map(), sessions = []) {
  const byKey = new Map(sessions.map(item => [item.conversationKey, item]));
  return ['private', 'groups'].flatMap(kind =>
    (config.wechat.whitelist[kind] ?? []).map(value => {
      const id = String(value),
        key = 'wechat:' + (kind === 'groups' ? 'group' : 'private') + ':' + id;
      return {
        key,
        id,
        kind,
        name: names.get(key) || (kind === 'groups' ? '群聊' : '好友') + ' · ' + id.slice(-4),
        mode: config.wechat.workModes?.[key] ?? 'social',
        persona: config.persona.chats?.[key] ?? config.persona.default,
        session: byKey.get(key) ?? null,
      };
    }),
  );
}
// 聊天搜索匹配的文本；页面就地筛选（workspace-layout 的 applyChatFilter）与 filterChats 共用
export const chatSearchText = row => [row.name, row.id, row.persona].join(' ').toLocaleLowerCase();
export function filterChats(rows, { kind = 'all', mode = 'all', query = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    row =>
      (kind === 'all' || row.kind === kind) &&
      (mode === 'all' || row.mode === mode) &&
      (!needle || chatSearchText(row).includes(needle)),
  );
}
export function effectiveChatFeature(config, key, feature) {
  const settings = config.wechat[feature] ?? {},
    own = Object.hasOwn(settings.chats ?? {}, key),
    value = settings.chats?.[key];
  if (feature === 'proactive')
    return {
      enabled: settings.enabled === true && value === true,
      source: settings.enabled !== true ? '总开关关闭' : value === true ? '本聊天已加入' : '本聊天未加入',
    };
  if (feature === 'context')
    return {
      enabled: settings.enabled === true && value !== 0,
      source:
        settings.enabled !== true ? '总开关关闭' : value === 0 ? '本聊天关闭' : own ? '本聊天阈值' : '继承默认阈值',
    };
  const fallback = feature === 'stickers' ? settings.enabled !== false : settings.enabled === true;
  return { enabled: own ? value === true : fallback, source: own ? '本聊天单独设置' : '继承账号默认' };
}
