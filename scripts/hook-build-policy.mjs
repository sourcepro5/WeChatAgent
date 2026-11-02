import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {windowsPowerShellEnvironment,windowsPowerShellExecutable} from './console-process.mjs';

export function verifyWeChatClient(directory,version){
  if(!['4.1.10.27','4.1.15.13'].includes(version))throw new Error('Unsupported bundled WeChat version.');
  const command=`$ErrorActionPreference='Stop'; foreach($file in @((Join-Path $env:WECHATAGENT_BUILD_CLIENT 'Weixin.exe'),(Join-Path $env:WECHATAGENT_BUILD_CLIENT ($env:WECHATAGENT_BUILD_VERSION+'\\Weixin.dll')))){if((Get-Item -LiteralPath $file).VersionInfo.FileVersion -ne $env:WECHATAGENT_BUILD_VERSION){throw 'Bundled WeChat version mismatch.'}; $signature=Get-AuthenticodeSignature -LiteralPath $file; if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent'){throw 'Bundled WeChat signature invalid.'}}`;
  const result=spawnSync(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...windowsPowerShellEnvironment(),WECHATAGENT_BUILD_CLIENT:path.resolve(directory),WECHATAGENT_BUILD_VERSION:version}});
  if(result.status!==0)throw new Error('Bundled WeChat verification failed: '+(result.stderr||result.error?.message||result.stdout));
}

// Fail before staging an installer if its native resource is stale or corrupt.
export function verifyHookBuild(directory,version='4.1.10.27') {
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8').replace(/^\uFEFF/, ''));
  if(version==='4.1.15.13'){
    if(build.targetVersion!==version||build.integration!=='WeChatAgent-1'||build.profile!=='4.1.15.13-media-mentions-v2'||build.nativeTextSend!==true||build.nativeImageSend!==true||build.nativeMentionSend!==true)throw new Error('Current Hook build profile mismatch.');
    for(const [file,expected] of [['wechatagent-text-4.1.15.13.dll',build.sha256],['wechatagent-text-loader.exe',build.loaderSha256]]){
      const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,file))).digest('hex');
      if(actual!==expected)throw new Error('Current Hook resource does not match build.json: '+file);
    }
    return build;
  }
  if(version!=='4.1.10.27')throw new Error('Unsupported bundled Hook version.');
  if (build.targetVersion !== '4.1.10.27' || build.initialization !== 'deferred-module-v3' ||
      build.mutexCompatibility !== 'legacy-runtime-constructor-v1' ||
      build.exceptionDiagnostics !== 'seh-cpp-stage-v1' || build.logWriter !== 'win32-srw-v1') {
    throw new Error('Hook build is outdated: rebuild the native component before packaging.');
  }
  const dll = fs.readFileSync(path.join(directory, 'version.dll'));
  const actual = crypto.createHash('sha256').update(dll).digest('hex');
  if (actual !== build.sha256) throw new Error('Hook DLL does not match build.json; packaging stopped.');
  return build;
}
