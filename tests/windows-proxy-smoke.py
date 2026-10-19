"""Exercise real WinINet connection switching, matching registry views and full restoration."""
import json
import os
from pathlib import Path
import sys
import tempfile
import winreg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/lepao3"))
from lepao.windows_proxy import read_proxy_settings, apply_proxy_settings, capture_proxy_settings


def registry_proxy() -> tuple[int, str]:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
        return winreg.QueryValueEx(key, "ProxyEnable")[0], winreg.QueryValueEx(key, "ProxyServer")[0]


def connection_proxy() -> str:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections") as key:
        raw = winreg.QueryValueEx(key, "DefaultConnectionSettings")[0]
    length = int.from_bytes(raw[12:16], "little")
    if length > len(raw) - 16:
        raise ValueError("Invalid default connection proxy length.")
    return raw[16:16 + length].decode("utf-8")


before = read_proxy_settings()
before_registry = registry_proxy()
if before_registry != (int(bool(before["flags"] & 2)), before["server"]):
    raise RuntimeError("Existing Windows proxy views disagree; the smoke test will not overwrite them.")
with tempfile.TemporaryDirectory(prefix="swu-native-proxy-") as temporary:
    root = Path(temporary)
    os.environ["LEPAO2_CONFIG"] = str(root / "config.json")
    os.environ["LEPAO_FLOWS_DIR"] = str(root / "flows")
    os.environ["LEPAO_MITM_EXE"] = str(Path(os.environ["LOCALAPPDATA"]) / "Programs/SWU-Daka/engine/mitmweb.exe")
    os.environ["LEPAO_CA_DIR"] = str(Path(os.environ["APPDATA"]) / "swu-daka-desktop/lepao/certificates")
    os.environ["LEPAO_MITM_ADDON"] = str(ROOT / "vendor/lepao3/工具/mitm_lptiyu_token.py")
    os.environ["LEPAO_CRED_FILE"] = str(root / "credential.json")
    os.environ["LEPAO_MITM_WEB_PASS"] = os.urandom(24).hex()
    from lepao.private_storage import write_private_json
    write_private_json(root / "config.json", {"version": 2, "accounts": {}, "active": ""})
    from lepao import capture
    guard = capture.ProxyGuard()
    process = None
    try:
        process, guard = capture.start(guard, True)
        expected = capture_proxy_settings(before, "127.0.0.1:8081")
        assert read_proxy_settings() == expected
        assert registry_proxy() == (1, "127.0.0.1:8081")
        assert connection_proxy() == "127.0.0.1:8081"
        assert json.loads(Path(guard.BACKUP).read_text(encoding="utf-8"))["settings"] == before
        # Refuse a real concurrent settings change rather than overwrite it.
        changed = {**expected, "bypass": expected["bypass"] + ";swu-proxy-validation.invalid"}
        apply_proxy_settings(changed)
        try:
            guard.restore()
        except RuntimeError:
            assert read_proxy_settings() == changed
            assert Path(guard.BACKUP).exists()
        else:
            raise AssertionError("A concurrent connection change was overwritten.")
        apply_proxy_settings(expected)
    finally:
        capture.stop(process, guard)
    assert read_proxy_settings() == before
    assert registry_proxy() == before_registry
    assert connection_proxy() == before["server"]
    assert not Path(guard.BACKUP).exists()

print(json.dumps({"realBundledProxyStarted": True, "nativeConnectionSwitched": True, "registryViewMatched": True,
                  "connectionBlobMatched": True, "concurrentChangeRejected": True, "fullSettingsRestored": True,
                  "backupRemovedAfterVerification": True, "noSportSubmission": True}))
