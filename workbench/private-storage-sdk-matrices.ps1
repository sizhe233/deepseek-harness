# Build supplemental test-only SDK fixtures; no production addon or toolchain installation.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Supplemental SDK fixtures require native Windows' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$fixtures = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../packages/storage/private-storage/tests/native'))
New-Item -ItemType Directory -Force -Path $output | Out-Null
$buildRecord = Join-Path $output 'sdk-matrices-build.json'
if (Test-Path -LiteralPath $buildRecord) { throw 'Supplemental build record already exists' }
$compiler = $null
$setupError = $null
try {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installed Visual Studio discovery tool is unavailable' }
  $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installation)) { throw 'Installed Microsoft x64 C compiler is unavailable' }
  $developer = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
  $version = (Get-Content -LiteralPath (Join-Path $installation 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unrecognized installed compiler layout' }
  $compilerPath = [IO.Path]::GetFullPath((Join-Path $installation "VC/Tools/MSVC/$version/bin/Hostx64/x64/cl.exe"))
  $compiler = @{
    name = 'Microsoft cl'; architecture = 'x64'; path = $compilerPath; toolsVersion = $version
    binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compilerPath).Hash.ToLowerInvariant()
    developerScriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $developer).Hash.ToLowerInvariant()
    discoverySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $vswhere).Hash.ToLowerInvariant()
  }
} catch { $setupError = $_.Exception.Message }
$targets = @(
  @{ name = 'admission'; source = 'windows-admission-oracle.c'; binary = 'private-storage-admission-oracle.exe'; options = '' },
  @{ name = 'inheritance-library'; source = 'boundary-inheritance.c'; binary = 'boundary-inheritance.dll'; options = '/LD /DDSH_FIXTURE_DLL' },
  @{ name = 'inheritance-child'; source = 'boundary-inheritance.c'; binary = 'boundary-inheritance-child.exe'; options = '' }
)
$records = @()
foreach ($target in $targets) {
  $record = @{
    name = $target.name; source = $target.source; binary = $target.binary; complete = $false
    sourceSha256 = $null; sourceUnchanged = $false; exitCode = $null; binarySha256 = $null
    compilerLog = $null; compilerLogSha256 = $null; producedBinarySha256 = $null
  }
  $binary = $null
  $log = $null
  $outputsAdmitted = $false
  try {
    if ($setupError) { throw $setupError }
    $source = Join-Path $fixtures $target.source
    $binary = Join-Path $output $target.binary
    $object = Join-Path $output ($target.name + '.obj')
    $log = Join-Path $output ($target.name + '-compiler.log')
    foreach ($path in @($binary, $object, $log)) {
      if (Test-Path -LiteralPath $path) { throw "Fixture output already exists: $path" }
    }
    $outputsAdmitted = $true
    $record.sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    # C4191 is the test oracle's documented GetProcAddress-to-native-signature cast.
    $command = "`"$developer`" -no_logo -arch=x64 -host_arch=x64 && set CL= && set _CL_= && set LINK= && set _LINK_= && `"$compilerPath`" /nologo /Bv /std:c17 /W4 /WX /wd4191 /TC /DUNICODE /D_UNICODE $($target.options) `"$source`" /Fo`"$object`" /Fe`"$binary`" /link Advapi32.lib && set WindowsSDK"
    & $env:ComSpec /d /s /c "`"$command`"" 2>&1 | Tee-Object -FilePath $log
    $record.exitCode = $LASTEXITCODE
    $record.compilerLog = [IO.Path]::GetFileName($log)
    $record.compilerLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $log).Hash.ToLowerInvariant()
    $record.sourceUnchanged = $record.sourceSha256 -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    if ($record.exitCode -ne 0) { throw "Compiler exited $($record.exitCode)" }
    if (-not $record.sourceUnchanged) { throw 'Fixture source changed during compilation' }
    if ($compiler.binarySha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $compilerPath).Hash.ToLowerInvariant()) { throw 'Installed compiler changed during compilation' }
    if ($compiler.developerScriptSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $developer).Hash.ToLowerInvariant()) { throw 'Developer environment script changed during compilation' }
    $record.binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()
    $record.complete = $true
  } catch { $record.error = $_.Exception.Message }
  finally {
    if ($outputsAdmitted) {
      try {
        if (Test-Path -LiteralPath $binary -PathType Leaf) { $record.producedBinarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant() }
        if (Test-Path -LiteralPath $log -PathType Leaf) {
          $record.compilerLog = [IO.Path]::GetFileName($log)
          $record.compilerLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $log).Hash.ToLowerInvariant()
        }
      } catch { $record.complete = $false; $record.observationError = $_.Exception.Message }
    }
  }
  $records += $record
}
$complete = @($records | Where-Object { -not $_.complete }).Count -eq 0
@{ schemaVersion = 1; compiler = $compiler; architecture = 'x64'; complete = $complete; fixtures = $records } |
  ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $buildRecord -Encoding utf8NoBOM
if (-not $complete) { throw 'One or more supplemental SDK fixtures failed; every independent target result was retained' }
