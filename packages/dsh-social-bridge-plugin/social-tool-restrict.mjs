export const name = 'social-tool-restrict';
export const inject = ['tools'];

export function apply(ctx) {
  // Empty allow list hides present and future tools. Fail initialization if
  // restriction cannot be installed; never silently leave capabilities open.
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '微信群友会话不允许调用工具');
}
