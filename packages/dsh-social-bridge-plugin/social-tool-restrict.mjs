import { withoutSocialTools } from './social-tool-policy.mjs';

export const name = 'social-tool-restrict';
export const inject = ['tools'];

export function apply(ctx) {
  // Empty allow list hides present and future tools. Fail initialization if
  // restriction cannot be installed; never silently leave capabilities open.
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '微信群友会话不允许调用工具');
  // The SDK restriction masks inherited tools; Host-owned scoped additions
  // such as Schedule still need a final per-Agent presentation boundary.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) =>
    withoutSocialTools(await next()), { prepend: true });
}
