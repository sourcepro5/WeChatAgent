import {PluginProcess} from '../packages/plugin-api/process.mjs';
import {configuration,scanPlugins,validateValue,fail} from '../packages/plugin-api/catalog.mjs';

// Settings actions are listed in a package's ui.json and only called from its
// settings page, e.g. to test a connection before the plugin is enabled. Each
// call runs in a fresh, short-lived worker with saved settings only: no chat,
// account, storage, documents, history, audio or reply services.
const MESSAGES={PLUGIN_TIMEOUT:'插件检测超时，请稍后重试。',PLUGIN_CANCELLED:'检测已取消。',PLUGIN_LOAD_TIMEOUT:'插件代码未能及时启动，请稍后重试。',PLUGIN_PROCESS_EXITED:'插件代码意外退出，请检查插件版本。',PLUGIN_SERVICE_UNAVAILABLE:'设置页动作不能使用聊天、存储等宿主能力。'};
function readable(error){
  if(error.status&&error.status!==400||!/^PLUGIN_[A-Z0-9_]+$/.test(error.message))return error;
  return fail(MESSAGES[error.message]??'插件设置动作未完成（'+error.message+'）。',error.message==='PLUGIN_TIMEOUT'?504:503);
}
export function createSettingsActionRunner({root,describe,now=Date.now,timeoutMs=35000}){
  const running=new Map();let closed=false;
  async function run(id,name,{packageRevision,args={}}={},{signal}={}){
    if(closed)throw fail('插件设置动作已关闭。',503);
    const item=scanPlugins(root).find(row=>row.id===id&&!row.invalid);
    if(!item)throw fail('插件已卸载或清单无效。',404);
    if(packageRevision!==item.revision)throw fail('插件包已更新，请重新打开配置页。',409);
    if(!describe(item).ui?.settings?.actions?.includes(name))throw fail('此动作未在插件设置页声明。',404);
    if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>128*1024)throw fail('动作参数必须是对象。');
    if(running.size>=2)throw fail('已有插件检测正在进行，请稍后再试。',429);
    const saved=configuration(root).config.plugins[id]??{},worker=new PluginProcess(item),controller=new AbortController();
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    running.set(controller,id);
    try{
      await worker.start(3000);
      const action=worker.actions.find(row=>row.id===name);if(!action)throw fail('插件没有注册此设置动作。',404);
      validateValue(args,action.parameters,'动作参数');
      const context={mode:'settings',now:now(),settings:structuredClone({...item.settings,...saved.settings})};
      return await worker.call('action',name,structuredClone(args),context,()=>{throw fail('PLUGIN_SERVICE_UNAVAILABLE');},{signal:controller.signal,timeoutMs});
    }catch(error){throw readable(error);}
    finally{signal?.removeEventListener('abort',abort);running.delete(controller);controller.abort();await worker.dispose();}
  }
  // Install, update and uninstall end any check still running for that package.
  function cancel(id){for(const [controller,owner]of running)if(owner===id)controller.abort();}
  return {run,cancel,close(){closed=true;for(const controller of running.keys())controller.abort();}};
}
