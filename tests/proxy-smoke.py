"""Verify an occupied real socket cannot trigger proxy replacement or process termination."""
from pathlib import Path
import json
import os
import socket
import sys
import tempfile
import winreg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor" / "lepao3"))


def proxy_settings() -> tuple[object, object]:
    values: list[object] = []
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
        for name in ("ProxyEnable", "ProxyServer"):
            try:
                values.append(winreg.QueryValueEx(key, name)[0])
            except FileNotFoundError:
                values.append(None)
    return values[0], values[1]


before = proxy_settings()
with tempfile.TemporaryDirectory(prefix="swu-proxy-smoke-") as directory, socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    port = listener.getsockname()[1]
    os.environ["LEPAO_MITM_PORT"] = str(port)
    os.environ["LEPAO2_CONFIG"] = str(Path(directory) / "config.json")
    os.environ["LEPAO_CA_DIR"] = str(Path(directory) / "certificates")
    from lepao import capture
    try:
        capture.start(capture.ProxyGuard(), True)
    except RuntimeError as error:
        assert "已被占用" in str(error)
    else:
        raise AssertionError("An occupied socket was incorrectly reused.")
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        pass
    assert capture._owned_process is None
    assert proxy_settings() == before
    assert not (Path(directory) / "proxy_backup.json").exists()

    os.environ["LEPAO_RUNNER_DIR"] = directory
    upstream = f"http://127.0.0.1:{port}"
    (Path(directory) / "runner.json").write_text(json.dumps({"clash_upstream": upstream}), encoding="utf-8")
    from ui import run_core
    assert run_core.effective_upstream() == upstream
    listener.close()
    try:
        run_core.effective_upstream()
    except ConnectionError as error:
        assert "不会自动切换为直连" in str(error)
    else:
        raise AssertionError("An unreachable configured proxy silently switched to direct networking.")
    assert proxy_settings() == before

print(json.dumps({"occupiedPortRejected": True, "unrelatedListenerAlive": True, "systemProxyUnchanged": True, "unreachableUpstreamRejected": True}))
