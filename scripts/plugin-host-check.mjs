import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {unpackZip} from '../packages/plugin-api/zip.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const requiredIntegration=[
  'packages/dsh-social-bridge-plugin/native-context.mjs', 'scripts/project-config.mjs',
  'scripts/console-server.mjs', 'public/console/plugins.js', 'public/console/plugin-contract.mjs',
  'scripts/plugin-ui.mjs','scripts/plugin-settings-actions.mjs','scripts/voice-host-status.mjs','public/console/plugin-frame.mjs',
];
function runtimeModules(folder,prefix='packages/plugin-api'){
  return fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isSymbolicLink()?[]:entry.isDirectory()?runtimeModules(path.join(folder,entry.name),prefix+'/'+entry.name):entry.name.endsWith('.mjs')?[prefix+'/'+entry.name]:[]);
}

export async function auditPluginHost(root,{compareRoot,requireZips=true}={}){
  root=path.resolve(root);const findings=[],packages=[];
  const problem=(file,code)=>findings.push({file,code});
  const read=relative=>fs.readFileSync(path.join(root,relative));
  let contract,catalog,bundled;
  try{
    const url=pathToFileURL(path.join(root,'packages/plugin-api/contract.mjs'));url.searchParams.set('audit',sha(read('packages/plugin-api/contract.mjs')));
    contract=await import(url.href);
    catalog=await import(pathToFileURL(path.join(root,'packages/plugin-api/catalog.mjs')).href);
    bundled=await import(pathToFileURL(path.join(root,'packages/plugin-api/bundled.mjs')).href);
  }catch{return {ok:false,root,findings:[{file:'packages/plugin-api',code:'PLUGIN_HOST_MODULES_MISSING_OR_INVALID'}],packages};}
  for(const relative of [...contract.PLUGIN_HOST_FILES,...contract.VOICE_HOST_FILES,...requiredIntegration]){
    const file=path.join(root,relative);if(!fs.existsSync(file)||!fs.statSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())problem(relative,'PLUGIN_HOST_FILE_MISSING');
  }
  try{
    const base='packages/voice-codec/silk-wasm/',provenance=JSON.parse(read(base+'PROVENANCE.json'));
    const names=['LICENSE','lib/index.mjs','lib/silk.wasm','package.json'];
    if(provenance.name!=='silk-wasm'||provenance.version!=='3.7.1'||provenance.license!=='MIT'||JSON.stringify(Object.keys(provenance.files).sort())!==JSON.stringify(names))throw Error();
    for(const name of names)if(sha(read(base+name))!==provenance.files[name])throw Error();
  }catch{problem('packages/voice-codec/silk-wasm','VOICE_CODEC_PAYLOAD_INVALID');}
  if(JSON.stringify(contract.PERMISSIONS)!==JSON.stringify(Object.keys(contract.PERMISSION_LABELS))||JSON.stringify(contract.PERMISSIONS)!==JSON.stringify(catalog.PERMISSIONS)||JSON.stringify(contract.HOST_FEATURES)!==JSON.stringify(catalog.HOST_FEATURES))problem('packages/plugin-api/contract.mjs','PLUGIN_HOST_DECLARATIONS_DIVERGED');
  for(const name of runtimeModules(path.join(root,'packages/plugin-api')).filter(name=>name!=='packages/plugin-api/bundled.mjs'))if(!contract.PLUGIN_HOST_FILES.includes(name))problem(name,'PLUGIN_HOST_REVISION_FILE_UNTRACKED');
  const checks=[
    ['packages/dsh-social-bridge-plugin/native-context.mjs','pluginHostFeatures:HOST_FEATURES'],
    ['packages/dsh-social-bridge-plugin/native-context.mjs','pluginPermissions:PERMISSIONS'],
    ['packages/plugin-api/worker.mjs','contract:hostContract()'],
    ['packages/plugin-api/process.mjs','contractFingerprint(message.contract'],
    ['public/console/plugins.js',"from './plugin-contract.mjs'"],
    ['scripts/console-server.mjs',"route==='/plugin-contract.mjs'"],
    ['scripts/project-config.mjs','PLUGIN_HOST_FILES'],
  ];
  for(const [file,marker]of checks)if(!fs.existsSync(path.join(root,file))||!read(file).toString('utf8').includes(marker))problem(file,'PLUGIN_HOST_INTEGRATION_STALE');
  for(const bundle of bundled.BUNDLED_PLUGINS){
    try{
      const source=path.join(root,bundle.source),item=catalog.inspectPackage(source);
      if(item.id!==bundle.id||item.version!==bundle.version)throw Error('PLUGIN_BUNDLE_IDENTITY_MISMATCH');
      if(item.requiresHostFeatures.some(name=>!contract.HOST_FEATURES.includes(name)))throw Error('PLUGIN_BUNDLE_UNSUPPORTED_FEATURE');
      if(bundle.zip&&requireZips){
        const entries=unpackZip(read(bundle.zip)),original=catalog.packageFiles(source);
        if(entries.length!==original.length||entries.some(entry=>!original.some(file=>file.name===entry.name&&file.data.equals(entry.data))))throw Error('PLUGIN_BUNDLE_ZIP_STALE');
        const checksum=read(bundle.zip+'.sha256').toString('utf8').trim().split(/\s+/)[0].toLowerCase();
        if(checksum!==sha(read(bundle.zip)))throw Error('PLUGIN_BUNDLE_CHECKSUM_STALE');
      }
      packages.push({id:item.id,version:item.version,permissions:item.permissions,features:item.requiresHostFeatures});
    }catch(error){problem(bundle.source,/^PLUGIN_[A-Z_]+$/.test(error.message)?error.message:'PLUGIN_BUNDLE_INVALID_OR_MISSING');}
  }
  if(compareRoot){
    for(const relative of [...contract.PLUGIN_HOST_FILES,...contract.VOICE_CODEC_FILES]){
      const other=path.join(compareRoot,relative);
      if(!fs.existsSync(other)||!fs.existsSync(path.join(root,relative))||!fs.readFileSync(other).equals(read(relative)))problem(relative,'PLUGIN_HOST_RELEASE_DRIFT');
    }
  }
  return {ok:!findings.length,root,contract:contract.hostContract(),packages,findings};
}

export async function assertPluginHost(root,options){
  const report=await auditPluginHost(root,options);
  if(!report.ok)throw Error('PLUGIN_HOST_RELEASE_CHECK_FAILED: '+report.findings.map(item=>item.file+' ('+item.code+')').join('; '));
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
  const report=await auditPluginHost(option('--root')??path.resolve(import.meta.dirname,'..'),{compareRoot:option('--compare')});
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
