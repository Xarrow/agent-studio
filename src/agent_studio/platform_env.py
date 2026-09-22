"""运行环境探测（平台层通用）。

用于判断"某个能力在当前操作系统上是否可用" —— 最典型的场景是内置工具：

- ``PowerShell`` 只在 Windows 上可用
- ``Bash`` 只在 Linux / macOS 上可用

不适用时应当**在页面上提示并限制**，而不是等 Agent 执行到那一步才报错。

这是平台层的通用设施（不依赖任何 Agent 框架），任何运行时都能用。
"""

from __future__ import annotations

import platform
import sys

#: 归一化平台名（与 ``sys.platform`` 保持一致）
LINUX = "linux"
MACOS = "darwin"
WINDOWS = "win32"

_PLATFORM_LABELS = {
    LINUX: "Linux",
    MACOS: "macOS",
    WINDOWS: "Windows",
    "cygwin": "Windows (Cygwin)",
    "msys": "Windows (MSYS)",
}

#: 平台层认可的三类目标环境
PLATFORM_SUPPORTED: list[str] = [LINUX, MACOS, WINDOWS]


def current_platform() -> str:
    """当前平台标识（``linux`` / ``darwin`` / ``win32``）。"""
    return sys.platform


def platform_label(plat: str | None = None) -> str:
    """人类可读的平台名，用于 UI 提示。"""
    p = plat or current_platform()
    return _PLATFORM_LABELS.get(p, p)


def platform_detail() -> str:
    """详细环境描述，例如 ``Linux 7.0.2-6-pve (x86_64)``。"""
    return f"{platform.system()} {platform.release()} ({platform.machine()})"


def check_platform(platforms: list[str] | None) -> tuple[bool, str]:
    """判断某能力在当前平台是否适用。

    参数
    ----
    platforms:
        该能力要求的平台列表；``None`` 或空列表表示**全平台适用**。

    返回
    ----
    ``(是否适用, 不适用时的说明文案)``
    """
    if not platforms:
        return True, ""
    current = current_platform()
    if current in platforms:
        return True, ""
    wanted = " / ".join(platform_label(p) for p in platforms)
    return False, f"当前服务器是 {platform_label(current)}，该工具仅在 {wanted} 上可用"
