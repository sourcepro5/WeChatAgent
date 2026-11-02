import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runConsoleCommand,windowsPowerShellExecutable,taskFailureMessage} from './console-process.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('current-version open starts once, waits for the real core and preserves existing clients',{skip:process.platform!=='win32'},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hook-client-open-'));
 t.after(()=>{assert(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'probe.ps1');
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
function Reset-Case([string]$Value){$script:mode=$Value;$script:probes=0;$script:starts=0}
function Get-CimInstance {
 param($ClassName,$Filter)
 $script:probes++
 if($script:mode -in @('occupied','failure')){return}
 if($script:mode -eq 'unresolved-existing'){return [pscustomobject]@{ExecutablePath=$null;ProcessId=99;CommandLine=$null}}
 if($script:mode -in @('unresolved-fresh','unresolved-stuck','foreign-fresh')){
  if($script:probes -eq 1){return}
  if($script:mode -eq 'foreign-fresh'){return [pscustomobject]@{ExecutablePath='C:\other\Weixin.exe';ProcessId=99;CommandLine='Weixin.exe'}}
  if($script:probes -eq 2 -or $script:mode -eq 'unresolved-stuck'){return [pscustomobject]@{ExecutablePath=$null;ProcessId=42;CommandLine=$null}}
 }
 if($script:mode -eq 'unresolved-with-existing' -and $script:probes -gt 1){return @([pscustomobject]@{ExecutablePath='C:\fixture\Weixin.exe';ProcessId=42;CommandLine='Weixin.exe'},[pscustomobject]@{ExecutablePath=$null;ProcessId=99;CommandLine=$null})}
 if($script:mode -eq 'fresh'){
  if($script:probes -eq 1){return}
  $id=if($script:probes -eq 2){11}else{12}
  return [pscustomobject]@{ExecutablePath='C:\fixture\Weixin.exe';ProcessId=$id;CommandLine='Weixin.exe'}
 }
 if($script:mode -eq 'foreign'){return [pscustomobject]@{ExecutablePath='C:\other\Weixin.exe';ProcessId=99;CommandLine='Weixin.exe'}}
 $row=[pscustomobject]@{ExecutablePath='C:\fixture\Weixin.exe';ProcessId=42;CommandLine='Weixin.exe'}
 if($script:mode -eq 'multiple'){return @($row,$row)}
 return $row
}
function Get-Process {
 param($Id,$ErrorAction)
 if($script:mode -eq 'fresh' -and $Id -eq 11){throw 'launcher handoff'}
 [pscustomobject]@{HasExited=$false;Path=$(if($script:mode -eq 'reused-pid'){'C:\other\Weixin.exe'}else{'C:\fixture\Weixin.exe'});Modules=$(if($script:mode -eq 'pending'){@()}else{@([pscustomobject]@{ModuleName='Weixin.dll'})})}
}
function Start-Process {
 param($FilePath,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$ErrorAction)
 $script:starts++
 if($FilePath -ne 'C:\fixture\Weixin.exe' -or $WorkingDirectory -ne 'C:\fixture' -or $WindowStyle -ne 'Normal'){throw 'incorrect startup arguments'}
 if($script:mode -eq 'failure'){throw 'fixture startup failure'}
}
function Get-NetTCPConnection {param($LocalPort,$State,$ErrorAction);if($script:mode -eq 'occupied'){[pscustomobject]@{OwningProcess=99}}}
function Start-Sleep {param($Milliseconds)}
Reset-Case 'fresh';Open-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' 2 | Out-Null
if($script:starts -ne 1 -or $script:probes -lt 3){throw 'fresh launch or handoff was not observed'}
Reset-Case 'unresolved-fresh';Open-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' 2 | Out-Null
if($script:starts -ne 1 -or $script:probes -lt 3){throw 'temporary missing process path was not awaited'}
Reset-Case 'existing';Open-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' 0 | Out-Null
if($script:starts -ne 0){throw 'existing client was relaunched'}
foreach($case in @(@{mode='unresolved-existing';error='WECHAT_CLIENT_PATH_UNAVAILABLE';starts=0},@{mode='unresolved-stuck';error='WECHAT_CLIENT_PATH_UNAVAILABLE';starts=1},@{mode='unresolved-with-existing';error='WECHAT_CLIENT_PATH_UNAVAILABLE';starts=0},@{mode='foreign-fresh';error='WECHAT_OTHER_CLIENT_RUNNING';starts=1},@{mode='foreign';error='WECHAT_OTHER_CLIENT_RUNNING';starts=0},@{mode='multiple';error='WECHAT_MULTIPLE_MATCHING_CLIENTS';starts=0},@{mode='occupied';error='HOOK_PORT_OWNER_MISMATCH';starts=0},@{mode='pending';error='WECHAT_STARTUP_TIMEOUT';starts=0},@{mode='reused-pid';error='WECHAT_STARTUP_TIMEOUT';starts=0},@{mode='failure';error='WECHAT_LAUNCH_FAILED';starts=1})){
 Reset-Case $case.mode;$failed=$false
 try{Open-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' 0 | Out-Null}catch{if($_.Exception.Message -notmatch $case.error){throw};$failed=$true}
 if(-not $failed -or $script:starts -ne $case.starts){throw ('incorrect failure boundary: '+$case.mode)}
}
Reset-Case 'fresh';$failed=$false
try{Open-HookClient 'C:\fixture\Weixin.exe' 'https://remote.example' 0 | Out-Null}catch{if($_.Exception.Message -notmatch 'HOOK_LOOPBACK_REQUIRED'){throw};$failed=$true}
if(-not $failed -or $script:starts -ne 0){throw 'remote URL started a client'}
'Current-version client open regression passed'
`);
 let output='';const code=await runConsoleCommand({exe:windowsPowerShellExecutable(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Helper',path.join(root,'scripts/hook-client-health.ps1')]},chunk=>output+=chunk,{timeoutMs:15000});
 assert.equal(code,0,output);assert.match(output,/client open regression passed/);
});

test('launch failures identify the required user action',()=>{
 assert.match(taskFailureMessage('WECHAT_OTHER_CLIENT_RUNNING',1),/托盘正常退出/);
 assert.match(taskFailureMessage('WECHAT_STARTUP_TIMEOUT',1),/尚未完成启动/);
 assert.match(taskFailureMessage('WECHAT_CLIENT_PATH_UNAVAILABLE',1),/进程路径.*重试/);
 assert.match(taskFailureMessage('WECHAT_LAUNCH_FAILED',1),/程序路径/);
 assert.match(taskFailureMessage('HOOK_PROFILE_MISMATCH',1),/发送组件不匹配/);
});
test('launcher health waits through a process handoff, accepts pre-login health and rejects dead or foreign senders',{skip:process.platform!=='win32'},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hook-client-health-'));
 t.after(()=>{assert(dir.startsWith(os.tmpdir()+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'probe.ps1'),token=path.join(dir,'token.txt');fs.writeFileSync(token,'a'.repeat(64));
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Helper,[string]$TokenFile)
$ErrorActionPreference='Stop'
. $Helper
$script:probes=0;$script:mode='handoff'
function Get-CimInstance {
 param($ClassName,$Filter)
 $script:probes++
 if($script:mode -eq 'handoff' -and $script:probes -le 2){return}
 [pscustomobject]@{ExecutablePath='C:\fixture\Weixin.exe';ProcessId=5678;CommandLine='Weixin.exe'}
}
function Invoke-RestMethod {
 param($Uri,$Headers,$TimeoutSec)
 if($Headers.Authorization -ne ('Bearer '+('a'*64))){throw 'token not supplied'}
 if($script:mode -eq 'dead'){throw 'connection refused'}
 if($script:mode -eq 'handoff' -and $script:probes -le 2){throw 'connection refused'}
 [pscustomobject]@{integration='WeChatAgent-1';backend='wechat-hook';version='4.1.10.27';startupState='ready';pid=$(if($script:mode -eq 'foreign'){9999}else{5678});databaseAccounts=@()}
}
Wait-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' '4.1.10.27' $TokenFile 3
if($script:probes -lt 3){throw 'handoff not observed'}
$script:mode='dead';$failed=$false
try{Wait-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' '4.1.10.27' $TokenFile 1}catch{if($_.Exception.Message -notmatch 'HOOK_CLIENT_UNHEALTHY'){throw};$failed=$true}
if(-not $failed){throw 'existing but dead sender was accepted'}
$script:mode='foreign';$failed=$false
try{Wait-HookClient 'C:\fixture\Weixin.exe' 'http://127.0.0.1:30001' '4.1.10.27' $TokenFile 1}catch{if($_.Exception.Message -notmatch 'HOOK_PORT_OWNER_MISMATCH'){throw};$failed=$true}
if(-not $failed){throw 'foreign sender was accepted'}
'Hook client health regression passed'
`);
 let output='';const code=await runConsoleCommand({exe:windowsPowerShellExecutable(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Helper',path.join(root,'scripts/hook-client-health.ps1'),'-TokenFile',token]},chunk=>output+=chunk,{timeoutMs:15000});
 assert.equal(code,0,output);assert.match(output,/health regression passed/);
});
