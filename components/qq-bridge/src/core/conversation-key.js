const PLATFORMS = new Set(['qq', 'wechat']);
const KINDS = new Set(['private', 'group']);

export function buildConversationKey(platform, kind, conversationId) {
  if (!PLATFORMS.has(platform) || !KINDS.has(kind)) throw new TypeError('invalid conversation platform or kind');
  const id = String(conversationId ?? '').trim();
  if (!id || id.includes('\0') || id.length > 256) throw new TypeError('invalid conversation id');
  return `${platform}:${kind}:${id}`;
}

export function parseConversationKey(key) {
  const match = /^(qq|wechat):(private|group):(.+)$/.exec(String(key ?? ''));
  if (!match) return null;
  return { platform: match[1], kind: match[2], conversationId: match[3] };
}

export function legacyQqKey(key) {
  const match = /^qq:(private|group):(\d+)$/.exec(String(key ?? ''));
  return match ? `${match[1]}:${match[2]}` : null;
}
