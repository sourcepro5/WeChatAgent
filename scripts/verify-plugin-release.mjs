import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertPluginHost} from './plugin-host-check.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {releaseIdentity} from './release-version.mjs';
import {verifyHookBuild,verifyWeChatClient} from './hook-build-policy.mjs';

const root=path.resolve(import.meta.dirname,'..'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const {version,packageVersion}=releaseIdentity(JSON.parse(fs.readFileSync(path.join(root,'package.json'))));
const sourceReport=JSON.parse(fs.readFileSync(path.join(root,'state/source-release-'+version+'.json')));
const sourceAudit=await assertPluginHost(root),sourceCheck=spawnSync(process.execPath,[path.join(root,'scripts/public-source-check.mjs'),'--files'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
if(sourceCheck.status!==0)throw Error('PUBLIC_SOURCE_CHECK_FAILED');
const privacy=JSON.parse(sourceCheck.stdout),builtFiles=Object.keys(sourceReport.sourceFiles).sort();
if(JSON.stringify(builtFiles)!==JSON.stringify(privacy.files.sort()))throw Error('SOURCE_FILE_SET_CHANGED_AFTER_PACKAGING');
for(const relative of builtFiles)if(hash(fs.readFileSync(path.join(root,relative)))!==sourceReport.sourceFiles[relative])throw Error('SOURCE_CHANGED_AFTER_PACKAGING: '+relative);
const stage=path.join(root,'state/installer-stage/project'),unpacked=path.join(root,'release/installer/win-unpacked/resources/project');
const templateReports=[];
for(const directory of [stage,unpacked]){
  await assertPluginHost(directory,{compareRoot:root});
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'deployment.json')));
  if(manifest.version!==version||manifest.packageVersion!==packageVersion)throw Error('INSTALLER_VERSION_MISMATCH');
  for(const relative of ['package.json','../app/package.json']){
    const item=JSON.parse(fs.readFileSync(path.join(directory,relative),'utf8'));
    if(item.version!==packageVersion||item.releaseVersion!==version)throw Error('INSTALLER_PACKAGE_VERSION_MISMATCH');
  }
  for(const relative of manifest.files){
    if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..')||relative.startsWith('state/')||relative==='config/wechatagent.json')throw Error('INSTALLER_PRIVATE_PATH_REJECTED');
    if(hash(fs.readFileSync(path.join(directory,relative)))!==manifest.sourceHashes[relative])throw Error('INSTALLER_TEMPLATE_HASH_MISMATCH: '+relative);
  }
  for(const relative of ['config/plugins.json','config/extensions.json','config/wechatagent.json'])if(fs.existsSync(path.join(directory,relative)))throw Error('INSTALLER_PRIVATE_CONFIG_REJECTED');
  if(fs.existsSync(path.join(directory,'plugins'))&&fs.readdirSync(path.join(directory,'plugins')).length)throw Error('INSTALLER_INSTALLED_PLUGINS_REJECTED');
  templateReports.push({buildId:manifest.buildId,files:manifest.files.length,runtimeRevision:manifest.runtimeRevision,builtAt:manifest.builtAt});
}
if(templateReports[0].buildId!==templateReports[1].buildId)throw Error('INSTALLER_STAGE_DIVERGED');
const packagedManifest=JSON.parse(fs.readFileSync(path.join(stage,'deployment.json'),'utf8'));
const bundledWechatVersion=packagedManifest.wechatVersion??'4.1.10.27';
const vendorReports=[];
for(const directory of [path.join(root,'state/installer-stage/vendor'),path.join(root,'release/installer/win-unpacked/resources/vendor')]){
  verifyWeChatClient(path.join(directory,'wechat'),bundledWechatVersion);
  verifyHookBuild(path.join(directory,'hook'));
  const current=bundledWechatVersion==='4.1.15.13'?verifyHookBuild(path.join(directory,'hook-current'),bundledWechatVersion):null;
  vendorReports.push({version:bundledWechatVersion,clientSha256:hash(fs.readFileSync(path.join(directory,'wechat/Weixin.exe'))),coreSha256:hash(fs.readFileSync(path.join(directory,'wechat',bundledWechatVersion,'Weixin.dll'))),nativeProfile:current?.profile??null,nativeSha256:current?.sha256??null,loaderSha256:current?.loaderSha256??null});
}
if(JSON.stringify(vendorReports[0])!==JSON.stringify(vendorReports[1]))throw Error('INSTALLER_VENDOR_RESOURCES_DIVERGED');
const installerRelative='release/installer/WeChatAgent-Setup-'+version+'-x64.exe',installer=fs.readFileSync(path.join(root,installerRelative));
const pe=installer.readUInt32LE(0x3c);
if(installer.toString('ascii',0,2)!=='MZ'||installer.readUInt32LE(pe)!==0x4550)throw Error('INSTALLER_PE_INVALID');
const assets=[installerRelative,sourceReport.asset.path,...BUNDLED_PLUGINS.filter(item=>item.zip).map(item=>item.zip)];
const roleAsset='release/installer/蓝色大肥鱼-小助手.md';if(fs.existsSync(path.join(root,roleAsset)))assets.push(roleAsset);
const assetRecords=assets.map(relative=>{const data=fs.readFileSync(path.join(root,relative));return {path:relative,bytes:data.length,sha256:hash(data)};});
if(assetRecords.find(item=>item.path===sourceReport.asset.path).sha256!==sourceReport.asset.sha256)throw Error('SOURCE_ARCHIVE_CHANGED');
const report={version,packageVersion,ok:true,...templateReports[0],checkedAt:new Date().toISOString(),pluginHost:sourceAudit.contract,
  sourcePrivacy:{candidateFiles:privacy.candidateFiles,findings:privacy.findings},templateFilesVerified:templateReports,bundledWechat:vendorReports[0],
  sourceFiles:sourceReport.sourceFiles,assets:assetRecords,regression:JSON.parse(fs.readFileSync(path.join(root,'release-profile.json'),'utf8')).verification?.publicRegression??null,pluginAutoInstalled:false,pluginAutoEnabled:false,
  servicesRestarted:false,realWeChatStarted:false,actualUserDataUsed:false,publication:'local-build-only',
  validationLimits:['Static packaged-file, host-contract, source-file-set and artifact-hash verification; application installation and live ASR were not performed.','Automated plugin, console, deployment and synthetic voice tests are recorded in docs/PLUGIN_HOST_AUDIT.md.']};
const release=path.join(root,'release/installer');
fs.writeFileSync(path.join(release,'VERIFICATION.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(release,'VERIFICATION-'+version+'.json'),JSON.stringify(report,null,2)+'\n');
if(new Set(assetRecords.map(item=>path.basename(item.path))).size!==assetRecords.length)throw Error('RELEASE_ASSET_NAME_CONFLICT');
fs.writeFileSync(path.join(release,'SHA256SUMS.txt'),assetRecords.map(item=>item.sha256+'  '+path.basename(item.path)).join('\n')+'\n');
fs.writeFileSync(path.join(root,installerRelative+'.sha256'),assetRecords[0].sha256+'  '+path.basename(installerRelative)+'\n');
console.log(JSON.stringify({ok:true,version,buildId:report.buildId,sourceFiles:builtFiles.length,assets:assetRecords.length,templateFiles:templateReports[0].files,pluginContract:sourceAudit.contract.revision}));
