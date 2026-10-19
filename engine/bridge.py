"""Expose the attributed Lepao engine through a bounded JSON-lines interface."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal, TypedDict

sys.stdout.reconfigure(encoding="utf-8", errors="strict")
sys.stderr.reconfigure(encoding="utf-8", errors="strict")
sys.stdin.reconfigure(encoding="utf-8", errors="strict")

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "lepao3"
FROZEN = bool(getattr(sys, "frozen", False))
if not FROZEN:
    sys.path.insert(0, str(VENDOR))

WIRE = sys.stdout
WIRE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STOP = threading.Event()
WORKER: threading.Thread | None = None
BUSY = False
ACTION = ""
RESULT = ""
CAPABILITIES: dict[str, object] | None = None

Status = Literal["running", "succeeded", "cancelled", "timed-out", "needs-session", "pending-review", "invalid", "failed"]
Phase = Literal["preparing", "waiting-login", "validating", "executing", "confirming", "restoring", "stopping", "finished"]


class Operation(TypedDict):
    id: str
    action: str
    member: str | None
    memberLabel: str | None
    startedAt: str
    finishedAt: str | None
    phase: Phase
    status: Status
    message: str
    cancelRequested: bool
    proxyRestored: bool | None


OPERATION: Operation | None = None


def progress(phase: Phase) -> None:
    global OPERATION
    with STATE_LOCK:
        if OPERATION is None:
            raise RuntimeError("Operation context is missing.")
        if STOP.is_set() and phase != "restoring":
            phase = "stopping"
        OPERATION = {**OPERATION, "phase": phase}
    emit({"type": "state", "value": snapshot()})


def outcome_status(outcome: str) -> Status:
    statuses: dict[str, Status] = {
        "成功": "succeeded", "环境检查完成": "succeeded", "当前用户代理证书已安装并确认受信任": "succeeded",
        "已取消": "cancelled", "超时未抓号": "timed-out", "需抓号": "needs-session",
        "已提交待复核": "pending-review", "执行中断，结果待核对": "pending-review",
        "已提交但判无效": "invalid", "判无效": "invalid",
    }
    return statuses.get(outcome, "failed")


def emit(value: dict[str, object]) -> None:
    with WIRE_LOCK:
        WIRE.write(json.dumps(value, ensure_ascii=False) + "\n")
        WIRE.flush()


def safe_message(value: str) -> str:
    clean = re.sub(r"(?i)(token|refresh_token|session|password|expect)\s*[=:]\s*\S+", r"\1=[redacted]", value)
    clean = re.sub(r"\b\d{8,}\b|\b[0-9a-fA-F]{24,}\b", "[redacted]", clean)
    return clean[:1200]


def log(level: str, message: str) -> None:
    normalized = "error" if level in ("err", "error", "fatal") else "warning" if level in ("warn", "warning") else "info"
    emit({"type": "log", "level": normalized, "message": safe_message(str(message))})


class LogOutput(io.TextIOBase):
    """Route upstream console output to sanitized structured engine events."""

    def write(self, value: str) -> int:
        for line in value.splitlines():
            if line.strip():
                log("info", line)
        return len(value)

    def flush(self) -> None:
        return None


def mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("Expected a JSON object with string keys.")
    return value


def text(payload: dict[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError(f"Invalid required string: {key}.")
    return value.strip()


def proxy_recovery_needed() -> bool:
    """Account for an unclosed owned listener as well as pending proxy restoration."""
    from lepao import capture
    process = capture._owned_process
    return Path(CORE.DATA_DIR, "proxy_backup.json").exists() or (process is not None and process.poll() is None)


def snapshot() -> dict[str, object]:
    from lifecycle import member_details, privacy_state
    details = member_details(Path(CORE.DATA_DIR))
    from results import submission_summaries
    summaries = submission_summaries(Path(CORE.DATA_DIR))
    rows = []
    for original in CORE.members_table():
        row = mapping(original)
        info = details[str(row["key"])]
        labels = {"missing": "未保存会话", "available": "待平台验证", "expired": "本地会话已过期", "consumed": "已使用", "invalid": "会话时间无效"}
        rows.append({**{key: row[key] for key in ("key", "label", "student", "enabled", "active")}, "state": labels[str(info["sessionState"])], **info, "lastSubmission": summaries.get(str(row["key"]))})
    with STATE_LOCK:
        return {"busy": BUSY, "action": ACTION, "result": RESULT, "operation": OPERATION, "members": rows,
                "capabilities": CAPABILITIES, "proxyRecoveryNeeded": proxy_recovery_needed() if not BUSY else Path(CORE.DATA_DIR, "proxy_backup.json").exists(),
                "privacy": privacy_state(Path(CORE.DATA_DIR))}


def selfcheck() -> None:
    global CAPABILITIES
    with STATE_LOCK:
        CAPABILITIES = None
    raw = mapping(CORE.capability())
    cert = mapping(raw["cert"])
    from lepao import license_guard
    license_state = mapping(license_guard.check_license())
    value = {"proxyReady": raw["mitm_healthy"] is True, "wechatFound": bool(raw["wechat"]),
             "certificateTrusted": cert["trusted"] is True, "certificatePresent": cert["present"] is True,
             "certificateHint": safe_message(str(cert["hint"])), "upstreamMode": str(raw["upstream_mode"]),
             "upstreamReady": raw["clash"] is True, "licenseValid": license_state["status"] == "ok"}
    with STATE_LOCK:
        CAPABILITIES = value


def run_action(action: str, member: str) -> None:
    global BUSY, RESULT, OPERATION
    status: Status = "failed"
    try:
        if STOP.is_set():
            outcome = "已取消"
        elif action in ("capture", "run", "dry"):
            selfcheck()
            if STOP.is_set():
                outcome = "已取消"
            else:
                if CAPABILITIES is None or not CAPABILITIES["proxyReady"]:
                    raise RuntimeError("内置代理引擎不可用，请重新安装完整安装包并查看环境检查。")
                if not CAPABILITIES["certificateTrusted"]:
                    raise RuntimeError("当前用户尚未信任本应用的代理证书，请先点击安装证书，再开始采集。")
                if not CAPABILITIES["licenseValid"]:
                    raise RuntimeError("随包声明文件校验失败，请重新安装完整安装包。")
                actions: dict[str, Callable[..., str]] = {"capture": CORE.action_capture, "run": CORE.action_full, "dry": CORE.action_dry}
                from lepao.operation import observe
                with observe(progress):
                    outcome = actions[action](member=member, log=log, stop_event=STOP)
        elif action == "check":
            CORE._CERT_CACHE["t"] = 0.0
            selfcheck()
            outcome = "环境检查完成"
        elif action == "certificate":
            from lepao import certctl
            response = mapping(certctl.install(True))
            if response.get("ok") is not True:
                raise RuntimeError("当前用户证书安装失败：" + str(response.get("detail", "未提供原因")))
            CORE._CERT_CACHE["t"] = 0.0
            selfcheck()
            if CAPABILITIES is None or not CAPABILITIES["certificateTrusted"]:
                raise RuntimeError("证书安装后复核仍未受信，请查看证书检查错误，不要重复安装其他证书。")
            outcome = "当前用户代理证书已安装并确认受信任"
        else:
            raise ValueError("Unsupported engine action.")
        status = outcome_status(outcome)
        with STATE_LOCK:
            RESULT = str(outcome)
        log("info", "执行结果：" + str(outcome))
    except Exception as error:
        with STATE_LOCK:
            RESULT = "操作失败：" + safe_message(str(error))
        log("error", str(error))
    finally:
        progress("restoring")
        try:
            from lifecycle import expire_sessions, clear_raw
            expire_sessions(Path(CORE.DATA_DIR))
            if proxy_recovery_needed():
                raise RuntimeError("代理进程或网络设置尚未恢复，未清理采集材料；请先停止并恢复代理。")
            clear_raw(Path(CORE.DATA_DIR))
        except Exception as error:
            with STATE_LOCK:
                status = "failed"
                RESULT = "操作结束，但本地清理失败：" + safe_message(str(error))
            log("error", str(error))
        restored = not proxy_recovery_needed()
        with STATE_LOCK:
            if OPERATION is None:
                raise RuntimeError("Operation context is missing at completion.")
            if not restored:
                status = "failed"
                RESULT = "代理恢复尚未完成。请点击停止并恢复代理，查看错误原因。"
            OPERATION = {**OPERATION, "phase": "finished", "status": status, "message": RESULT,
                         "finishedAt": datetime.now(timezone.utc).isoformat(), "proxyRestored": restored}
            BUSY = False
        emit({"type": "state", "value": snapshot()})


def dispatch(payload: dict[str, object]) -> dict[str, object]:
    global BUSY, ACTION, RESULT, WORKER, OPERATION
    command = text(payload, "command")
    if command == "state":
        return snapshot()
    if command == "stop":
        STOP.set()
        with STATE_LOCK:
            if OPERATION is not None and BUSY:
                OPERATION = {**OPERATION, "cancelRequested": True, "phase": "stopping"}
        if not BUSY:
            CORE.stop_all(None, log)
            from lifecycle import clear_raw
            clear_raw(Path(CORE.DATA_DIR))
            if OPERATION is not None and OPERATION["proxyRestored"] is False:
                with STATE_LOCK:
                    OPERATION = {**OPERATION, "proxyRestored": True,
                                 "message": "代理恢复检查已完成；之前操作未完成，请核对原始错误日志。"}
        return snapshot()
    if command == "shutdown":
        if BUSY:
            raise RuntimeError("乐跑操作尚未结束，请先停止并等待代理恢复。")
        return snapshot()
    if BUSY:
        raise RuntimeError("乐跑操作正在进行，请等待结束或先停止。")
    if proxy_recovery_needed():
        raise RuntimeError("代理进程或网络设置尚未恢复，请先点击停止并恢复代理。")
    from lifecycle import expire_sessions, clear_raw, forget_session
    expire_sessions(Path(CORE.DATA_DIR))
    if command == "cleanup":
        clear_raw(Path(CORE.DATA_DIR))
        RESULT = "采集文件已清理；成员、加密会话和证书保留。"
        return snapshot()
    if command == "add":
        student = text(payload, "student")
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,40}", student):
            raise ValueError("学号仅支持 3 到 40 位字母、数字、下划线或连字符。")
        school = payload.get("school")
        if not isinstance(school, int) or isinstance(school, bool) or school <= 0:
            raise ValueError("学校编号必须是正整数。")
        name = text(payload, "name")
        CORE.member_add(name, student, name, school)
    elif command in ("remove", "activate", "forget"):
        key = text(payload, "member")
        if not any(row["key"] == key for row in snapshot()["members"]):
            raise ValueError("目标成员不存在，未修改其他成员。")
        if command == "remove":
            from lifecycle import remove_member_records
            remove_member_records(Path(CORE.DATA_DIR), key)
            forget_session(Path(CORE.DATA_DIR), key)
            CORE.member_remove(key)
            if OPERATION is not None and OPERATION["member"] == key:
                OPERATION = None
                RESULT = ""
        elif command == "forget":
            forget_session(Path(CORE.DATA_DIR), key)
        else:
            CORE.member_activate(key)
    elif command in ("run", "capture", "dry", "check", "certificate"):
        if command in ("run", "capture") and payload.get("allowSystemProxy") is not True:
            raise ValueError("默认保留现有网络配置。采集前必须明确允许本次临时切换系统代理。")
        member = text(payload, "member") if command in ("run", "capture", "dry") else ""
        if member and not any(row["key"] == member for row in snapshot()["members"]):
            raise ValueError("请先登记并选择目标成员。")
        STOP.clear()
        with STATE_LOCK:
            BUSY = True
            ACTION = command
            RESULT = ""
            label = next((row["label"] for row in CORE.members_table() if row["key"] == member), None)
            OPERATION = {"id": str(uuid.uuid4()), "action": command, "member": member or None, "memberLabel": label,
                         "startedAt": datetime.now(timezone.utc).isoformat(), "finishedAt": None, "phase": "preparing",
                         "status": "running", "message": "", "cancelRequested": False, "proxyRestored": None}
        WORKER = threading.Thread(target=run_action, args=(command, member), daemon=True)
        WORKER.start()
    else:
        raise ValueError("Unsupported engine command.")
    return snapshot()


def main() -> None:
    global CORE
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise ValueError("Provide the absolute Lepao user data directory.")
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    executable_dir = Path(sys.executable).parent
    os.environ["LEPAO_RUNNER_DIR"] = str(directory)
    os.environ["LEPAO_RUN_LOGOUT"] = "0"
    os.environ["LEPAO_CA_DIR"] = str(directory / "certificates")
    os.environ["LEPAO_MITM_WEB_PASS"] = os.urandom(24).hex()
    os.environ["LEPAO_LICENSE_FILE"] = str(Path(getattr(sys, "_MEIPASS", VENDOR)) / "LICENSE")
    if FROZEN:
        os.environ["LEPAO_MITM_EXE"] = str(executable_dir / "mitmweb.exe")
    else:
        os.environ["LEPAO_MITM_EXE"] = str(executable_dir / "mitmweb.exe")
    with contextlib.redirect_stdout(LogOutput()), contextlib.redirect_stderr(LogOutput()):
        from ui import run_core
        CORE = run_core
        from lifecycle import expire_sessions, clear_raw
        if not Path(CORE.DATA_DIR, "proxy_backup.json").exists():
            removed = expire_sessions(Path(CORE.DATA_DIR))
            clear_raw(Path(CORE.DATA_DIR))
            if removed:
                log("warning", "已清除过期、时间无效或已消耗的本地会话；24 小时是本地保留上限，不代表平台有效期。")
        log("info", "西大日常整合版 · 原作者 dan-cun · https://github.com/dan-cun/lepao3 · 乐跑研究协议 1.0（LRL-1.0）· 非商业授权软件")
        emit({"type": "ready"})
        try:
            for line in sys.stdin:
                request_id = ""
                try:
                    if len(line) > 16_384:
                        raise ValueError("Engine request exceeds 16 KB.")
                    payload = mapping(json.loads(line))
                    request_id = text(payload, "id")
                    value = dispatch(payload)
                    emit({"type": "response", "id": request_id, "ok": True, "value": value})
                    if payload["command"] == "shutdown":
                        break
                except Exception as error:
                    emit({"type": "response", "id": request_id, "ok": False, "error": safe_message(str(error))})
        finally:
            STOP.set()
            if WORKER is not None:
                WORKER.join(timeout=30)
            if proxy_recovery_needed():
                CORE.stop_all(None, log)
            clear_raw(Path(CORE.DATA_DIR))


if __name__ == "__main__":
    main()
