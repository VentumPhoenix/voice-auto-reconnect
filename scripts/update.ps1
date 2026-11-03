<#
.SYNOPSIS
    Updates Vencord and the VoiceAutoReconnect plugin, builds Vencord and injects it into Discord.

.DESCRIPTION
    1. Pulls the latest version of this plugin repository (if it is a git checkout).
    2. Clones Vencord into -VencordDir, or pulls the latest main if it already exists.
    3. Copies src/voiceAutoReconnect into Vencord/src/userplugins/voiceAutoReconnect.
    4. Runs pnpm install, pnpm build and (unless -NoInject) pnpm inject.

    Requires git, Node.js >= 22 and pnpm (https://pnpm.io/installation) on PATH.
    Works with Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
    .\scripts\update.ps1
.EXAMPLE
    .\scripts\update.ps1 -VencordDir D:\src\Vencord -NoInject
#>
[CmdletBinding()]
param(
    [string]$VencordDir = (Join-Path $HOME "Vencord"),
    [switch]$NoInject,
    [switch]$SkipPluginPull
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$WorkDir = (Get-Location).Path)
    Write-Host "> $Exe $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location $WorkDir
    # Windows PowerShell 5.1 turns native stderr output (progress messages of git/pnpm) into
    # errors when output is redirected, so rely on the exit code only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Exe @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
    if ($code -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed with exit code $code" }
}

foreach ($tool in "git", "node", "pnpm") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "'$tool' was not found on PATH. Install it first (see README)."
    }
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginSrc = Join-Path $RepoRoot "src\voiceAutoReconnect"

if (-not $SkipPluginPull -and (Test-Path (Join-Path $RepoRoot ".git"))) {
    Write-Host "Updating plugin repository..." -ForegroundColor Cyan
    Invoke-Native git @("pull", "--ff-only") $RepoRoot
}

if (Test-Path (Join-Path $VencordDir ".git")) {
    Write-Host "Updating Vencord in $VencordDir..." -ForegroundColor Cyan
    Invoke-Native git @("pull", "--ff-only") $VencordDir
} else {
    Write-Host "Cloning Vencord into $VencordDir..." -ForegroundColor Cyan
    Invoke-Native git @("clone", "https://github.com/Vendicated/Vencord.git", $VencordDir)
}

$PluginDst = Join-Path $VencordDir "src\userplugins\voiceAutoReconnect"
Write-Host "Copying plugin to $PluginDst..." -ForegroundColor Cyan
if (Test-Path $PluginDst) { Remove-Item -Recurse -Force $PluginDst }
New-Item -ItemType Directory -Force (Split-Path -Parent $PluginDst) | Out-Null
Copy-Item -Recurse $PluginSrc $PluginDst

Write-Host "Installing dependencies and building Vencord..." -ForegroundColor Cyan
Invoke-Native pnpm @("install", "--frozen-lockfile") $VencordDir
Invoke-Native pnpm @("build") $VencordDir

if ($NoInject) {
    Write-Host "Build finished. Skipped injection (-NoInject). Restart Discord to load the new build." -ForegroundColor Green
} else {
    Write-Host "Injecting Vencord (the installer will ask which Discord install to patch)..." -ForegroundColor Cyan
    Invoke-Native pnpm @("inject") $VencordDir
    Write-Host "Done. Fully restart Discord, then enable VoiceAutoReconnect in Settings > Vencord > Plugins." -ForegroundColor Green
}
