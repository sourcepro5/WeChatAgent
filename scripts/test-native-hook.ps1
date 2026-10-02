$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $root 'state\hook\probe'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
$taskProject = @'
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Release|x64"><Configuration>Release</Configuration><Platform>x64</Platform></ProjectConfiguration></ItemGroup>
  <PropertyGroup><Configuration>Release</Configuration><Platform>x64</Platform><WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion></PropertyGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.Default.props" />
  <PropertyGroup Label="Configuration"><ConfigurationType>Application</ConfigurationType><PlatformToolset>v143</PlatformToolset><CharacterSet>Unicode</CharacterSet></PropertyGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.props" />
  <PropertyGroup><OutDir>$(ProjectDir)</OutDir><IntDir>$(ProjectDir)obj\</IntDir><TargetName>probe</TargetName></PropertyGroup>
  <ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>$(ProjectDir)..\..\..\scripts\native-hook;$(ProjectDir)..\build-source\include;$(ProjectDir)..\build-source\3rdparty;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories><LanguageStandard>stdcpp20</LanguageStandard><AdditionalOptions>/utf-8 %(AdditionalOptions)</AdditionalOptions><ExceptionHandling>Async</ExceptionHandling></ClCompile><Link><AdditionalDependencies>version.lib;ws2_32.lib;%(AdditionalDependencies)</AdditionalDependencies><SubSystem>Console</SubSystem></Link></ItemDefinitionGroup>
  <ItemGroup><ClCompile Include="..\..\..\scripts\native-hook\probe.cpp" /><ClCompile Include="..\..\..\scripts\native-hook\wechatagent_hook.cpp" /></ItemGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.targets" />
</Project>
'@
$project = Join-Path $directory 'probe.vcxproj'
[IO.File]::WriteAllText($project,$taskProject,$encoding)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msbuild = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1)
& $msbuild $project /m /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw 'Native probe build failed.' }
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
& $config.runtime.python (Join-Path $PSScriptRoot 'test-native-hook.py')
if ($LASTEXITCODE -ne 0) { throw 'Native HTTP boundary checks failed.' }
