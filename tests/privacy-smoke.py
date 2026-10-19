"""Exercise real Windows encryption, legacy migration and owned-file lifecycle cleanup."""
from datetime import datetime, timedelta, timezone
import json
import secrets
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/lepao3"))
sys.path.insert(0, str(ROOT / "engine"))
from lepao.accounts import AccountRegistry
from lepao.private_storage import read_private_json
from lifecycle import expire_sessions, forget_session, member_details, privacy_state, clear_raw, remove_member_records
from lepao.state import LocalState

with tempfile.TemporaryDirectory(prefix="swu-privacy-") as temporary:
    root = Path(temporary)
    config = root / "config.json"
    config.write_text(json.dumps({"version": 2, "accounts": {}, "active": ""}), encoding="utf-8")
    registry = AccountRegistry(str(config))
    keys = ["local_" + secrets.token_hex(6) for _ in range(3)]
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    for key in keys:
        registry.add("Local privacy validation", key)
        registry.acc(key)["auth"] = {"token": token, "refresh_token": token, "issued_at": now.isoformat(), "consumed_at": ""}
    registry.acc(keys[1])["auth"]["issued_at"] = (now - timedelta(hours=25)).isoformat()
    registry.acc(keys[2])["auth"]["consumed_at"] = now.isoformat()
    registry.persist()
    assert token not in config.read_text(encoding="utf-8")
    assert json.loads(config.read_text(encoding="utf-8"))["storage"] == "windows-dpapi-v1"
    assert AccountRegistry(str(config)).acc(keys[0])["auth"]["token"] == token
    assert expire_sessions(root) == 2
    assert member_details(root)[keys[1]]["sessionState"] == "expired"
    assert member_details(root)[keys[2]]["sessionState"] == "consumed"
    assert member_details(root)[keys[0]]["sessionState"] == "available"
    state = LocalState(str(root / "state.json"))
    state.save_dryrun({"oss_record_file": "local-only", "track_points": 0}, uid=100, member=keys[0])
    assert '"dryruns"' not in (root / "state.json").read_text(encoding="utf-8")
    (root / "flows").mkdir()
    (root / "flows/capture.mitm").write_bytes(secrets.token_bytes(64))
    assert privacy_state(root)["rawFiles"] == 2
    sentinel = root / "certificates"
    sentinel.mkdir()
    (sentinel / "keep.cer").write_bytes(b"local-certificate-sentinel")
    remove_member_records(root, keys[0])
    forget_session(root, keys[0])
    assert not read_private_json(config)["accounts"][keys[0]]["auth"]
    assert read_private_json(root / "state.json")["dryruns"] == []
    assert privacy_state(root)["rawFiles"] == 0
    assert (sentinel / "keep.cer").read_bytes() == b"local-certificate-sentinel"
    (root / "proxy_backup.json").write_text("{}", encoding="utf-8")
    try:
        clear_raw(root)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Cleanup was allowed before proxy restoration.")
print(json.dumps({"realDpapi": True, "migrationEncrypted": True, "expirationApplied": True, "memberSessionRemoved": True,
                  "memberHistoryRemoved": True, "captureFilesRemoved": True, "certificatePreserved": True, "proxyRecoveryGate": True}))
