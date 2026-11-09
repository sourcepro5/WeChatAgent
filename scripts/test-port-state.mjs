import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment} from './console-process.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function scratch(t,prefix){const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>{assert(directory.startsWith(os.tmpdir()+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return directory;}

test('empty-state listener rows keep their owner while readiness still requires a handshake',{skip:process.platform!=='win32'},async t=>{
 const directory=scratch(t,'port-state-'),file=path.join(directory,'listener-rows.ps1');
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Manage)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'invalid supervisor syntax'}
foreach($name in @('Get-PortBindings','Test-ServiceReady')){$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $node.Extent.Text}
function Get-NetTCPConnection{param($LocalPort,$ErrorAction)@(
 [pscustomobject]@{State='';LocalAddress='::';RemotePort=0;OwningProcess=999},
 [pscustomobject]@{State='';LocalAddress='127.0.0.1';RemotePort=0;OwningProcess=777},
 [pscustomobject]@{State='Bound';LocalAddress='0.0.0.0';RemotePort=0;OwningProcess=777},
 [pscustomobject]@{State='Established';LocalAddress='127.0.0.1';RemotePort=55555;OwningProcess=777}
)}
$rows=@(Get-PortBindings 5031)
if($rows.Count -ne 2){throw ('unexpected listener rows: '+$rows.Count)}
if(@($rows | Where-Object OwningProcess -ne 777).Count){throw 'foreign listener owner was accepted'}
$script:open=$false
function Test-Port([int]$Port){return $script:open}
if(Test-ServiceReady 'reader' 5031 777){throw 'readiness accepted a listener without a completed handshake'}
$script:open=$true
if(-not(Test-ServiceReady 'reader' 5031 777)){throw 'owned listener was rejected after a successful handshake'}
function Get-NetTCPConnection{param($LocalPort,$ErrorAction)@([pscustomobject]@{State='';LocalAddress='127.0.0.1';RemotePort=0;OwningProcess=999})}
$failed=$false
try{Test-ServiceReady 'reader' 5031 777|Out-Null}catch{if($_.Exception.Message -notmatch 'SERVICE_PORT_OWNER_MISMATCH'){throw};$failed=$true}
if(-not $failed){throw 'foreign listener owner was accepted'}
'listener state regression passed'
`);
 const run=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Manage',path.join(root,'scripts/manage.ps1')],{windowsHide:true,env:windowsPowerShellEnvironment(),timeout:20000});
 assert.match(run.stdout,/listener state regression passed/);
});

test('the hook launcher treats only a completed handshake as an occupied port',{skip:process.platform!=='win32'},async t=>{
 const directory=scratch(t,'hook-port-'),file=path.join(directory,'hook-port.ps1');
 const open=net.createServer();await new Promise(resolve=>open.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>open.close(resolve)));
 const closed=net.createServer();await new Promise(resolve=>closed.listen(0,'127.0.0.1',resolve));const closedPort=closed.address().port;await new Promise(resolve=>closed.close(resolve));
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Launcher,[int]$OpenPort,[int]$ClosedPort)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'invalid launcher syntax'}
$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-HookPortOpen'},$true)
if(-not $node){throw 'missing Test-HookPortOpen'}
Invoke-Expression $node.Extent.Text
if(-not(Test-HookPortOpen $OpenPort)){throw 'open port was not detected'}
if(Test-HookPortOpen $ClosedPort){throw 'closed port was reported as open'}
'hook port detection passed'
`);
 const run=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Launcher',path.join(root,'scripts/launch-hook-wechat.ps1'),'-OpenPort',String(open.address().port),'-ClosedPort',String(closedPort)],{windowsHide:true,env:windowsPowerShellEnvironment(),timeout:20000});
 assert.match(run.stdout,/hook port detection passed/);
});
