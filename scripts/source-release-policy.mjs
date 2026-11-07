import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {unpackZip} from '../packages/plugin-api/zip.mjs';
import {inspectPackage,packageFiles} from '../packages/plugin-api/catalog.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {PLUGIN_HOST_FILES,VOICE_HOST_FILES} from '../packages/plugin-api/contract.mjs';
export const SOURCE_PLUGIN_ZIP='optional-extensions/packages/fish-notebook-1.1.1.zip';
export const SOURCE_PLUGIN_ZIPS=Object.freeze(BUNDLED_PLUGINS.filter(item=>item.zip).map(item=>item.zip));
export function sourceHostFiles(root){
  const required=[...PLUGIN_HOST_FILES,...VOICE_HOST_FILES,'packages/plugin-api/bundled.mjs',
    'packages/dsh-social-bridge-plugin/native-context.mjs','scripts/console-server.mjs','scripts/project-config.mjs',
    'scripts/plugin-host-check.mjs','scripts/plugin-config-ui.mjs','public/console/plugin-config-ui.mjs','scripts/plugin-ui.mjs','public/console/plugin-frame.mjs','public/console/plugin-page-sdk.mjs','scripts/plugin-settings-actions.mjs','scripts/voice-host-status.mjs','public/console/plugins.js','public/console/plugin-contract.mjs'];
  for(const bundle of BUNDLED_PLUGINS){for(const file of packageFiles(path.join(root,bundle.source)))required.push(bundle.source+'/'+file.name);if(bundle.zip)required.push(bundle.zip,bundle.zip+'.sha256');}
  return [...new Set(required)].sort();
}
export function assertSourceHostCoverage(root,files){
  const selected=new Set(files),missing=sourceHostFiles(root).filter(file=>!selected.has(file));
  if(missing.length)throw Error('SOURCE_PLUGIN_HOST_FILES_OMITTED: '+missing.join(', '));
}
export function verifySourcePluginZip(root,bytes,relative=SOURCE_PLUGIN_ZIP){
  const bundle=BUNDLED_PLUGINS.find(item=>item.zip===relative);if(!bundle)throw Error('SOURCE_PLUGIN_NOT_APPROVED');
  const source=path.join(root,bundle.source),item=inspectPackage(source),expected=[...bundle.files].sort();
  if(item.id!==bundle.id||item.version!==bundle.version||item.apiVersion!==2||item.host!=='wechatagent')throw Error('SOURCE_PLUGIN_IDENTITY_MISMATCH');
  const files=packageFiles(source),entries=unpackZip(bytes);
  for(const actual of [files,entries])if(JSON.stringify(actual.map(file=>file.name).sort())!==JSON.stringify(expected))throw Error('SOURCE_PLUGIN_FILE_SET_INVALID');
  for(const entry of entries){const original=files.find(file=>file.name===entry.name);if(!original.data.equals(entry.data))throw Error('SOURCE_PLUGIN_CONTENT_MISMATCH');}
  return {id:item.id,version:item.version,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),entries};
}
