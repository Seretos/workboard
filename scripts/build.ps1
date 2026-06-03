#requires -Version 5.1
<#
.SYNOPSIS
    Builds Workboard locally - a desktop-installer build that mirrors the
    release pipeline (.github/workflows/release.yml), but for the OS you run it on.

.DESCRIPTION
    Mirrors the pipeline's per-OS build job:
        (optional) stamp version -> npm ci -> npm run build (tsc)
        -> electron-builder --<target> --publish never

    The installer lands in release/ with electron-builder's deterministic
    artifactName: workboard-<version>-<os>.<ext>
    (windows -> .exe, mac -> .dmg, linux -> .AppImage).

    Version handling mirrors the pipeline exactly: package.json ships a
    0.0.0 placeholder and the version is pipeline-owned. If you pass
    -Version, it is stamped into package.json for the build only and
    ALWAYS restored afterwards (never committed) - identical to the CI
    "stamp version (CI only, not committed)" step. Without -Version the
    build uses whatever is in package.json (0.0.0 by default).

.PARAMETER Version
    Optional semver (no leading v), e.g. 0.0.1. Stamped into package.json
    for this build only, then restored. Omit to build with the current
    package.json version.

.PARAMETER Target
    Which OS installer to build: win | mac | linux | current.
    Default 'current' picks the installer for the OS you are on. Note that
    cross-OS targets generally need extra tooling (e.g. wine for win on
    linux/mac; mac builds only run on macOS), just like electron-builder
    everywhere.

.PARAMETER SkipInstall
    Skip dependency installation. Use only when node_modules is already
    present and current; otherwise the build may use stale/missing deps.

.PARAMETER Install
    Force the install step (npm ci) even if node_modules exists. By default
    the script runs npm ci only when node_modules is missing.

.EXAMPLE
    pwsh scripts/build.ps1
    Build an installer for the current OS from the current source state.

.EXAMPLE
    pwsh scripts/build.ps1 -Version 0.0.1
    Build with the version temporarily stamped to 0.0.1 (restored after).

.EXAMPLE
    pwsh scripts/build.ps1 -Target win
    Force a Windows (nsis .exe) installer.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [ValidateSet('win', 'mac', 'linux', 'current')]
    [string]$Target = 'current',
    [switch]$SkipInstall,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# --- Locate repo root (the script lives in <repo>/scripts/) -----------------
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageJson = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path $PackageJson)) {
    throw "package.json not found at '$PackageJson'. Is scripts/build.ps1 still under the repo root?"
}

# --- Resolve target OS for electron-builder ---------------------------------
# Strict-mode-safe: $IsWindows/$IsMacOS/$IsLinux exist only in PowerShell
# Core (6+); on Windows PowerShell 5.1 they are undefined and a direct
# reference would throw under Set-StrictMode. Probe via Get-Variable instead.
function Test-AutoVar([string]$name) {
    $v = Get-Variable -Name $name -ErrorAction SilentlyContinue
    return ($null -ne $v -and $v.Value)
}
if ($Target -eq 'current') {
    if ($env:OS -eq 'Windows_NT' -or (Test-AutoVar 'IsWindows')) { $Target = 'win' }
    elseif (Test-AutoVar 'IsMacOS') { $Target = 'mac' }
    elseif (Test-AutoVar 'IsLinux') { $Target = 'linux' }
    else { throw "Could not detect the current OS; pass -Target win|mac|linux explicitly." }
}
$extByTarget = @{ win = 'exe'; mac = 'dmg'; linux = 'AppImage' }

# --- Validate version (same semver rule as the pipeline) --------------------
if ($Version) {
    if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
        throw "Version '$Version' is not valid semver (expected MAJOR.MINOR.PATCH[-PRERELEASE])."
    }
}

# --- Tool sanity checks -----------------------------------------------------
foreach ($tool in 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "'$tool' was not found on PATH. Install Node.js 20+ and retry."
    }
}

Push-Location $RepoRoot
$stampedSource = $null
try {
    Write-Host "Repo root : $RepoRoot"
    Write-Host "Target    : $Target (.$($extByTarget[$Target]))"
    Write-Host "Node      : $(node --version)"
    Write-Host "npm       : $(npm --version)"

    # --- (optional) Stamp version, CI-style: build-only, always restored ----
    if ($Version) {
        Write-Step "Stamp version $Version into package.json (build-only, will be restored)"
        $stampedSource = Get-Content -Raw -LiteralPath $PackageJson
        # Edit the "version" field textually to preserve formatting/key order.
        $patched = [regex]::Replace(
            $stampedSource,
            '("version"\s*:\s*")[^"]*(")',
            "`${1}$Version`${2}",
            [System.Text.RegularExpressions.RegexOptions]::None,
            [TimeSpan]::FromSeconds(5))
        if ($patched -eq $stampedSource) {
            throw "Could not find a `"version`" field to stamp in package.json."
        }
        Set-Content -LiteralPath $PackageJson -Value $patched -NoNewline -Encoding utf8
        Write-Host "Stamped version $Version"
    }

    # --- Install dependencies (mirror: npm ci) ------------------------------
    $nodeModules = Join-Path $RepoRoot 'node_modules'
    if ($SkipInstall) {
        Write-Step "Skipping dependency install (-SkipInstall)"
        if (-not (Test-Path $nodeModules)) {
            throw "node_modules is missing but -SkipInstall was set. Remove -SkipInstall for the first build."
        }
    }
    elseif ($Install -or -not (Test-Path $nodeModules)) {
        Write-Step "Install dependencies (npm ci)"
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }
    }
    else {
        Write-Step "node_modules present - skipping install (pass -Install to force npm ci)"
    }

    # --- Compile TypeScript (mirror: npm run build / tsc) -------------------
    Write-Step "Compile TypeScript (npm run build)"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }

    # --- Package installer (mirror: electron-builder --<target> --publish never)
    Write-Step "Package installer (electron-builder --$Target --publish never)"
    npx electron-builder "--$Target" --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)." }

    # --- Report artifacts ---------------------------------------------------
    Write-Step "Build complete - artifacts in release/"
    $releaseDir = Join-Path $RepoRoot 'release'
    $ext = $extByTarget[$Target]
    $artifacts = @(Get-ChildItem -LiteralPath $releaseDir -Filter "*.$ext" -ErrorAction SilentlyContinue)
    if ($artifacts.Count -eq 0) {
        Write-Warning "No *.$ext found in release/. Check the electron-builder output above."
    }
    else {
        foreach ($a in $artifacts) {
            Write-Host ("  {0}  ({1:N1} MB)" -f $a.FullName, ($a.Length / 1MB)) -ForegroundColor Green
        }
    }
}
finally {
    # Restore package.json so the stamped version is NEVER left behind / committed.
    if ($null -ne $stampedSource) {
        Set-Content -LiteralPath $PackageJson -Value $stampedSource -NoNewline -Encoding utf8
        Write-Host "`nRestored original package.json (version un-stamped)." -ForegroundColor DarkGray
    }
    Pop-Location
}
