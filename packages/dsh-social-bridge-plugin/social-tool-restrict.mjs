export const name = 'social-tool-restrict';
export const inject = ['tools'];

export function apply(ctx) {
  // No model-side tools are required for the first social decision loop.
  // Hide known global tools as well as blocking any execution not listed here.
  for (const name of ['bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
    'str_replace_editor', 'load_workspace_dependencies', 'subagent', 'subagent_fork',
    'send_message', 'workflow', 'job_list', 'job_output', 'job_kill', 'skill',
    'dev_inject_plugin', 'dev_build_plugin', 'dsh_snapshot', 'dsh_rollback']) {
    try { ctx.tools.restrict({ deny: [name] }); } catch {}
  }
  ctx.tools.guard(() => '微信群友会话不允许调用工具');
}
