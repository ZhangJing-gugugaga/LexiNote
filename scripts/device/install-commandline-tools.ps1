# Installs HarmonyOS command-line-tools (windows x64) onto a non-C drive.
# Layout produced: <InstallRoot>\command-line-tools\{bin, sdk\default\..., tool\node}
# Usage: powershell -File scripts\device\install-commandline-tools.ps1 [-ArchivePath <zip>] [-InstallRoot E:\dev-tools\harmonyos]
param(
    [string]$ArchivePath,
    [string]$InstallRoot = 'E:\dev-tools\harmonyos',
    [string]$Sha256
)

$ErrorActionPreference = 'Stop'

function Test-ExtractedToolRoot([string]$Path) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path 'bin') -PathType Container)) { return $false }
    foreach ($marker in @('ohpm.bat', 'ohpm.cmd', 'ohpm.exe', 'sdkmgr.bat', 'sdkmgr.cmd', 'sdkmgr.exe', 'hvigorw.bat')) {
        if (Test-Path -LiteralPath (Join-Path (Join-Path $Path 'bin') $marker)) { return $true }
    }
    return $false
}

if (-not $ArchivePath) {
    $searchRoots = @('E:\dev-tools\downloads', (Join-Path $env:USERPROFILE 'Downloads'))
    $candidates = @()
    foreach ($root in $searchRoots) {
        if (Test-Path -LiteralPath $root) {
            $candidates += Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^(commandline-tools|command-line-tools).*windows.*\.zip$' } |
                Sort-Object LastWriteTime -Descending
        }
    }
    if ($candidates.Count -gt 0) { $ArchivePath = $candidates[0].FullName }
}
if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath)) {
    throw "未找到 commandline-tools windows zip,请用 -ArchivePath 指定"
}

$archive = Get-Item -LiteralPath $ArchivePath
$actualHash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Archive: $($archive.FullName)"
Write-Host "SHA256:  $actualHash"
if ($Sha256 -and $actualHash -ne $Sha256.Trim().ToLowerInvariant()) { throw 'SHA-256 校验失败' }

$finalRoot = Join-Path $InstallRoot 'command-line-tools'
if (Test-Path -LiteralPath $finalRoot) { throw "已存在: $finalRoot (确认后请手动移除再装)" }
$stage = Join-Path $InstallRoot ('.install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host '解压中,可能需要数分钟...'
Expand-Archive -LiteralPath $archive.FullName -DestinationPath $stage -Force

$extractedRoot = $null
if (Test-ExtractedToolRoot $stage) { $extractedRoot = $stage }
else {
    $direct = Join-Path $stage 'command-line-tools'
    if (Test-ExtractedToolRoot $direct) { $extractedRoot = $direct }
    else {
        foreach ($dir in (Get-ChildItem -LiteralPath $stage -Directory -Recurse -ErrorAction SilentlyContinue)) {
            if (Test-ExtractedToolRoot $dir.FullName) { $extractedRoot = $dir.FullName; break }
        }
    }
}
if (-not $extractedRoot) { throw '压缩包内未找到 command-line-tools/bin 目录' }

New-Item -ItemType Directory -Path (Split-Path $finalRoot) -Force | Out-Null
Move-Item -LiteralPath $extractedRoot -Destination $finalRoot
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

# Locate embedded pieces and report env wiring
$bin = Join-Path $finalRoot 'bin'
$sdkRoot = $null
foreach ($candidate in @(
    (Join-Path $finalRoot 'sdk'),
    (Join-Path $finalRoot 'sdk\default')
)) {
    if (Test-Path -LiteralPath $candidate) { $sdkRoot = $candidate; break }
}
$hdc = Get-ChildItem -LiteralPath $finalRoot -Recurse -Filter 'hdc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
$hvigorw = Get-ChildItem -LiteralPath $bin -Filter 'hvigorw*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
$node = Get-ChildItem -LiteralPath $finalRoot -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName

Write-Host "`n=== 安装完成 ==="
Write-Host "root:    $finalRoot"
Write-Host "hdc:     $hdc"
Write-Host "hvigorw: $hvigorw"
Write-Host "node:    $node"
Write-Host "sdk:     $sdkRoot"
Write-Host @"

将以下内容写入项目 scripts/device/device-env.local.ps1 或系统环境变量(用户级,不落 C 盘程序目录):
  DEVECO_SDK_HOME = $sdkRoot
  HDC_HOME        = $(if ($hdc) { Split-Path $hdc } else { '<toolchains dir>' })
  PATH += $bin ; $(if ($hdc) { Split-Path $hdc })
"@
