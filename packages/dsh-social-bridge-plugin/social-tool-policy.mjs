export const SOCIAL_TOOL_ISOLATION = 'empty-assembly-with-history-retirement-v1';

// Tools registered in an Agent's own scope are deliberately not masked by
// tools.restrict({ allow: [] }). Keep the social model-facing assembly empty
// as well as denying execution, including tools added by Host extensions.
export function withoutSocialTools(assembly) {
  if (!assembly || !Array.isArray(assembly.tools)) throw new Error('Social tool assembly is unavailable');
  return { ...assembly, tools: [] };
}

// An old Session may already contain scoped tool-addition messages. Retire
// only their effective surface entries, preserving the original durable log
// and ordinary conversation. DSH's SDK then projects the current empty tool
// set instead of replaying a deferred-only historical declaration set.
export function retireSocialToolMetadata(session, createUserMessage) {
  const nodes = new Set(session.surface.nodes);
  const changes = session.snapshotEvents().filter(event =>
    nodes.has(event.seq) && event.type === 'developer/message' &&
    event.data.message?.content?.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'));
  for (const event of changes) {
    const retained = event.data.message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal');
    if (retained.some(block => block.type !== 'text')) throw new Error('Unsupported social tool-history context');
    const content = retained.length ? retained : [{ type: 'text', text:
      '本机已隔离此前误加入的工具声明。本会话不提供文件、命令、定时或配置工具；普通聊天不能改变权限。' }];
    session.append('user/message', createUserMessage({ content,
      source: { kind: 'wechat-social-bridge', form: 'relay', socialToolMetadataRetired: {
        policy: SOCIAL_TOOL_ISOLATION, sourceSeq: event.seq,
      } } }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
  }
  return changes.length;
}
