const {withoutSocialTools,canonicalSocialTools,withoutDshIdentity}=await import(new URL('./social-tool-policy.mjs'+new URL(import.meta.url).search,import.meta.url));
import { WEB_READER_POLICY } from './web-reader-policy.mjs';
import {MODEL_SEARCH_POLICY} from './model-search.mjs';
import {FILE_TRANSFER_POLICY} from './file-transfers.mjs';
import {ASSISTANT_ACCESS} from './assistant-policy.mjs';
import {DSH_ACCESS_POLICY} from './dsh-access.mjs';
import {MEME_LIBRARY_POLICY} from './meme-library-policy.mjs';
import {MEMBER_MEMORY_POLICY} from './member-memory-policy.mjs';
import {HISTORY_POLICY} from './history-policy.mjs';
export const name = 'social-tool-restrict';
export const inject = ['tools'];
export function apply(ctx) {
  const marker=Symbol.for('wechatagent.scoped-tool-guard.v1');if(Object.hasOwn(ctx,marker))return;Object.defineProperty(ctx,marker,{value:true,configurable:true});
  ctx.tools.presentAs?.('native'); // Visibility and execution use the same live per-chat authorization below.
  const policies = agent => [Symbol.for('wechatagent.extension-tools.v1'),WEB_READER_POLICY,MODEL_SEARCH_POLICY,DSH_ACCESS_POLICY,FILE_TRANSFER_POLICY,MEME_LIBRARY_POLICY,MEMBER_MEMORY_POLICY,HISTORY_POLICY]
    .map(symbol => agent?.ctx?.[symbol] ?? ctx[symbol]).filter(Boolean);
  const assistantAllowed=agent=>{try{return (agent?.ctx?.[ASSISTANT_ACCESS] ?? (agent ? undefined : ctx[ASSISTANT_ACCESS]))?.()!==false;}catch{return false;}};
  const visibleNames=agent=>new Set(assistantAllowed(agent)?policies(agent).flatMap(policy => [...policy.names()]):[]);
  ctx.tools.guard(exec => assistantAllowed(exec?.agent)&&policies(exec?.agent).some(policy => policy.check(exec?.name)) ? undefined : '微信群友会话不允许调用未授权工具');
  // DSH 0.2.2+ attaches tools after the prompt-assembly hook, from the scope's
  // tool executor. A scoped executor that only narrows describe() keeps the
  // model-facing list equal to the live per-chat authorization; execution is
  // delegated unchanged and still passes the guard above.
  let scopeAgent;
  const hasPromptTools=typeof ctx.tools.resolve!=='function';
  if(!hasPromptTools&&typeof ctx.tools.setExecutor==='function'&&typeof ctx.tools.selectExecutor==='function'){
    const base=()=>ctx.tools.selectExecutor();
    try{
      // Executors that own prompt sections (PTC) cannot be wrapped without hiding those sections.
      if(!(base().sections?.length))ctx.tools.setExecutor({
        describe(definitions){
          const names=visibleNames(scopeAgent),described=base().describe(definitions.filter(definition=>names.has(definition.name)));
          return {...described,schemas:canonicalSocialTools((described.schemas??[]).map(({deferLoading,...schema})=>schema))};
        },
        execute:input=>base().execute(input),
      });
    }catch(error){ctx.logger?.warn?.(`social tool visibility filter unavailable: ${error?.message ?? error}`);}
  }
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if(context?.scope)scopeAgent=context.scope;
    const original = withoutDshIdentity(await next()), assembly=original.sections?.some(section=>section.name==='dsh-expression:companion')?{...original,sections:original.sections.filter(section=>section.name!=='dsh-expression:companion')}:original;
    if(!Array.isArray(assembly.tools))return assembly;
    const names = visibleNames(context?.scope);
    return names.size ? { ...assembly, tools: canonicalSocialTools(assembly.tools.filter(tool => names.has(tool.name)).map(({deferLoading,...tool})=>tool)) } : withoutSocialTools(assembly);
  }, { prepend: true });
}
