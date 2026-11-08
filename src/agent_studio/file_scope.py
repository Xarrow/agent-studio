"""文件范围的"上限"：哪些目录内核允许写、哪些位置永远看不到。

为什么要单独一个模块、并且在保存时就校验
--------------------------------------
限制是两层：平台层按助手判（可读/可写范围），内核层按服务判（systemd 挂载）。
内核那层是**物理上限**，平台层的配置改不动它。于是会出现两种"配了没用"：

· 把 /opt 配进可写范围 → 平台放行，写的时候内核回 Read-only file system
· 把 /root/.hermes 配进可读范围 → 平台本来就会拒（凭据黑名单），内核还遮着

两种都会让用户以为"我配了怎么不生效"。所以保存时就校验，而不是等跑起来才
发现。上限从环境变量读（部署时与 systemd drop-in 对齐），默认值就是本机这套。
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from .guardrails import SENSITIVE_NAMES, SENSITIVE_PREFIXES


def _split(raw: str | None, fallback: Sequence[str]) -> tuple[str, ...]:
    if not raw:
        return tuple(fallback)
    items = [x.strip().rstrip("/") or "/" for x in raw.split(",") if x.strip()]
    return tuple(items) or tuple(fallback)


#: 内核允许写的目录（systemd ReadWritePaths）。写窗口之外也能写 = 沙箱没配好。
SANDBOX_WRITABLE: tuple[str, ...] = _split(
    os.environ.get("STUDIO_SANDBOX_WRITABLE"),
    ("/srv/src/agent-studio", "/srv/www", "/tmp", "/var/tmp", "/dev/shm"),
)
#: 内核里被遮掉的位置（systemd InaccessiblePaths）+ 平台黑名单，两者都碰不到。
SANDBOX_HIDDEN: tuple[str, ...] = tuple(
    dict.fromkeys(list(SENSITIVE_PREFIXES) + list(_split(os.environ.get("STUDIO_SANDBOX_HIDDEN"), ("/root/.hermes", "/root/.ssh", "/root/.aws"))))
)


def _inside(path: str, roots: Sequence[str]) -> bool:
    p = path.rstrip("/") or "/"
    for root in roots:
        r = root.rstrip("/") or "/"
        if r == "/":
            return True
        if p == r or p.startswith(r + "/"):
            return True
    return False


def normalize(guard: dict | None) -> dict | None:
    """把历史遗留写法改写成现在能真生效的样子（原地返回清理后的字典）。

    老配置里 `roots: ["/"]` 的意思是"跟 Hermes 一样全盘"——内核做不到写全盘，
    但**读**全盘是可以的（除了被遮的凭据点）。所以把它挪到 read_roots：
    意图保留，能力对齐。不这么做的话，那批助手连跑都跑不起来（校验会在开跑时抛）。
    """
    if not isinstance(guard, dict):
        return guard
    roots = guard.get("roots")
    reads = guard.get("read_roots")

    def _clean(items):
        if not isinstance(items, list):
            return items
        out: list[str] = []
        for it in items:
            v = str(it or "").strip()
            if not v:
                continue
            if v != "/":
                v = v.rstrip("/")
            if v not in out:
                out.append(v)
        return out

    roots = _clean(roots)
    reads = _clean(reads)

    if isinstance(roots, list) and "/" in roots:
        # "/" 想表达的是"随便写"。内核只放开那几个窗口，所以换成窗口本身：
        # 平台层不再逐条问，实际能写的范围跟物理上限一致。
        roots = [r for r in roots if r != "/"]
        for w in SANDBOX_WRITABLE:
            if w not in roots:
                roots.append(w)
        if isinstance(reads, list) and "/" not in reads:
            reads = reads + ["/"]
    if isinstance(roots, list):
        guard["roots"] = roots
    if isinstance(reads, list):
        guard["read_roots"] = reads
    return guard


def problems(guard: dict | None) -> list[str]:
    """保存前校验一个助手的 guard 配置。返回人话描述的问题列表（空 = 没问题）。"""
    if not isinstance(guard, dict):
        return []
    out: list[str] = []

    for key, label in (("read_roots", "可读范围"), ("roots", "可写范围")):
        raw = guard.get(key)
        if raw is None:
            continue
        if not isinstance(raw, list):
            out.append(f"{label}要写成目录列表")
            continue
        for item in raw:
            path = str(item or "").strip()
            if path != "/":
                path = path.rstrip("/")  # 注意别把 "/" 剥成空串（那会静默跳过校验）
            if not path:
                continue
            if not path.startswith("/"):
                out.append(f"{label}必须是绝对路径：{item}")
                continue
            hit = next((h for h in SANDBOX_HIDDEN if _inside(path, (h,))), "")
            if hit or os.path.basename(path) in SENSITIVE_NAMES:
                out.append(f"{label}里不能有凭据位置（{hit or os.path.basename(path)}）：内核根本看不到它，配了也不会生效")
                continue
            if key == "roots" and not _inside(path, SANDBOX_WRITABLE):
                allowed = "、".join(SANDBOX_WRITABLE)
                out.append(
                    f"可写范围里的 {path} 写不进去：这台机器的沙箱只允许写 {allowed}。"
                    "要放开得改服务级配置（部署那侧），不是助手配置。"
                )
    return out


def describe() -> dict[str, list[str]]:
    """给前端用的上限说明（不落库，随代码走）。"""
    return {
        "writable": list(SANDBOX_WRITABLE),
        "hidden": list(SANDBOX_HIDDEN),
    }
