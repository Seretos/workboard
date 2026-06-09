#requires -Version 5.1
<#
.SYNOPSIS
    Runs the Workboard Python backend test suite using pytest.

.DESCRIPTION
    Installs backend/requirements-dev.txt (which includes pytest) into an
    isolated .venv-test/ venv (distinct from the .venv-build/ used by build.ps1)
    and runs `python -m pytest tests -v` from the backend/ directory.

    A stale-venv guard probes `import lib_python_projects` inside the venv
    before skipping the install step, so a venv built against an older pin is
    automatically refreshed without needing -Install.

.PARAMETER Install
    Force (re)creation of the .venv-test/ venv and reinstallation of all
    dependencies, even if the venv already looks healthy.

.EXAMPLE
    pwsh scripts/test.ps1
    Run the test suite, creating/reusing .venv-test/ as needed.

.EXAMPLE
    pwsh scripts/test.ps1 -Install
    Force a fresh venv and dependency install, then run the tests.
#>
[CmdletBinding()]
param(
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# Run a native command (python/pip/pytest/...) and treat ONLY a non-zero exit
# code as failure. Native tools routinely write progress/INFO to stderr; under
# $ErrorActionPreference='Stop' a captured/redirected stderr line is turned
# into a terminating NativeCommandError, which would abort a perfectly healthy
# run. We drop to 'Continue' for the duration of the call and gate on
# $LASTEXITCODE instead.
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
    throw "package.json not found at '$PackageJson'. Is scripts/test.ps1 still under the repo root?"
}

$BackendDir = Join-Path $RepoRoot 'backend'

# --- Strict-mode-safe OS probe (mirrors build.ps1) --------------------------
function Test-AutoVar([string]$name) {
    $v = Get-Variable -Name $name -ErrorAction SilentlyContinue
    return ($null -ne $v -and $v.Value)
}
$onWindows = ($env:OS -eq 'Windows_NT') -or (Test-AutoVar 'IsWindows')

# --- Locate Python -----------------------------------------------------------
$python = $null
foreach ($cand in 'python', 'python3', 'py') {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $python = $cand; break }
}
if (-not $python) {
    throw "Python was not found on PATH (needed to create the test venv). Install Python 3.12+."
}

Write-Host "Repo root   : $RepoRoot"
Write-Host "Backend dir : $BackendDir"
Write-Host "Python      : $(& $python --version)"

# --- Create / reuse the test venv -------------------------------------------
$venv = Join-Path $RepoRoot '.venv-test'
$venvPython = if ($onWindows) { Join-Path $venv 'Scripts\python.exe' } else { Join-Path $venv 'bin/python' }

$freshVenv = $false
if (-not (Test-Path $venvPython)) {
    Write-Step "Create test venv (.venv-test)"
    Invoke-Native 'python -m venv' { & $python -m venv $venv }
    $freshVenv = $true
}

if ($freshVenv -or $Install) {
    Write-Step "Install backend dev deps (pip)"
    Invoke-Native 'pip upgrade' { & $venvPython -m pip install --upgrade pip }
    Invoke-Native 'pip install (backend dev deps)' {
        & $venvPython -m pip install -r (Join-Path $BackendDir 'requirements-dev.txt')
    }
}
else {
    # Venv present and no explicit -Install. Don't blindly trust it: a venv
    # built against an older pin can be missing the domain lib (same stale-venv
    # trap as in build.ps1). Probe before trusting the cache.
    Write-Step "Verify test venv has backend deps"
    & $venvPython -c "import lib_python_projects" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Test venv satisfies backend deps - skipping pip install (pass -Install to force a refresh)"
    }
    else {
        Write-Step "Test venv is missing backend deps - installing (stale venv)"
        Invoke-Native 'pip upgrade' { & $venvPython -m pip install --upgrade pip }
        Invoke-Native 'pip install (backend dev deps)' {
            & $venvPython -m pip install -r (Join-Path $BackendDir 'requirements-dev.txt')
        }
    }
}

# --- Run pytest --------------------------------------------------------------
Write-Step "Run pytest (backend/tests)"
Push-Location $BackendDir
try {
    Invoke-Native 'pytest' { & $venvPython -m pytest tests -v }
}
finally { Pop-Location }

Write-Host "`nAll tests passed." -ForegroundColor Green
