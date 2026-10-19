from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

root = Path(SPECPATH).parent
vendor = root / "vendor" / "lepao3"
datas, binaries, hiddenimports = collect_all("mitmproxy")
for name in ("mitmproxy_rs", "Crypto"):
    data, binary, hidden = collect_all(name)
    datas += data
    binaries += binary
    hiddenimports += hidden
hiddenimports += collect_submodules("lepao") + ["ui.run_core"]
for name in ("ddddocr", "onnxruntime"):
    data, binary, hidden = collect_all(name)
    datas += data
    binaries += binary
    hiddenimports += hidden
datas += [(str(vendor / name), ".") for name in ("LICENSE", "NOTICE", "DISCLAIMER.md", "config.sample.json")]
datas += [(str(vendor / "data"), "data"), (str(vendor / "工具" / "mitm_lptiyu_token.py"), "工具")]

analysis = Analysis([str(root / "engine" / "bridge.py"), str(root / "engine" / "mitm_entry.py"),
                     str(root / "engine" / "captcha_ocr.py")],
                    pathex=[str(vendor), str(root / "engine")], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
                    excludes=["tkinter", "pytest"], noarchive=False)
pyz = PYZ(analysis.pure)
scripts = {Path(entry[1]).name: entry for entry in analysis.scripts}
bridge = EXE(pyz, [scripts["bridge.py"]], [], exclude_binaries=True, name="lepao-engine", console=True)
proxy = EXE(pyz, [scripts["mitm_entry.py"]], [], exclude_binaries=True, name="mitmweb", console=True)
ocr = EXE(pyz, [scripts["captcha_ocr.py"]], [], exclude_binaries=True, name="captcha-ocr", console=True)
collection = COLLECT(bridge, proxy, ocr, analysis.binaries, analysis.datas, strip=False, upx=False, name="lepao-engine")
