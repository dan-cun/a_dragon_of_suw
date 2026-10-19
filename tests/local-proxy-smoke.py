"""Verify the real API listener starts and stops without changing Windows networking."""
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import winreg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/lepao3'))
from lepao.windows_proxy import read_proxy_settings


def registry_proxy() -> tuple[int, str]:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
        return winreg.QueryValueEx(key, 'ProxyEnable')[0], winreg.QueryValueEx(key, 'ProxyServer')[0]


ca = Path(os.environ['SWU_PROXY_SMOKE_CA_DIR'])
if not (ca / 'mitmproxy-ca.pem').is_file():
    raise RuntimeError('Provide an existing application CA; the test must not create or install one.')
native_before = read_proxy_settings()
registry_before = registry_proxy()
with tempfile.TemporaryDirectory(prefix='swu-local-listener-') as temporary:
    root = Path(temporary)
    os.environ['LEPAO2_CONFIG'] = str(root / 'config.json')
    os.environ['LEPAO_FLOWS_DIR'] = str(root / 'flows')
    os.environ['LEPAO_MITM_EXE'] = str(Path(os.environ['LOCALAPPDATA']) / 'Programs/SWU-Daka/engine/mitmweb.exe')
    os.environ['LEPAO_CA_DIR'] = str(ca)
    os.environ['LEPAO_MITM_ADDON'] = str(ROOT / 'vendor/lepao3/工具/mitm_lptiyu_token.py')
    os.environ['LEPAO_CRED_FILE'] = str(root / 'credential.json')
    os.environ['LEPAO_MITM_WEB_PASS'] = os.urandom(24).hex()
    from lepao.private_storage import write_private_json
    write_private_json(root / 'config.json', {'version': 2, 'accounts': {}, 'active': ''})
    from lepao import capture
    guard = capture.ProxyGuard()
    process = None
    try:
        process, guard = capture.start_local(guard, True)
        assert process.poll() is None
        assert read_proxy_settings() == native_before
        assert registry_proxy() == registry_before
        assert guard.saved is None and guard.saved_options is None
        assert not Path(guard.BACKUP).exists()
    finally:
        capture.stop(process, guard)
    assert process is not None and process.poll() is not None
    assert capture._owned_process is None
    capture.stop(process, guard)

    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], creationflags=0x08000000)
    try:
        try:
            capture.stop(unrelated, guard)
        except RuntimeError as error:
            assert '不属于本应用' in str(error)
        else:
            raise AssertionError('An unrelated process was accepted for termination.')
        assert unrelated.poll() is None
    finally:
        unrelated.terminate()
        unrelated.wait(timeout=8)

    process, guard = capture.start_local(capture.ProxyGuard(), True)
    backup = Path(guard.BACKUP)
    invalid_backup = '{"invalid": true}'
    backup.write_text(invalid_backup, encoding='utf-8')
    try:
        try:
            capture.stop(process, guard)
        except ValueError as error:
            assert '备份格式无效' in str(error)
        else:
            raise AssertionError('Invalid recovery data did not produce a clear failure.')
        assert process.poll() is not None
        assert capture._owned_process is None
        assert backup.read_text(encoding='utf-8') == invalid_backup
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=8)
        backup.unlink()
    assert read_proxy_settings() == native_before
    assert registry_proxy() == registry_before
    assert not Path(guard.BACKUP).exists()
print(json.dumps({'realListenerStarted': True, 'noSystemProxyMutation': True, 'noBackupCreated': True,
                  'ownedProcessExitConfirmed': True, 'unrelatedProcessPreserved': True, 'invalidRecoveryBackupPreserved': True,
                  'noCertificateInstallation': True, 'noPlatformSubmission': True}))
