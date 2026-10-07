# Build only the source-instrumented test fixture against an already verified official Node SDK.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$NodeSdk
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Owner fault fixture requires native Windows x64 and the Windows SDK' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
$sdk = [IO.Path]::GetFullPath($NodeSdk)
foreach ($path in @($root, $output, $sdk)) {
  if ($path -match '[&|<>^%!\r\n"]') { throw 'Build paths must not contain command interpreter metacharacters' }
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
$recordPath = Join-Path $output 'owner-fault-build.json'
$binary = Join-Path $output 'owner-fault-fixture.node'
$log = Join-Path $output 'owner-fault-compiler.log'
$dependencies = Join-Path $output 'owner-fault-dependencies.json'
$commandFile = Join-Path $output 'owner-fault-build.cmd'
$discoveryCommand = Join-Path $output 'owner-fault-discover.cmd'
$discoveryDependencies = Join-Path $output 'owner-fault-discovery.json'
$discoveryLog = Join-Path $output 'owner-fault-discovery.log'
$librarySearch = Join-Path $output 'owner-fault-library-search.txt'
foreach ($path in @($recordPath, $binary, $log, $dependencies, $commandFile, $discoveryCommand,
  $discoveryDependencies, $discoveryLog, $librarySearch, (Join-Path $output 'owner-fault.obj'))) {
  if (Test-Path -LiteralPath $path) { throw "Build output already exists: $path" }
}
function Hash([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
$record = [ordered]@{ schemaVersion = 1; evidence = 'source-instrumented-native-owner-faults'; platform = 'win32'; architecture = 'x64';
  complete = $false; sourceUnchanged = $false; compilerInputsComplete = $false; exitCode = $null; binary = 'owner-fault-fixture.node' }
try {
  $nodeInfo = & node -p 'JSON.stringify({version:process.version,arch:process.arch})' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $nodeInfo.arch -ne 'x64') { throw 'Run with native Windows x64 Node' }
  $record.nodeVersion = $nodeInfo.version
  $record.nodeSdk = $sdk
  $receiptPath = Join-Path $sdk 'verified.json'
  $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
  if ($receipt.version -ne $nodeInfo.version -or $receipt.architecture -ne 'x64' -or $receipt.source -ne "https://nodejs.org/dist/$($nodeInfo.version)/") { throw 'Official Node SDK receipt differs from running Node' }
  $nodeLib = Join-Path $sdk 'node.lib'
  if (@($receipt.files | Where-Object { $_.name -eq 'win-x64/node.lib' -and $_.sha256 -eq (Hash $nodeLib) }).Count -ne 1) { throw 'Official Node import library checksum differs' }
  $archive = Join-Path $sdk 'headers.tar.gz'
  if (@($receipt.files | Where-Object { $_.name -eq "node-$($nodeInfo.version)-headers.tar.gz" -and $_.sha256 -eq (Hash $archive) }).Count -ne 1) { throw 'Official Node headers archive checksum differs' }
  $bindingModule = Join-Path $root 'packages/storage/private-storage/tests/native/owner-fault-support.mjs'
  $binding = & node --input-type=module -e 'import {pathToFileURL} from "node:url"; const m=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(m.ownerSourceBinding()))' $bindingModule | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Production or fixture source identity check failed' }
  $record.productionSourceSha256 = $binding.productionSourceSha256
  $record.fixtureSources = $binding.fixtureSources
  $record.fixtureSourceSha256 = $binding.fixtureSourceSha256
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installation)) { throw 'Installed Microsoft x64 C compiler unavailable' }
  $developer = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
  $version = (Get-Content -Raw -LiteralPath (Join-Path $installation 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')).Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unrecognized compiler layout' }
  $binDirectory = Join-Path $installation "VC/Tools/MSVC/$version/bin/Hostx64/x64"
  $compiler = Join-Path $binDirectory 'cl.exe'
  $source = Join-Path $root 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'
  $arguments = @('/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8', '/D_WIN32_WINNT=0x0602',
    "/I$(Join-Path $sdk 'include/node')", '/sourceDependencies', $dependencies, "/Fo$(Join-Path $output 'owner-fault.obj')", $source,
    '/link', '/VERBOSE:LIB', "/OUT:$binary", "/IMPLIB:$(Join-Path $output 'owner-fault.lib')", $nodeLib, 'kernel32.lib', 'advapi32.lib')
  $record.compiler = @{ path = $compiler; binarySha256 = (Hash $compiler); developerScript = $developer;
    developerScriptSha256 = (Hash $developer); discoverySha256 = (Hash $vswhere); toolsVersion = $version; arguments = $arguments }
  # Compiler environment options are cleared; the retained command and SDK/compiler identities bind every option.
  $quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  @('@echo off', "call `"$developer`" -no_logo -arch=x64 -host_arch=x64", 'if errorlevel 1 exit /b %errorlevel%',
    'set CL=', 'set _CL_=', 'set LINK=', 'set _LINK_=', 'set VSLANG=1033', "`"$compiler`" $quoted", 'exit /b %errorlevel%') |
    Set-Content -LiteralPath $commandFile -Encoding ascii
  $discoveryArguments = @('/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8',
    '/D_WIN32_WINNT=0x0602', "/I$(Join-Path $sdk 'include/node')", '/Zs', '/sourceDependencies', $discoveryDependencies, $source)
  $discoveryQuoted = ($discoveryArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  @('@echo off', "call `"$developer`" -no_logo -arch=x64 -host_arch=x64", 'if errorlevel 1 exit /b %errorlevel%',
    'set CL=', 'set _CL_=', 'set LINK=', 'set _LINK_=', 'set VSLANG=1033', "`"$compiler`" $discoveryQuoted",
    'if errorlevel 1 exit /b %errorlevel%', "set LIB > `"$librarySearch`"", 'exit /b 0') |
    Set-Content -LiteralPath $discoveryCommand -Encoding ascii
  & $env:ComSpec /d /c $discoveryCommand 2>&1 | Tee-Object -FilePath $discoveryLog
  if ($LASTEXITCODE -ne 0) { throw "Compiler dependency discovery failed: $LASTEXITCODE" }
  $discovered = Get-Content -Raw -LiteralPath $discoveryDependencies | ConvertFrom-Json
  if (@($discovered.Data.Includes).Count -lt 5) { throw 'Discovery did not enumerate included headers' }
  $beforePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($path in @($source, (Join-Path $root 'native/system/packages/entry/src/windows-private-owner.c'), $nodeLib,
    $receiptPath, $archive, $commandFile, $discoveryCommand, $developer, $vswhere) + @($discovered.Data.Includes)) {
    [void]$beforePaths.Add([IO.Path]::GetFullPath($path))
  }
  $search = (Get-Content -Raw -LiteralPath $librarySearch).Trim()
  if (-not $search.StartsWith('LIB=', [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved library search path is unavailable' }
  foreach ($directory in $search.Substring(4).Split(';', [StringSplitOptions]::RemoveEmptyEntries)) {
    if (-not [IO.Path]::IsPathFullyQualified($directory) -or -not (Test-Path -LiteralPath $directory -PathType Container)) {
      throw "Library search directory is not admitted: $directory"
    }
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Filter '*.lib') { [void]$beforePaths.Add($file.FullName) }
  }
  foreach ($file in Get-ChildItem -LiteralPath $binDirectory -File | Where-Object { $_.Extension -in @('.exe', '.dll') }) {
    [void]$beforePaths.Add($file.FullName)
  }
  if ($beforePaths.Count -gt 10000) { throw 'Compiler input inventory exceeds its fixed bound' }
  $inputBytes = 0L
  $before = @{}
  foreach ($path in $beforePaths) {
    $file = Get-Item -LiteralPath $path
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.PSIsContainer) { throw "Compiler input is not a regular file: $path" }
    $inputBytes += $file.Length
    if ($inputBytes -gt 2147483648L) { throw 'Compiler input bytes exceed their fixed bound' }
    $before[$path] = Hash $path
  }
  $record.discoveryArguments = $discoveryArguments
  $record.discoveryDependenciesSha256 = Hash $discoveryDependencies
  $record.discoveryLogSha256 = Hash $discoveryLog
  $record.librarySearchSha256 = Hash $librarySearch
  $record.inputsBeforeCompilation = @($before.Keys | Sort-Object | ForEach-Object { @{ path = $_; sha256 = $before[$_] } })
  & $env:ComSpec /d /c $commandFile 2>&1 | Tee-Object -FilePath $log
  $record.exitCode = $LASTEXITCODE
  $record.compilerLogSha256 = Hash $log
  if ($record.exitCode -ne 0) { throw "C compiler failed with exit $($record.exitCode); log retained" }
  $inputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($path in @($source, (Join-Path $root 'native/system/packages/entry/src/windows-private-owner.c'), $nodeLib, $receiptPath, $archive, $commandFile, $developer, $vswhere)) { [void]$inputs.Add([IO.Path]::GetFullPath($path)) }
  $dependencyRecord = Get-Content -Raw -LiteralPath $dependencies | ConvertFrom-Json
  foreach ($path in $dependencyRecord.Data.Includes) { [void]$inputs.Add([IO.Path]::GetFullPath($path)) }
  if (@($dependencyRecord.Data.Includes).Count -lt 5) { throw 'Compiler did not enumerate its actual included headers' }
  # /VERBOSE:LIB emits resolved absolute import/static-library paths in the retained English log.
  $libraries = [regex]::Matches((Get-Content -Raw -LiteralPath $log), '(?im)^\s*Searching\s+([A-Z]:\\[^\r\n]+\.lib):\s*$')
  if ($libraries.Count -lt 3) { throw 'Resolved linker library inventory missing from compiler log' }
  foreach ($match in $libraries) { [void]$inputs.Add([IO.Path]::GetFullPath($match.Groups[1].Value)) }
  foreach ($file in Get-ChildItem -LiteralPath $binDirectory -File | Where-Object { $_.Extension -in @('.exe', '.dll') }) { [void]$inputs.Add($file.FullName) }
  foreach ($path in $inputs) {
    if (-not $before.ContainsKey($path)) { throw "Compiler used an input absent from precompile admission: $path" }
    if ((Hash $path) -ne $before[$path]) { throw "Compiler input changed during compilation: $path" }
  }
  $record.inputs = @($inputs | Sort-Object | ForEach-Object { @{ path = $_; sha256 = $before[$_] } })
  $record.dependenciesSha256 = Hash $dependencies
  $record.compilerInputsComplete = $true
  $after = & node --input-type=module -e 'import {pathToFileURL} from "node:url"; const m=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(m.ownerSourceBinding()))' $bindingModule | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $after.fixtureSourceSha256 -ne $record.fixtureSourceSha256 -or $after.productionSourceSha256 -ne $record.productionSourceSha256) { throw 'Source changed while compiling' }
  if ((Hash $compiler) -ne $record.compiler.binarySha256 -or (Hash $developer) -ne $record.compiler.developerScriptSha256) { throw 'Compiler changed while compiling' }
  $record.sourceUnchanged = $true
  $record.binarySha256 = Hash $binary
  $record.complete = $true
} catch { $record.error = $_.Exception.Message }
finally {
  if (Test-Path -LiteralPath $log -PathType Leaf) { $record.compilerLogSha256 = Hash $log }
  if (Test-Path -LiteralPath $binary -PathType Leaf) { $record.producedBinarySha256 = Hash $binary }
  $record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
}
if (-not $record.complete) { throw "Source-instrumented fixture build incomplete: $($record.error)" }
Write-Output $binary
