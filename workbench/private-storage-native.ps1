# Compile the test-only oracle using the installed Microsoft SDK; never install a toolchain.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'The private-storage oracle requires native Windows, not Wine or a mocked platform' }
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../packages/storage/private-storage/tests/native/windows-oracle.c'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installed Visual Studio discovery tool is unavailable; no toolchain was downloaded' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installation)) { throw 'Installed Microsoft x64 C compiler is unavailable' }
$developer = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
$version = (Get-Content -LiteralPath (Join-Path $installation 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unrecognized installed compiler layout' }
$compilerPath = [IO.Path]::GetFullPath((Join-Path $installation "VC/Tools/MSVC/$version/bin/Hostx64/x64/cl.exe"))
$compilerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compilerPath).Hash.ToLowerInvariant()
$developerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $developer).Hash.ToLowerInvariant()
$sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
$binary = Join-Path $output 'private-storage-oracle.exe'
$object = Join-Path $output 'private-storage-oracle.obj'
# C4191 is the documented GetProcAddress-to-native-signature cast, used only in this test executable.
$command = "`"$developer`" -no_logo -arch=x64 -host_arch=x64 && set CL= && set _CL_= && set LINK= && set _LINK_= && `"$compilerPath`" /nologo /Bv /std:c17 /W4 /WX /wd4191 /TC /DUNICODE /D_UNICODE `"$source`" /Fo`"$object`" /Fe`"$binary`" /link Advapi32.lib && set WindowsSDK"
$compilerLog = Join-Path $output 'compiler.log'
& $env:ComSpec /d /s /c "`"$command`"" 2>&1 | Tee-Object -FilePath $compilerLog
if ($LASTEXITCODE -ne 0) { throw "Oracle compilation failed with exit $LASTEXITCODE" }
if ($compilerSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $compilerPath).Hash.ToLowerInvariant()) { throw 'Installed compiler changed during compilation' }
if ($developerSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $developer).Hash.ToLowerInvariant()) { throw 'Developer environment script changed during compilation' }
if ($sourceSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()) { throw 'Oracle source changed during compilation' }
$binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()
& $binary abi | Set-Content -LiteralPath (Join-Path $output 'sdk-abi.json') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw 'Compiled SDK ABI oracle failed' }
if ($binarySha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()) { throw 'Oracle binary changed during ABI observation' }
@{
  compiler = 'Microsoft cl (installed Visual Studio)'
  architecture = 'x64'
  compilerPath = $compilerPath
  compilerSha256 = $compilerSha256
  developerScriptSha256 = $developerSha256
  toolsVersion = $version
  compilerLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compilerLog).Hash.ToLowerInvariant()
  sourceSha256 = $sourceSha256
  binarySha256 = $binarySha256
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'oracle-build.json') -Encoding utf8NoBOM
Write-Output $binary
