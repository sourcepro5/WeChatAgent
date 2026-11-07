import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateSchema,validateValue,atomicJson,allowedChat,publicSettings} from '../extension-runtime/catalog.mjs';
import {API_VERSION,PERMISSIONS,HOST_FEATURES,HOOKS,FEATURE_ENTRIES,requiredHostFeatures,hostContract,hostCompatibility,HOST_RUNTIME} from './contract.mjs';
export {API_VERSION,PERMISSIONS,HOST_FEATURES,HOOKS} from './contract.mjs';

export const LIMITS=Object.freeze({zipBytes:8*1024*1024,expandedBytes:16*1024*1024,fileBytes:4*1024*1024,files:128,plugins:32});
export const ID=/^[a-z][a-z0-9-]{0,39}$/;
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export {validateSchema,validateValue,atomicJson,allowedChat};
export function directory(root,relative){
  const base=path.resolve(root),target=path.resolve(base,relative);
  if(!target.startsWith(base+path.sep))throw fail('插件目录无效。');
  for(let current=base;;){
    if(fs.existsSync(current)){if(fs.lstatSync(current).isSymbolicLink()||!fs.statSync(current).isDirectory())throw fail('插件目录不能使用链接或文件。');}
    else fs.mkdirSync(current);
    if(current===target)break;
    current=path.join(current,path.relative(current,target).split(path.sep)[0]);
  }
  return target;
}
export function manifest(value){
  if(!value||Array.isArray(value)||value.apiVersion!==2||value.host!=='wechatagent'||!ID.test(value.id??'')||value.id.startsWith('native-'))throw fail('需要 apiVersion: 2、host: "wechatagent" 和有效的插件 id。');
  for(const [key,max] of [['name',80],['description',1024]])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw fail('插件名称或描述无效。');
  if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version??''))throw fail('插件版本需要采用 1.0.0 格式。');
  const allowed=['id','name','description','version','apiVersion','host','author','homepage','permissions','settings','configSchema','requiresHostFeatures','requiresAccount','schedule','dataNamespace'];
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw fail('插件清单包含未知字段，请参照 API v2 文档。');
  if(value.author!==undefined&&(typeof value.author!=='string'||value.author.length>120))throw fail('插件作者无效。');
  if(value.homepage!==undefined){try{const url=new URL(value.homepage);if(url.protocol!=='https:'||url.username||url.password)throw Error();}catch{throw fail('插件主页需要使用 HTTPS 地址。');}}
  if(!Array.isArray(value.permissions??[])||(value.permissions??[]).some(p=>typeof p!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(p)))throw fail('插件权限必须为有效名称组成的字符串数组。');
  const unknownPermissions=(value.permissions??[]).filter(p=>!PERMISSIONS.includes(p));
  if(unknownPermissions.length)throw fail('插件声明了当前安装宿主不支持的权限：'+[...new Set(unknownPermissions)].join('、')+'。请更新实际运行的 WeChatAgent 宿主后再导入。');
  if(!Array.isArray(value.requiresHostFeatures??[])||(value.requiresHostFeatures??[]).some(name=>typeof name!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(name)))throw fail('requiresHostFeatures 必须为有效能力名称组成的字符串数组。');
  const unknownFeatures=(value.requiresHostFeatures??[]).filter(name=>!HOST_FEATURES.includes(name));
  if(unknownFeatures.length)throw fail('插件需要当前安装宿主尚不支持的能力：'+[...new Set(unknownFeatures)].join('、')+'。请更新 WeChatAgent。');
  if(value.requiresAccount!==undefined&&typeof value.requiresAccount!=='boolean')throw fail('requiresAccount 必须为布尔值。');
  if(value.dataNamespace!==undefined&&(value.id!=='fish-notebook'||value.dataNamespace!=='fish-notebook-v1'))throw fail('该历史数据命名空间未向此插件开放。');
  if(value.schedule!==undefined&&(!value.schedule||Array.isArray(value.schedule)||Object.keys(value.schedule).some(key=>!['timeSetting','personaScoped'].includes(key))||typeof value.schedule.timeSetting!=='string'||!(value.permissions??[]).includes('schedule')||value.schedule.personaScoped!==undefined&&typeof value.schedule.personaScoped!=='boolean'||value.schedule.personaScoped&&!(value.permissions??[]).includes('persona_read')))throw fail('插件每日计划配置无效。');
  const configSchema=value.configSchema??{},settings=value.settings??{};
  if(Object.keys(configSchema).length>24)throw fail('插件最多定义 24 个设置字段。');
  validateSchema({type:'object',properties:configSchema,additionalProperties:false});
  validateValue(settings,{type:'object',properties:configSchema,additionalProperties:false},'插件默认设置');
  if(value.schedule&&(!configSchema[value.schedule.timeSetting]||configSchema[value.schedule.timeSetting].type!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings[value.schedule.timeSetting]??'')))throw fail('每日计划时间需为 HH:MM，并对应字符串设置字段。');
  return {...value,permissions:[...new Set(value.permissions??[])],requiresHostFeatures:requiredHostFeatures(value),settings,configSchema};
}
export function packageFiles(base){
  const files=[],seen=new Set();let bytes=0;
  function visit(folder,depth=0){
    if(depth>8||fs.lstatSync(folder).isSymbolicLink())throw fail('插件层级过深或包含链接。');
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      if(['node_modules','.git'].includes(entry.name)||entry.isSymbolicLink())throw fail('插件不能包含链接、node_modules 或 .git。');
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())visit(file,depth+1);
      else if(entry.isFile()){
        const relative=path.relative(base,file).replaceAll(path.sep,'/'),key=relative.normalize('NFC').toLowerCase(),size=fs.statSync(file).size;
        if(seen.has(key)||size>LIMITS.fileBytes||(bytes+=size)>LIMITS.expandedBytes||files.length>=LIMITS.files)throw fail('插件文件冲突或超过大小、数量限制。');
        seen.add(key);files.push({name:relative,data:fs.readFileSync(file)});
      }else throw fail('插件包含不支持的文件类型。');
    }
  }
  visit(base);return files.sort((a,b)=>a.name.localeCompare(b.name));
}
export function inspectPackage(base){
  const files=packageFiles(base),entry=files.find(item=>item.name==='plugin.json');
  if(!entry||entry.data.length>65536||!files.some(item=>item.name==='index.mjs'))throw fail('ZIP 中需要 plugin.json 和 index.mjs，或只包一层目录。');
  let data;try{data=manifest(JSON.parse(entry.data.toString('utf8').replace(/^\uFEFF/,'')));}catch(error){throw error.status?error:fail('plugin.json 不是有效的 UTF-8 JSON。');}
  return {...data,directory:base,revision:hash(JSON.stringify(files.map(item=>[item.name,hash(item.data)])))};
}
export function scanPlugins(root){
  const base=path.join(root,'plugins');if(!fs.existsSync(base))return [];
  if(fs.lstatSync(base).isSymbolicLink())throw fail('插件根目录不能是链接。');
  return fs.readdirSync(base,{withFileTypes:true}).filter(item=>item.isDirectory()||item.isSymbolicLink()).slice(0,LIMITS.plugins+1).map(entry=>{
    try{const item=inspectPackage(path.join(base,entry.name));if(item.id!==entry.name)throw fail('插件目录与 id 不一致。');return item;}
    catch(error){return {id:entry.name,name:entry.name,invalid:true,reason:error.message,permissions:[],configSchema:{},settings:{}};}
  });
}
export function configuration(root){
  const file=path.join(root,'config/plugins.json');
  if(fs.existsSync(file)){const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024)throw fail('插件配置文件类型或大小无效。');}
  const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{"version":1,"plugins":{}}';
  if(Buffer.byteLength(raw)>512*1024)throw fail('插件配置过大。');
  let config;try{config=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{throw fail('插件配置不可读，请保留 config/plugins.json 并修复其 JSON 格式。',503);}
  if(!config||config.version!==1||!config.plugins||typeof config.plugins!=='object'||Array.isArray(config.plugins))throw fail('插件配置无效。');
  return {config,revision:hash(raw)};
}
export function updatePlugin(root,id,body){
  const saved=configuration(root);if(body.revision!==saved.revision)throw fail('插件设置已变化，请刷新后重试。',409);
  const item=scanPlugins(root).find(item=>item.id===id&&!item.invalid);if(!item)throw fail('插件不存在或清单无效。',404);
  if(typeof body.enabled!=='boolean'||!Array.isArray(body.permissions)||body.permissions.some(p=>!item.permissions.includes(p))||body.chats!==null&&(!Array.isArray(body.chats)||body.chats.some(key=>!allowedChat(root,key))))throw fail('插件权限或聊天范围无效。');
  if(body.enabled&&item.permissions.some(p=>!body.permissions.includes(p)))throw fail('请勾选插件所需的能力后再启用。');
  if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))throw fail('插件设置无效。');
  const previous=saved.config.plugins[id]??{},settings={...item.settings,...previous.settings,...body.settings};
  for(const [key,schema]of Object.entries(item.configSchema))if(schema.secret&&body.settings[key]===''&&previous.settings?.[key])settings[key]=previous.settings[key];
  validateValue(settings,{type:'object',properties:item.configSchema,additionalProperties:false},'插件设置');
  if(item.schedule&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings[item.schedule.timeSetting]??''))throw fail('每日计划时间必须为 HH:MM。');
  saved.config.plugins[id]={enabled:body.enabled,permissions:[...new Set(body.permissions)],chats:body.chats===null?null:[...new Set(body.chats)],settings,generation:crypto.randomUUID()};
  atomicJson(path.join(directory(root,'config'),'plugins.json'),saved.config);return configuration(root);
}
export function pluginCatalog(root,runtime=[]){
  let saved,items;try{saved=configuration(root);items=scanPlugins(root);}catch{return {apiVersion:2,revision:null,plugins:[],error:'插件配置或目录不可读，原文件已保留。请检查 config/plugins.json 和 plugins 目录。'};}
  const running=new Map(runtime.map(item=>[item.id,item]));
  return {apiVersion:API_VERSION,hostFeatures:HOST_FEATURES,hostPermissions:PERMISSIONS,hostContract:hostContract(),revision:saved.revision,plugins:items.map(item=>{
    const setting=saved.config.plugins[item.id]??{},state=running.get(item.id),enabled=setting.enabled===true;
    return {id:item.id,name:item.name,description:item.description??'',version:item.version,apiVersion:2,host:'wechatagent',management:'wechatagent',author:item.author??'',homepage:item.homepage,
      revision:item.revision,invalid:!!item.invalid,enabled,permissions:setting.permissions??[],requestedPermissions:item.permissions,requiresHostFeatures:item.requiresHostFeatures??[],chats:setting.chats===null?null:setting.chats??[],
      configSchema:item.configSchema,settings:publicSettings(item,{...item.settings,...setting.settings}),actions:state?.actions??[],loaded:state?.loaded===true,active:state?.active===true,
      reason:item.invalid?item.reason:!enabled?'已安装，尚未启用':state?.reason??'设置已保存，等待加载新版 DSH 桥接',statusLabel:item.invalid?'清单无效':!enabled?'已关闭':state?.active?'已开启':'待生效',statusTone:item.invalid?'error':!enabled?'muted':state?.active?'ok':'warning'};
  })};
}
function enabledFor(root,id,key,plugins){
  if(!ID.test(id??''))return null;
  try{
    const folder=path.join(root,'plugins',id),file=path.join(folder,'plugin.json');
    for(const candidate of [path.join(root,'plugins'),folder,file])if(fs.lstatSync(candidate).isSymbolicLink())return null;
    if(fs.statSync(file).size>65536)return null;
    const item=manifest(json(file)),saved=plugins[id];
    return item.id===id&&saved?.enabled===true&&item.permissions.every(p=>saved.permissions?.includes(p))&&(saved.chats===null||saved.chats?.includes(key))?{item,saved}:null;
  }catch{return null;}
}
export function pluginEnabled(root,id,key){
  if(!ID.test(id??'')||!allowedChat(root,key))return false;
  try{return !!enabledFor(root,id,key,configuration(root).config.plugins);}catch{return false;}
}
// Enabled plugins for this chat that opted into a FEATURE_ENTRIES host feature,
// with the settings generation each one runs under. Sorted by id.
export function featurePlugins(root,feature,key){
  const entry=FEATURE_ENTRIES[feature];if(!entry||!allowedChat(root,key))return [];
  let plugins;try{plugins=configuration(root).config.plugins;}catch{return [];}
  return Object.keys(plugins).sort().flatMap(id=>{
    const found=enabledFor(root,id,key,plugins);
    return found&&found.item.requiresHostFeatures.includes(feature)&&found.saved.permissions.includes(entry.permission)?[{id,generation:String(found.saved.generation??'')}]:[];
  });
}
export function runtimeCatalog(catalog,live){
  const connected=!!live&&(live.runtime??live.pluginRuntime)===HOST_RUNTIME;
  return {...catalog,runtimeConnected:connected,liveHostContract:live?{apiVersion:live.apiVersion??live.pluginApiVersion,revision:live.revision??live.pluginContractRevision??null,features:live.features??live.pluginHostFeatures??[],permissions:live.permissions??live.pluginPermissions??null}:null,
    plugins:catalog.plugins.map(item=>{
      const compatibility=hostCompatibility({...item,permissions:item.requestedPermissions},live);
      return {...item,compatibility,...(!item.invalid&&!compatibility.compatible&&(item.enabled||live)?{active:false,loaded:false,reason:compatibility.reason,statusLabel:live?'宿主待更新':'等待宿主',statusTone:'warning'}:{})};
    })};
}
export function archivePlugin(root,id,revision){
  const saved=configuration(root);if(saved.revision!==revision)throw fail('插件设置已变化，请刷新后重试。',409);
  if(!ID.test(id))throw fail('插件 id 无效。');
  const target=path.join(directory(root,'plugins'),id);if(!fs.existsSync(target)||fs.lstatSync(target).isSymbolicLink())throw fail('插件不存在。',404);
  const archive=path.join(directory(root,'state/plugin-archives'),id+'-'+crypto.randomUUID());
  fs.renameSync(target,archive);
  try{delete saved.config.plugins[id];atomicJson(path.join(directory(root,'config'),'plugins.json'),saved.config);}
  catch(error){fs.renameSync(archive,target);throw error;}
  return configuration(root);
}
