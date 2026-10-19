# -*- coding: utf-8 -*-
# --- lepao-research-notice v1 (do not remove; see LICENSE) ---
# 乐跑协议研究（Lepao Research） · https://github.com/dan-cun/lepao3
# Copyright (c) 2026 dan-cun · 技术讨论 QQ 1224145544（仅作技术讨论，不提供代打卡）
# 许可证 LRL-1.0（乐跑研究协议 1.0）：仅供学习 · 不可牟利 · 再发布须署名引用原始仓库 · 声明不得删除
# 删除或篡改本块即依 LRL-1.0 第三条自动终止授权；衍生版须继续以 LRL-1.0 授权并标注修改说明。
# --- end lepao-research-notice ---
# Copyright (c) 2026 dan-cun · 许可协议见项目根目录 LICENSE
"""Publish explicit workflow phases within the current worker context."""
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Literal

Phase = Literal["preparing", "waiting-login", "validating", "executing", "confirming", "restoring"]
_observer: ContextVar[Callable[[Phase], None] | None] = ContextVar("lepao_progress", default=None)

@contextmanager
def observe(callback: Callable[[Phase], None]) -> Iterator[None]:
    token = _observer.set(callback)
    try:
        yield
    finally:
        _observer.reset(token)

def report_phase(phase: Phase) -> None:
    callback = _observer.get()
    if callback is not None:
        callback(phase)
