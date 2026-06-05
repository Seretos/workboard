# PyInstaller spec for the Workboard backend binary.
# Build from the backend/ directory:
#   pyinstaller workboard-backend.spec --distpath ../backend-bin/<os>

from PyInstaller.utils.hooks import collect_all

block_cipher = None

# Fully collect the domain libs and ruamel.yaml. PyInstaller's static analysis
# follows `from lib_python_projects import load_projects`, but these packages
# pull in submodules/data dynamically (ruamel.yaml loads its plugins at runtime,
# the libs read packaged config), so collect_all is needed to avoid a runtime
# ModuleNotFoundError. If any of these isn't installed in the build env,
# collect_all returns empty lists and the build still produces a (broken)
# binary — so the build pipeline must ensure requirements.txt is installed.
_collected_datas = []
_collected_binaries = []
_collected_hiddenimports = []
for _pkg in ("lib_python_projects", "lib_python_config", "ruamel.yaml"):
    _d, _b, _h = collect_all(_pkg)
    _collected_datas += _d
    _collected_binaries += _b
    _collected_hiddenimports += _h

a = Analysis(
    ["src/main.py"],
    pathex=["."],
    binaries=_collected_binaries,
    datas=_collected_datas,
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "anyio._backends._asyncio",
    ] + _collected_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="workboard-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
