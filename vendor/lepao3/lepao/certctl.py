# -*- coding: utf-8 -*-
# --- lepao-research-notice v1 (do not remove; see LICENSE) ---
# 乐跑协议研究（Lepao Research） · https://github.com/dan-cun/lepao3
# Copyright (c) 2026 dan-cun · 技术讨论 QQ 1224145544（仅作技术讨论，不提供代打卡）
# 许可证 LRL-1.0（乐跑研究协议 1.0）：仅供学习 · 不可牟利 · 再发布须署名引用原始仓库 · 声明不得删除
# 删除或篡改本块即依 LRL-1.0 第三条自动终止授权；衍生版须继续以 LRL-1.0 授权并标注修改说明。
# --- end lepao-research-notice ---
"""lepao.certctl —— mitmproxy 根证书自检/安装（HTTPS 抓取的前置条件，异地部署必需）

为什么需要它：mitmweb 会对 api2.lptiyu.com 等问题域**动态签发**由本地 mitmproxy CA 签名的
证书。若该 CA 不在 Windows「受信任的根证书颁发机构」里，微信/小程序会拒绝 TLS 握手 ——
表现就是"代理已生效、mitm 已起、但永远抓不到 token"。异地新机第一次部署必踩这个坑。

本模块只做三件事，全部本地、零联网：
  status()            查：CA 文件是否已生成 + 是否已被系统信任（按 SHA1 指纹精确比对，不按名字猜）
  install(user=True)  装：certutil -addstore -user Root（当前用户库，无需管理员）；machine=True 走本机库(需管理员)
  ensure_ca_file()    生成：mitm 首启才会写 ~/.mitmproxy/*.cer，若从未起过 mitm 则临时起一次让它落盘

指纹比对而非"看有没有 mitmproxy 字样"，是因为旧版本残留 CA 会让"已安装"变成假阳性，
而真正决定成败的是**当前 ~/.mitmproxy 里这把 CA** 是否受信。
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import hashlib
import os
import re
import subprocess
import sys
import time

CA_DIR = os.environ.get("LEPAO_CA_DIR") or os.path.expanduser("~/.mitmproxy")
CA_CANDIDATES = ("mitmproxy-ca-cert.cer", "mitmproxy-ca-cert.pem")

_pslock = None


def _run(cmd, timeout=40):
    return subprocess.run(cmd, capture_output=True, text=True,
                          errors="replace", timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)


def ca_file() -> str:
    """当前 CA 公钥文件路径（不存在返回 ""）。"""
    for n in CA_CANDIDATES:
        p = os.path.join(CA_DIR, n)
        if os.path.isfile(p):
            return p
    return ""


def ca_fingerprint(path: str = "") -> str:
    """CA 证书 DER 的 SHA1 大写指纹（与 Windows 证书库 Thumbprint 同算法）。"""
    path = path or ca_file()
    if not path:
        return ""
    raw = open(path, "rb").read()
    if b"BEGIN" in raw[:64]:                       # PEM → DER
        body = re.sub(rb"-----[A-Z ]+-----|\s+", b"", raw)
        der = base64.b64decode(body)
    else:
        der = raw
    return hashlib.sha1(der).hexdigest().upper()


class _CertificateContext(ctypes.Structure):
    """Match the Windows CERT_CONTEXT layout at the native API boundary."""
    _fields_ = [("encoding", wintypes.DWORD), ("encoded", ctypes.POINTER(wintypes.BYTE)),
                ("encoded_size", wintypes.DWORD), ("info", ctypes.c_void_p), ("store", wintypes.HANDLE)]


def trusted_fingerprints(store: str = "CurrentUser") -> list[str]:
    """Read root fingerprints through Crypt32, without shell providers or subject filters."""
    locations = {"CurrentUser": 0x00010000, "LocalMachine": 0x00020000}
    if store not in locations:
        raise ValueError("Unsupported Windows certificate store scope.")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    crypt32.CertOpenStore.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p]
    crypt32.CertOpenStore.restype = wintypes.HANDLE
    crypt32.CertEnumCertificatesInStore.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    crypt32.CertEnumCertificatesInStore.restype = ctypes.c_void_p
    crypt32.CertFreeCertificateContext.argtypes = [ctypes.c_void_p]
    crypt32.CertFreeCertificateContext.restype = wintypes.BOOL
    crypt32.CertCloseStore.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    crypt32.CertCloseStore.restype = wintypes.BOOL
    name = ctypes.c_wchar_p("ROOT")
    # SYSTEM_W provider; open the existing store read-only.
    handle = crypt32.CertOpenStore(ctypes.c_void_p(10), 0, None,
                                  locations[store] | 0x00004000 | 0x00008000, ctypes.cast(name, ctypes.c_void_p))
    if not handle:
        code = ctypes.get_last_error() & 0xFFFFFFFF
        raise OSError(code, f"无法打开 Windows {store} 根证书库（错误码 0x{code:08X}）。")
    context = None
    fingerprints: list[str] = []
    try:
        while True:
            # Enumeration frees the previous context, including on end-of-store.
            context = crypt32.CertEnumCertificatesInStore(handle, context)
            if not context:
                code = ctypes.get_last_error() & 0xFFFFFFFF
                if code != 0x80092004:
                    raise OSError(code, f"无法枚举 Windows {store} 根证书库（错误码 0x{code:08X}）。")
                break
            certificate = ctypes.cast(context, ctypes.POINTER(_CertificateContext)).contents
            encoded = ctypes.string_at(certificate.encoded, certificate.encoded_size)
            fingerprints.append(hashlib.sha1(encoded).hexdigest().upper())
    finally:
        if context:
            crypt32.CertFreeCertificateContext(context)
        if not crypt32.CertCloseStore(handle, 0):
            code = ctypes.get_last_error() & 0xFFFFFFFF
            raise OSError(code, f"无法关闭 Windows {store} 根证书库（错误码 0x{code:08X}）。")
    return fingerprints


def ensure_ca_file(mitmweb: str = "", wait_s: float = 6.0) -> str:
    """确保 ~/.mitmproxy 里已生成 CA（mitm 首启才写）。返回 CA 路径或 ""。"""
    if ca_file():
        return ca_file()
    mitmweb = mitmweb or os.environ.get("LEPAO_MITM_EXE", "") or "mitmweb"
    if not (os.path.isabs(mitmweb) and not os.path.exists(mitmweb)):
        try:
            p = subprocess.Popen(
                [mitmweb, "-p", "8082", "--web-port", "8092", "--listen-host",
                 "127.0.0.1", "--set", "block_global=false", "--set", "web_open_browser=false",
                 "--set", "confdir=" + CA_DIR],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.time() + wait_s
            while time.time() < deadline and not ca_file():
                time.sleep(0.4)
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        except Exception:
            return ""
    return ca_file()


def install(user: bool = True) -> dict:
    """把当前 CA 装入受信任根。user=True → 当前用户库（免管理员，推荐）。"""
    path = ca_file() or ensure_ca_file()
    if not path:
        return {"ok": False, "step": "ca_file",
                "detail": "未找到 ~/.mitmproxy/mitmproxy-ca-cert.cer（mitm 从未运行过？）"}
    args = ["certutil"] + (["-user"] if user else []) + ["-addstore", "Root", path]
    try:
        r = _run(args, timeout=90)
    except Exception as e:
        return {"ok": False, "step": "certutil", "detail": str(e)}
    out = (r.stdout or "") + (r.stderr or "")
    store = "CurrentUser" if user else "LocalMachine"
    fingerprint = ca_fingerprint(path)
    if r.returncode != 0:
        return {"ok": False, "step": "addstore", "store": store,
                "detail": f"证书安装命令失败（退出码 {r.returncode}）：{out[-400:]}", "ca": path, "fingerprint": fingerprint}
    try:
        verified = fingerprint in trusted_fingerprints(store)
    except OSError as error:
        return {"ok": False, "step": "verify", "store": store,
                "detail": f"安装命令已结束，但无法复核证书库：{error}", "ca": path, "fingerprint": fingerprint}
    return {"ok": verified, "step": "verify", "store": store,
            "detail": "" if verified else "安装命令已结束，但目标根证书库中没有当前证书指纹。请检查账户权限或证书策略。",
            "ca": path, "fingerprint": fingerprint}



def status(mitmweb: str = "") -> dict:
    """完整体检：文件在不在 + 当前用户/本机库是否信任这把 CA（指纹精确匹配）。"""
    fp = ca_fingerprint()
    if not fp:
        fp2 = ensure_ca_file(mitmweb)
        fp = ca_fingerprint(fp2)
    u = fp in trusted_fingerprints("CurrentUser") if fp else False
    m = fp in trusted_fingerprints("LocalMachine") if fp else False
    return {
        "ca_file": ca_file(), "ca_present": bool(ca_file()),
        "fingerprint": fp, "trusted_user": u, "trusted_machine": m,
        "trusted": bool(u or m),
        "hint": ("" if (u or m) else
                 "未受信 → HTTPS 抓取会失败(小程序拒绝 mitm 证书)。修复: 跑 一键配置.ps1 "
                 "或 py -3 cli.py cert --install（当前用户库，免管理员）"),
    }


def summary_line(st: dict = None) -> str:
    st = st or status()
    if st["trusted"]:
        where = "本机库" if st["trusted_machine"] else "当前用户库"
        return "mitm CA 已受信({} · {})".format(where, st["fingerprint"][:12])
    if not st["ca_present"]:
        return "mitm CA 尚未生成(首次启动 mitmweb 会自动生成)"
    return "mitm CA 未受信 → 抓不到号！需安装证书"
