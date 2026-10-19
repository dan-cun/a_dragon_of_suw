"""Manage bounded local session retention and removal of owned capture artifacts."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
from lepao.private_storage import read_private_json, write_private_json

RETENTION_HOURS = 24
RAW_NAMES = ("flows", "logs", "凭证.json", "凭证.json.pending", "mitm_流量.log", "dryrun_最新.json")


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("Lepao lifecycle data must contain an object.")
    return value


def _raw_files(directory: Path) -> list[Path]:
    root = directory.resolve(strict=True)
    files: list[Path] = []

    def visit(path: Path) -> None:
        if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(root):
            raise ValueError("Capture cleanup refused a linked or external path.")
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            for child in path.iterdir():
                visit(child)
        elif path.exists():
            raise ValueError("Capture cleanup encountered an unsupported file type.")

    for name in RAW_NAMES:
        visit(root / name)
    if directory.name == "lepao":
        legacy = root.parent / "mitm_流量.log"
        if legacy.is_symlink() or legacy.is_junction():
            raise ValueError("Legacy capture log cleanup refused a linked path.")
        if legacy.is_file():
            files.append(legacy)
    return files


def clear_raw(directory: Path) -> None:
    if (directory / "proxy_backup.json").exists():
        raise RuntimeError("代理尚未恢复，未清理采集材料；请先停止并恢复代理。")
    for path in _raw_files(directory):
        path.unlink()
    (directory / "privacy.json").write_text(json.dumps({"lastCleanupAt": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def session_details(auth: dict[str, object], now: datetime) -> dict[str, object]:
    issued = auth.get("issued_at")
    expires = None
    if isinstance(issued, str) and issued:
        try:
            expires = datetime.fromisoformat(issued.replace("Z", "+00:00")).astimezone(timezone.utc) + timedelta(hours=RETENTION_HOURS)
        except ValueError:
            return {"sessionState": "invalid", "expiresAt": None}
    status = "missing"
    if auth.get("cleared_reason") == "invalid":
        status = "invalid"
    elif auth.get("consumed_at"):
        status = "consumed"
    elif auth.get("cleared_reason") == "expired" or (auth.get("token") and (expires is None or expires <= now)):
        status = "expired"
    elif auth.get("token"):
        status = "available"
    return {"sessionState": status, "expiresAt": expires.isoformat() if expires is not None else None}


def expire_sessions(directory: Path) -> int:
    path = directory / "config.json"
    config = read_private_json(path)
    history = directory / "state.json"
    if history.exists():
        read_private_json(history)
    accounts = _object(config.get("accounts"))
    expired = 0
    for raw in accounts.values():
        account = _object(raw)
        auth = _object(account.get("auth", {}))
        status = session_details(auth, datetime.now(timezone.utc))["sessionState"]
        if status in ("expired", "consumed", "invalid") and (auth.get("token") or auth.get("refresh_token")):
            account["auth"] = {"consumed_at": auth.get("consumed_at", ""), "issued_at": auth.get("issued_at", ""),
                               "cleared_reason": status}
            expired += 1
    if expired:
        write_private_json(path, config)
    return expired


def forget_session(directory: Path, member: str) -> None:
    config = read_private_json(directory / "config.json")
    accounts = _object(config.get("accounts"))
    if member not in accounts:
        raise ValueError("目标成员不存在，未修改其他成员。")
    _object(accounts[member])["auth"] = {}
    write_private_json(directory / "config.json", config)
    clear_raw(directory)


def remove_member_records(directory: Path, member: str) -> None:
    config = read_private_json(directory / "config.json")
    account = _object(_object(config.get("accounts"))[member])
    uid = account.get("uid")
    label = account.get("alias") or account.get("name") or member
    tags = {member, f"{label}#{uid}"} if uid else {member}
    path = directory / "state.json"
    if not path.exists():
        return
    data = read_private_json(path)
    record_ids: set[object] = set()
    for name in ("dryruns", "submissions"):
        values = data.get(name, [])
        if not isinstance(values, list):
            raise ValueError("Local member history is not a list.")
        retained: list[object] = []
        for value in values:
            entry = _object(value)
            if entry.get("member") in tags or (uid and str(entry.get("uid")) == str(uid)):
                record_ids.add(entry.get("record_id"))
            else:
                retained.append(entry)
        data[name] = retained
    watch = data.get("watch_log", [])
    if not isinstance(watch, list):
        raise ValueError("Local watch history is not a list.")
    data["watch_log"] = [item for item in watch if _object(item).get("record_id") not in record_ids]
    write_private_json(path, data)


def member_details(directory: Path) -> dict[str, dict[str, object]]:
    config = read_private_json(directory / "config.json")
    accounts = _object(config.get("accounts"))
    now = datetime.now(timezone.utc)
    return {key: session_details(_object(_object(raw).get("auth", {})), now) for key, raw in accounts.items()}


def privacy_state(directory: Path) -> dict[str, object]:
    files = _raw_files(directory)
    stamp = directory / "privacy.json"
    saved = _object(json.loads(stamp.read_text(encoding="utf-8"))) if stamp.exists() else {}
    return {"storage": "windows-dpapi", "sessionRetentionHours": RETENTION_HOURS, "rawFiles": len(files),
            "rawBytes": sum(path.stat().st_size for path in files), "lastCleanupAt": saved.get("lastCleanupAt")}
