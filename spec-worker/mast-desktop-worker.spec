import os
from PyInstaller.utils.hooks import collect_all

spec_dir = os.path.dirname(os.path.abspath(SPEC))
root_dir = os.path.abspath(os.path.join(spec_dir, ".."))
engine_dir = os.path.join(root_dir, "mast-lead-engine")

datas = []
binaries = []
hiddenimports = [
    "service",
    "scraper.maps_scraper",
    "providers.discovery_composition",
    "providers.overpass_provider",
    "engine.acceptance",
    "engine.coordinator",
    "engine.execution_driver",
    "engine.runtime",
    "storage_backends.supabase_backend",
    "storage.early_persistent_dedup",
    "utils.perf",
    "utils.pipeline_trace",
    "utils.parsing",
]
tmp_ret = collect_all("playwright")
datas += tmp_ret[0]
binaries += tmp_ret[1]
hiddenimports += tmp_ret[2]

a = Analysis(
    [os.path.join(engine_dir, "desktop_worker.py")],
    pathex=[engine_dir],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[os.path.join(engine_dir, "pyinstaller_hooks")],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mast-desktop-worker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='mast-desktop-worker',
)
