# -*- coding: utf-8 -*-
# --- lepao-research-notice v1 (do not remove; see LICENSE) ---
# 乐跑协议研究（Lepao Research） · https://github.com/dan-cun/lepao3
# Copyright (c) 2026 dan-cun · 技术讨论 QQ 1224145544（仅作技术讨论，不提供代打卡）
# 许可证 LRL-1.0（乐跑研究协议 1.0）：仅供学习 · 不可牟利 · 再发布须署名引用原始仓库 · 声明不得删除
# 删除或篡改本块即依 LRL-1.0 第三条自动终止授权；衍生版须继续以 LRL-1.0 授权并标注修改说明。
# --- end lepao-research-notice ---
# Copyright (c) 2026 dan-cun · 许可协议见项目根目录 LICENSE
"""Persist local Lepao configuration and captured credentials with CurrentUser DPAPI."""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re


class StorageError(RuntimeError):
    """Identify a failed local privacy boundary."""


class DataBlob(ctypes.Structure):
    """Represent the Windows Crypt32 DATA_BLOB interface."""

    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def _crypt(value: bytes, operation: str) -> bytes:
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(value)
    source = DataBlob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = DataBlob()
    function = getattr(crypt32, operation)
    function.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise StorageError("Windows DPAPI operation failed.") from ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel32.LocalFree(target.data)


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise StorageError("Private JSON must contain an object.")
    return value


def write_private_json(path: str | Path, value: dict[str, object]) -> None:
    target = Path(path)
    if target.is_symlink() or target.is_junction():
        raise StorageError("Refusing a linked private storage target.")
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    if len(raw) > 2_000_000:
        raise StorageError("Private JSON exceeds 2 MB.")
    encrypted = base64.b64encode(_crypt(raw, "CryptProtectData")).decode("ascii")
    pending = target.with_name(target.name + ".pending")
    if pending.is_symlink() or pending.is_junction():
        raise StorageError("Refusing a linked private storage temporary file.")
    pending.write_text(json.dumps({"storage": "windows-dpapi-v1", "encrypted": encrypted}), encoding="utf-8")
    os.replace(pending, target)


def read_private_json(path: str | Path) -> dict[str, object]:
    target = Path(path)
    if target.is_symlink() or target.is_junction() or target.stat().st_size > 4_000_000:
        raise StorageError("Private storage is linked or exceeds 4 MB.")
    stored = _object(json.loads(target.read_text(encoding="utf-8-sig")))
    if "storage" not in stored:
        # The legacy format is migrated atomically, without creating a plaintext backup.
        write_private_json(target, stored)
        print("[privacy] Legacy local JSON was migrated to Windows user encryption.")
        return stored
    if stored.get("storage") != "windows-dpapi-v1" or not isinstance(stored.get("encrypted"), str):
        raise StorageError("Private storage format is unsupported.")
    return _object(json.loads(_crypt(base64.b64decode(stored["encrypted"], validate=True), "CryptUnprotectData")))


def safe_log(value: str) -> str:
    clean = re.sub(r"(?i)(token|refresh_token|session|password|expect)\s*[=:]\s*\S+", r"\1=[redacted]", value)
    return re.sub(r"\b\d{8,}\b|\b[0-9a-fA-F]{8,}\b", "[redacted]", clean)[:1200]
