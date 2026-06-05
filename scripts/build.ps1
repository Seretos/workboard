#requires -Version 5.1
<#
.SYNOPSIS
    Builds Workboard locally - a desktop-installer build that mirrors the
    release pipeline (.github/workflows/release.yml), but for the OS you run it on.

.DESCRIPTION
    Mirrors the pipeline's per-OS build job, in order:
        1. (optional) stamp version into package.json (build-only, restored)
        2. build the Python backend into a standalone binary with PyInstaller
           -> backend-bin/<artifact_os>/workboard-backend[.exe]
        3. npm ci
        4. npm run build (tsc, frontend/tsconfig.json)
        5. electron-builder --<target> --publish never
           (embeds the backend binary via extraResources)

    The installer lands in release/ with electron-builder's deterministic
    artifactName: workboard-<version>-<os>.<ext>
    (windows -> .exe, mac -> .dmg, linux -> .AppImage).

    The end-user installer is self-contained: the Python backend is bundled
    as a binary, so users need no Python. Building locally, however, DOES
    require Python (3.12 in CI) + Node 20+ on the build machine - same as the
    CI runners. The Python deps + PyInstaller are installed into an isolated
    venv (.venv-build/, git-ignored) so your global Python stays clean.

    Version handling mirrors the pipeline: package.json ships a 0.0.0
    placeholder and the version is pipeline-owned. -Version stamps it for the
    build only and ALWAYS restores it afterwards (never committed).

.PARAMETER Version
    Optional semver (no leading v), e.g. 0.0.1. Stamped into package.json for
    this build only, then restored. Omit to build with the current version.

.PARAMETER Target
    Which OS installer to build: win | mac | linux | current.
    Default 'current' picks the installer for the OS you are on. Cross-OS
    targets need extra tooling (wine for win on linux/mac; mac only on macOS).

.PARAMETER SkipBackend
    Skip the Python backend build and reuse an existing backend-bin/<os>/
    binary. Fails if the binary is missing.

.PARAMETER SkipInstall
    Skip dependency installation (npm + pip). Use only when node_modules and
    the .venv-build venv are already present and current.

.PARAMETER Install
    Force dependency (re)installation (npm ci + pip install) even if
    node_modules / .venv-build already exist.

.EXAMPLE
    pwsh scripts/build.ps1
    Build an installer for the current OS from the current source state.

.EXAMPLE
    pwsh scripts/build.ps1 -Version 0.0.1
    Build with the version temporarily stamped to 0.0.1 (restored after).

.EXAMPLE
    pwsh scripts/build.ps1 -Target win -SkipBackend
    Repackage the Windows installer reusing a previously built backend binary.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [ValidateSet('win', 'mac', 'linux', 'current')]
    [string]$Target = 'current',
    [switch]$SkipBackend,
    [switch]$SkipInstall,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# Run a native command (node/npm/python/pyinstaller/...) and treat ONLY a
# non-zero exit code as failure. Native tools routinely write progress/INFO to
# stderr (PyInstaller and npm especially); under $ErrorActionPreference='Stop'
# a captured/redirected stderr line is turned into a terminating
# NativeCommandError, which would abort a perfectly healthy build. We drop to
# 'Continue' for the duration of the call and gate on $LASTEXITCODE instead.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$What,
        [Parameter(Mandatory)][scriptblock]$Action
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Action }
    finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

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
$onWindows = ($env:OS -eq 'Windows_NT') -or (Test-AutoVar 'IsWindows')
if ($Target -eq 'current') {
    if ($onWindows) { $Target = 'win' }
    elseif (Test-AutoVar 'IsMacOS') { $Target = 'mac' }
    elseif (Test-AutoVar 'IsLinux') { $Target = 'linux' }
    else { throw "Could not detect the current OS; pass -Target win|mac|linux explicitly." }
}

# Map the electron-builder target to the matching backend-bin/<os> folder and
# binary name (must line up with package.json build.<os>.extraResources.from).
$osMeta = @{
    win   = @{ ext = 'exe';      artifact_os = 'windows'; backend = 'workboard-backend.exe' }
    mac   = @{ ext = 'dmg';      artifact_os = 'mac';     backend = 'workboard-backend'     }
    linux = @{ ext = 'AppImage'; artifact_os = 'linux';   backend = 'workboard-backend'     }
}
$meta = $osMeta[$Target]

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
# Resolve a Python launcher (only needed when building the backend).
$python = $null
if (-not $SkipBackend) {
    foreach ($cand in 'python', 'python3', 'py') {
        if (Get-Command $cand -ErrorAction SilentlyContinue) { $python = $cand; break }
    }
    if (-not $python) {
        throw "Python was not found on PATH (needed to build the backend; CI uses 3.12). Install Python 3.12+, or pass -SkipBackend to reuse an existing backend-bin binary."
    }
}

Push-Location $RepoRoot
$stampedSource = $null
try {
    Write-Host "Repo root : $RepoRoot"
    Write-Host "Target    : $Target (.$($meta.ext), backend-bin/$($meta.artifact_os)/$($meta.backend))"
    Write-Host "Node      : $(node --version)"
    Write-Host "npm       : $(npm --version)"
    if ($python) { Write-Host "Python    : $(& $python --version)" }

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

    # --- Build the Python backend binary (mirror: PyInstaller stage) --------
    $backendDir = Join-Path $RepoRoot 'backend'
    $backendOut = Join-Path $RepoRoot "backend-bin/$($meta.artifact_os)/$($meta.backend)"
    if ($SkipBackend) {
        Write-Step "Skipping backend build (-SkipBackend)"
        if (-not (Test-Path $backendOut)) {
            throw "Backend binary not found at '$backendOut' but -SkipBackend was set. Build it first (drop -SkipBackend)."
        }
    }
    else {
        # Isolated venv so the global Python install stays clean.
        $venv = Join-Path $RepoRoot '.venv-build'
        $venvPython = if ($onWindows) { Join-Path $venv 'Scripts\python.exe' } else { Join-Path $venv 'bin/python' }
        $freshVenv = $false
        if (-not (Test-Path $venvPython)) {
            Write-Step "Create build venv (.venv-build)"
            Invoke-Native 'python -m venv' { & $python -m venv $venv }
            $freshVenv = $true
        }
        if ($SkipInstall -and -not $freshVenv) {
            Write-Step "Skipping backend dependency install (-SkipInstall)"
        }
        elseif ($freshVenv -or $Install) {
            Write-Step "Install backend deps + PyInstaller (pip)"
            Invoke-Native 'pip upgrade' { & $venvPython -m pip install --upgrade pip }
            Invoke-Native 'pip install (backend deps + PyInstaller)' {
                & $venvPython -m pip install -r (Join-Path $backendDir 'requirements.txt') pyinstaller
            }
        }
        else {
            # Build venv present and no explicit -Install. Don't blindly trust
            # it: a venv created before requirements changed (or one where an
            # earlier git install failed) can be missing the domain libs. That
            # silently yields a backend binary which crashes at runtime with
            # "ModuleNotFoundError: No module named 'lib_python_projects'"
            # (exit 1 before the BACKEND_PORT handshake). Verify the runtime
            # deps actually import before trusting the cache.
            Write-Step "Verify build venv has backend deps"
            & $venvPython -c "import lib_python_projects, lib_python_config, ruamel.yaml, PyInstaller" 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Build venv satisfies backend deps - skipping pip install (pass -Install to force a refresh)"
            }
            else {
                Write-Step "Build venv is missing backend deps - installing (stale venv)"
                Invoke-Native 'pip upgrade' { & $venvPython -m pip install --upgrade pip }
                Invoke-Native 'pip install (backend deps + PyInstaller)' {
                    & $venvPython -m pip install -r (Join-Path $backendDir 'requirements.txt') pyinstaller
                }
            }
        }

        Write-Step "Build backend binary (PyInstaller -> backend-bin/$($meta.artifact_os))"
        # Run from backend/ exactly like the pipeline:
        #   pyinstaller workboard-backend.spec --distpath ../backend-bin/<os>
        Push-Location $backendDir
        try {
            Invoke-Native 'PyInstaller' {
                & $venvPython -m PyInstaller 'workboard-backend.spec' `
                    --distpath "../backend-bin/$($meta.artifact_os)" `
                    --workpath '../.venv-build/pyi-work' `
                    --noconfirm
            }
        }
        finally { Pop-Location }

        if (-not (Test-Path $backendOut)) {
            throw "PyInstaller finished but '$backendOut' is missing. Check the spec / output above."
        }
        Write-Host "Backend binary: $backendOut" -ForegroundColor Green
    }

    # --- Install frontend dependencies (mirror: npm ci) ---------------------
    $nodeModules = Join-Path $RepoRoot 'node_modules'
    if ($SkipInstall) {
        Write-Step "Skipping npm install (-SkipInstall)"
        if (-not (Test-Path $nodeModules)) {
            throw "node_modules is missing but -SkipInstall was set. Remove -SkipInstall for the first build."
        }
    }
    elseif ($Install -or -not (Test-Path $nodeModules)) {
        Write-Step "Install frontend dependencies (npm ci)"
        Invoke-Native 'npm ci' { npm ci }
    }
    else {
        Write-Step "node_modules present - skipping install (pass -Install to force npm ci)"
    }

    # --- Compile TypeScript (mirror: npm run build / tsc) -------------------
    Write-Step "Compile TypeScript (npm run build)"
    Invoke-Native 'npm run build' { npm run build }

    # --- Package installer (mirror: electron-builder --<target> --publish never)
    Write-Step "Package installer (electron-builder --$Target --publish never)"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        npx electron-builder "--$Target" --publish never 2>&1 | Tee-Object -Variable ebOut
    }
    finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) {
        # On Windows, electron-builder downloads a "winCodeSign" tool bundle that
        # contains macOS symlinks; extracting them needs the symlink privilege.
        # Without Developer Mode / elevation, 7-Zip fails and the build aborts.
        # Turn that cryptic dump into an actionable hint.
        if (($ebOut | Out-String) -match 'Cannot create symbolic link') {
            throw @"
electron-builder could not extract its 'winCodeSign' cache: creating symbolic
links on Windows requires a privilege your account lacks. Apply ONE of these
(one-time), then re-run the build:
  * Enable Developer Mode: Settings > Privacy & Security > For Developers >
    Developer Mode = On  (recommended; no per-build elevation), OR
  * Run the build from an elevated (Administrator) PowerShell.
Once winCodeSign extracts successfully once, it is cached for later builds.
"@
        }
        throw "electron-builder --$Target failed (exit $LASTEXITCODE)."
    }

    # --- Report artifacts ---------------------------------------------------
    Write-Step "Build complete - artifacts in release/"
    $releaseDir = Join-Path $RepoRoot 'release'
    $artifacts = @(Get-ChildItem -LiteralPath $releaseDir -Filter "*.$($meta.ext)" -ErrorAction SilentlyContinue)
    if ($artifacts.Count -eq 0) {
        Write-Warning "No *.$($meta.ext) found in release/. Check the electron-builder output above."
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
