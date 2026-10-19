"""Exercise real encrypted member binding and cancellation without platform requests."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import StringIO
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/lepao3"))

sys.path.insert(0, str(ROOT / "engine"))
import bridge

with tempfile.TemporaryDirectory(prefix="swu-flow-") as temporary, redirect_stdout(StringIO()):
    root = Path(temporary)
    os.environ["LEPAO_RUNNER_DIR"] = str(root)
    os.environ["LEPAO_RUN_LOGOUT"] = "0"
    os.environ["LEPAO_CA_DIR"] = str(root / "certificates")
    from ui import run_core as core
    from lepao.accounts import AccountRegistry, AccountError
    from lepao import capture
    from lepao.operation import observe
    from lepao.private_storage import read_private_json

    config = Path(core.CONFIG_PATH)
    registry = AccountRegistry(str(config))
    members = [str(secrets.randbelow(10**13) + 10**13) for _ in range(2)]
    for index, member in enumerate(members):
        registry.add("Local target validation", member, school_id=837, uid=100 + index)
    registry.set_active(members[1])
    bridge.CORE = core
    for command in ("capture", "run"):
        for consent in (None, False):
            try:
                bridge.dispatch({"command": command, "member": members[0], "allowSystemProxy": consent})
            except ValueError as error:
                assert "临时切换系统代理" in str(error)
            else:
                raise AssertionError("The engine started capture without explicit network consent.")
    assert capture._owned_process is None
    assert not (root / "proxy_backup.json").exists()

    before = config.read_bytes()
    token = secrets.token_urlsafe(32)
    credential = {"uid": 100, "student_num": members[0], "school_id": 837, "token": token,
                  "update_time": datetime.now(timezone.utc).isoformat()}
    rejected = [
        (credential, members[1]),
        ({**credential, "student_num": members[1]}, members[0]),
        ({**credential, "school_id": 838}, members[0]),
        ({**credential, "uid": 999, "student_num": "unregistered"}, members[0]),
        ({"token": token}, members[0]),
        (credential, "unregistered"),
    ]
    for value, member in rejected:
        try:
            capture.sync(value, member)
        except (capture.CaptureIdentityError, AccountError):
            pass
        else:
            raise AssertionError("A conflicting or unknown identity was accepted.")
        assert config.read_bytes() == before
    key, auth = capture.sync(credential, members[0])
    assert key == members[0] and auth.key == members[0]
    saved = read_private_json(config)
    assert saved["accounts"][members[0]]["auth"]["token"] == token
    assert not saved["accounts"][members[1]]["auth"]["token"]
    assert token not in config.read_text(encoding="utf-8")
    assert saved["active"] == members[1]
    stopped = threading.Event()
    stopped.set()
    phases: list[str] = []
    def log(level: str, message: str) -> None:
        return None
    with observe(phases.append):
        for action in (core.action_capture, core.action_full, core.action_dry):
            assert action(member=members[0], log=log, stop_event=stopped) == "已取消"
    assert phases == []
    assert core.wait_new_token(None, "", 0, threading.Event(), interval=0, log=log, stable_reads=6) is None
    assert core.wait_new_token(None, "", 600, stopped, interval=0, log=log, stable_reads=6) is None
    assert capture._owned_process is None
    assert not (root / "proxy_backup.json").exists()
    assert not (root / "certificates").exists()

print(json.dumps({"mismatchedMemberRejected": True, "conflictingIdentityRejected": True,
                  "unknownTargetRejected": True, "rejectedWritesUnchanged": True, "onlyTargetSessionSaved": True,
                  "realDpapi": True, "preCancelledActionsStopped": True, "noProxyOrCertificateMutation": True}))
