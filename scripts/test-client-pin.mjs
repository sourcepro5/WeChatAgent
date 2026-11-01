import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {runConsoleCommand,windowsPowerShellExecutable} from './console-process.mjs';
const root=path.resolve(import.meta.dirname,'..');

test('client protection is reversible, idempotent and isolated by client directory',{skip:process.platform!=='win32'},async t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-client-pin-'));
 t.after(()=>{assert(temporary.startsWith(os.tmpdir()+path.sep));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:3});});
 const probe=path.join(temporary,'probe.ps1');
 fs.writeFileSync(probe,'\uFEFF'+String.raw`
param([string]$Helper,[string]$TestRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. $Helper
function Get-PinFileVersion {param($Executable);return $script:version}
function Get-AuthenticodeSignature {param($LiteralPath);[pscustomobject]@{Status=$script:signature;SignerCertificate=[pscustomobject]@{Subject='CN=Tencent fixture'}}}
function Get-CimInstance {param($ClassName,$Filter);if($script:updaterRunning){[pscustomobject]@{ExecutablePath=(Join-Path $TestRoot ('state\hook\'+$script:client+'\'+$script:version+'\WeixinUpdate.exe'))}}}
New-Item -ItemType Directory -Path (Join-Path $TestRoot 'config'),(Join-Path $TestRoot 'state\hook') -Force | Out-Null
$script:signature='Valid';$script:updaterRunning=$false
function Set-Client([string]$Name,[string]$Version){
 $script:client=$Name;$script:version=$Version
 $directory=Join-Path $TestRoot ('state\hook\'+$Name)
 if(-not (Test-Path -LiteralPath $directory)){
  New-Item -ItemType Directory -Path (Join-Path $directory $Version) -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $directory 'Weixin.exe'),'fixture executable')
  [IO.File]::WriteAllText((Join-Path $directory ($Version+'\WeixinUpdate.exe')),'fixture updater '+$Version)
  [IO.File]::WriteAllText((Join-Path $directory ($Version+'\existing.bin')),'fixture program data')
 }
 [IO.File]::WriteAllText((Join-Path $TestRoot 'config\wechatagent.json'),(@{hook=@{expectedVersion=$Version;wechatExecutable=('state/hook/'+$Name+'/Weixin.exe')}} | ConvertTo-Json))
 return $directory
}
function Can-Write([string]$File){try{$s=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$s.Dispose();return $true}catch{return $false}}
function Assert-Fails($Code,[string]$Expected){$failed=$false;try{& $Code | Out-Null}catch{if($_.Exception.Message -notmatch $Expected){throw};$failed=$true};if(-not $failed){throw ('Expected rejection: '+$Expected)}}
$directory=Set-Client 'client 13' '4.1.15.13';$initial=(Get-Acl -LiteralPath $directory).Sddl
$outside=Join-Path $TestRoot 'state\chat-data.txt';[IO.File]::WriteAllText($outside,'outside scope')
$oldRecord=Join-Path $TestRoot 'state\hook\client-pin-acl.json';[IO.File]::WriteAllText($oldRecord,(@{path=(Join-Path $TestRoot 'state\hook\old-client');sddl=$initial} | ConvertTo-Json));$oldBytes=[IO.File]::ReadAllBytes($oldRecord)
$updater=Join-Path $directory '4.1.15.13\WeixinUpdate.exe';$expected=Get-PinHash $updater
try{
 Invoke-ClientPin $TestRoot | Out-Null
 if(Test-Path -LiteralPath $updater){throw 'updater not disabled'}
 if((Get-PinHash ($updater+'.disabled')) -ne $expected){throw 'updater content changed'}
 $program=Join-Path $directory '4.1.15.13\existing.bin'
 if(Can-Write $program){throw 'existing program file remains writable'}
 $newFile=Join-Path $directory 'should-not-exist.tmp';$denied=$false
 try{[IO.File]::WriteAllText($newFile,'must fail')}catch{$denied=$true}
 if(-not $denied){throw 'new program files can be created'}
 if([IO.File]::ReadAllText((Join-Path $directory 'Weixin.exe')) -ne 'fixture executable'){throw 'read access lost'}
 if(-not (Can-Write $outside)){throw 'outside data was protected'}
 $target=Get-PinTarget $TestRoot;$key=Join-Path $target.store $target.key;$stateFile=Join-Path $key 'pin.json'
 $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json;$firstGeneration=$state.generation
 Invoke-ClientPin $TestRoot | Out-Null
 $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
 if($state.generation -ne $firstGeneration){throw 'idempotent pin overwrote original backups'}
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 if((Get-Acl -LiteralPath $directory).Sddl -ne $initial -or -not (Can-Write $program)){throw 'permissions not restored'}
 if((Get-PinHash $updater) -ne $expected -or (Test-Path -LiteralPath ($updater+'.disabled'))){throw 'updater not restored'}
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 Invoke-ClientPin $TestRoot | Out-Null
 $second=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
 if($second.generation -eq $firstGeneration){throw 'new protection cycle reused the previous permission snapshot'}
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 if(-not [Linq.Enumerable]::SequenceEqual([byte[]]$oldBytes,[byte[]][IO.File]::ReadAllBytes($oldRecord))){throw 'old client backup was changed'}
 $script:updaterRunning=$true;Assert-Fails {Invoke-ClientPin $TestRoot} 'CLIENT_PIN_UPDATER_RUNNING';$script:updaterRunning=$false
 $script:signature='NotTrusted';Assert-Fails {Invoke-ClientPin $TestRoot} 'CLIENT_PIN_SIGNATURE_INVALID';$script:signature='Valid'
 $script:version='4.1.15.56';Assert-Fails {Invoke-ClientPin $TestRoot} 'CLIENT_PIN_VERSION_MISMATCH';$script:version='4.1.15.13'
 Invoke-ClientPin $TestRoot | Out-Null
 $lock=[IO.File]::Open((Join-Path $key 'operation.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{Assert-Fails {Invoke-ClientPin $TestRoot} 'CLIENT_PIN_BUSY'}finally{$lock.Dispose()}
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 $directory10=Set-Client 'client 10' '4.1.10.27';Invoke-ClientPin $TestRoot | Out-Null
 $target10=Get-PinTarget $TestRoot
 if($target10.key -eq $target.key){throw 'client records are shared'}
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 $legacyDirectory=Set-Client 'legacy 10' '4.1.10.27';$legacyInitial=(Get-Acl -LiteralPath $legacyDirectory).Sddl
 [IO.File]::WriteAllText($oldRecord,(@{path=$legacyDirectory;sddl=$legacyInitial} | ConvertTo-Json))
 $legacyUpdater=Join-Path $legacyDirectory '4.1.10.27\WeixinUpdate.exe';Move-Item -LiteralPath $legacyUpdater -Destination ($legacyUpdater+'.disabled')
 $legacyAcl=Get-Acl -LiteralPath $legacyDirectory
 $legacyRights=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
 $legacyRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,$legacyRights,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
 $legacyAcl.AddAccessRule($legacyRule);$legacyFixtureAcl=Join-Path $TestRoot 'state\legacy-fixture.acl';Write-PinRootAcl $legacyDirectory $legacyAcl.Sddl $legacyFixtureAcl;Restore-PinRootAcl $legacyDirectory $legacyFixtureAcl
 Invoke-ClientPin $TestRoot -Unlock | Out-Null
 if((Get-Acl -LiteralPath $legacyDirectory).Sddl -ne $legacyInitial){throw 'legacy root permissions were not restored'}
 if(-not (Test-Path -LiteralPath ($legacyUpdater+'.disabled'))){throw 'legacy updater was changed without ownership'}
 $directory=Set-Client 'client 13' '4.1.15.13'
 $originalRestore=(Get-Item -LiteralPath Function:\Restore-PinRootAcl).ScriptBlock
 function Restore-PinRootAcl([string]$Directory,[string]$File){if((Split-Path -Leaf $File) -eq 'pinned.acl'){throw 'fixture pin failure'};& $originalRestore $Directory $File}
 try{Assert-Fails {Invoke-ClientPin $TestRoot} 'fixture pin failure'}finally{Set-Item -LiteralPath Function:\Restore-PinRootAcl -Value $originalRestore}
 if(-not (Test-Path -LiteralPath (Join-Path $directory '4.1.15.13\WeixinUpdate.exe')) -or -not (Can-Write (Join-Path $directory '4.1.15.13\existing.bin'))){throw 'failed pin did not roll back'}
 [IO.File]::WriteAllText((Join-Path $TestRoot 'config\wechatagent.json'),(@{hook=@{expectedVersion='4.1.15.13';wechatExecutable=(Join-Path $TestRoot '..\foreign\Weixin.exe')}} | ConvertTo-Json))
 Assert-Fails {Invoke-ClientPin $TestRoot} 'CLIENT_PIN_SCOPE_REQUIRED'
}finally{
 foreach($pair in @(@{name='client 13';version='4.1.15.13'},@{name='client 10';version='4.1.10.27'},@{name='legacy 10';version='4.1.10.27'})){
  $current=Join-Path $TestRoot ('state\hook\'+$pair.name)
  if(Test-Path -LiteralPath $current){Set-Client $pair.name $pair.version | Out-Null;Invoke-ClientPin $TestRoot -Unlock | Out-Null}
 }
}
'Client protection lifecycle regression passed'
`);
 let output='';
 const exit=await runConsoleCommand({exe:windowsPowerShellExecutable(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe,'-Helper',path.join(root,'scripts/pin-hook-client.ps1'),'-TestRoot',path.join(temporary,'project')]},chunk=>output+=chunk,{timeoutMs:60000});
 assert.equal(exit,0,output);assert.match(output,/protection lifecycle regression passed/);
});
