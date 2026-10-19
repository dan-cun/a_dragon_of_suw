# -*- coding: utf-8 -*-
# --- lepao-research-notice v1 (do not remove; see LICENSE) ---
# 乐跑协议研究（Lepao Research） · https://github.com/dan-cun/lepao3
# Copyright (c) 2026 dan-cun · 技术讨论 QQ 1224145544（仅作技术讨论，不提供代打卡）
# 许可证 LRL-1.0（乐跑研究协议 1.0）：仅供学习 · 不可牟利 · 再发布须署名引用原始仓库 · 声明不得删除
# 删除或篡改本块即依 LRL-1.0 第三条自动终止授权；衍生版须继续以 LRL-1.0 授权并标注修改说明。
# --- end lepao-research-notice ---
"""Read and update the default Windows connection through the supported WinINet API."""
from __future__ import annotations
import ctypes
from ctypes import wintypes
from typing import TypedDict
import winreg


class ProxySettings(TypedDict):
    flags: int
    server: str
    bypass: str
    autoConfigUrl: str


class _OptionValue(ctypes.Union):
    _fields_ = [("number", wintypes.DWORD), ("pointer", ctypes.c_void_p), ("time", wintypes.FILETIME)]


class _Option(ctypes.Structure):
    _fields_ = [("option", wintypes.DWORD), ("value", _OptionValue)]


class _OptionList(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("connection", ctypes.c_wchar_p), ("count", wintypes.DWORD),
                ("error", wintypes.DWORD), ("options", ctypes.POINTER(_Option))]


def parse_proxy_settings(value: object) -> ProxySettings:
    if not isinstance(value, dict):
        raise ValueError("代理备份中的默认连接设置不是对象。")
    flags = value.get("flags")
    if isinstance(flags, bool) or not isinstance(flags, int) or flags < 0 or flags > 0xFFFFFFFF:
        raise ValueError("代理备份中的连接标志无效。")
    if not all(isinstance(value.get(key), str) for key in ("server", "bypass", "autoConfigUrl")):
        raise ValueError("代理备份中的服务器、绕过规则或自动配置地址无效。")
    return {"flags": flags, "server": value["server"], "bypass": value["bypass"], "autoConfigUrl": value["autoConfigUrl"]}


def read_proxy_settings() -> ProxySettings:
    wininet = ctypes.WinDLL("wininet", use_last_error=True)
    wininet.InternetQueryOptionW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
    wininet.InternetQueryOptionW.restype = wintypes.BOOL
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GlobalFree.argtypes = [ctypes.c_void_p]
    kernel.GlobalFree.restype = ctypes.c_void_p
    options = (_Option * 4)()
    for row, option in zip(options, (10, 2, 3, 4)):
        row.option = option
    values = _OptionList(ctypes.sizeof(_OptionList), None, 4, 0, options)
    size = wintypes.DWORD(ctypes.sizeof(values))
    try:
        if not wininet.InternetQueryOptionW(None, 75, ctypes.byref(values), ctypes.byref(size)):
            code = ctypes.get_last_error() & 0xFFFFFFFF
            raise OSError(code, f"读取 Windows 默认连接代理失败（错误码 {code}，选项 {values.error}）。")
        strings = [ctypes.wstring_at(options[i].value.pointer) if options[i].value.pointer else "" for i in (1, 2, 3)]
        return {"flags": int(options[0].value.number), "server": strings[0], "bypass": strings[1], "autoConfigUrl": strings[2]}
    finally:
        for i in (1, 2, 3):
            if options[i].value.pointer:
                kernel.GlobalFree(options[i].value.pointer)


def apply_proxy_settings(settings: ProxySettings) -> None:
    settings = parse_proxy_settings(settings)
    wininet = ctypes.WinDLL("wininet", use_last_error=True)
    wininet.InternetSetOptionW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    wininet.InternetSetOptionW.restype = wintypes.BOOL
    options = (_Option * 4)()
    options[0].option, options[0].value.number = 1, settings["flags"]
    buffers = [ctypes.create_unicode_buffer(settings[key]) for key in ("server", "bypass", "autoConfigUrl")]
    for index, buffer in enumerate(buffers, 1):
        options[index].option = index + 1
        options[index].value.pointer = ctypes.cast(buffer, ctypes.c_void_p).value
    values = _OptionList(ctypes.sizeof(_OptionList), None, 4, 0, options)
    if not wininet.InternetSetOptionW(None, 75, ctypes.byref(values), ctypes.sizeof(values)):
        code = ctypes.get_last_error() & 0xFFFFFFFF
        raise OSError(code, f"设置 Windows 默认连接代理失败（错误码 {code}，选项 {values.error}）。")
    # Some clients still read these compatibility fields instead of the connection API.
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, int(bool(settings["flags"] & 2)))
        winreg.SetValueEx(key, "ProxyServer", 0, winreg.REG_SZ, settings["server"])
    for notification in (95, 37):
        if not wininet.InternetSetOptionW(None, notification, None, 0):
            code = ctypes.get_last_error() & 0xFFFFFFFF
            raise OSError(code, f"通知 Windows 刷新代理失败（错误码 {code}，通知 {notification}）。")
    if read_proxy_settings() != settings:
        raise RuntimeError("Windows 默认连接代理写入后复核不一致；代理备份已保留，请停止并恢复代理。")


def capture_proxy_settings(original: ProxySettings, server: str) -> ProxySettings:
    return {**original, "flags": 3, "server": server}
