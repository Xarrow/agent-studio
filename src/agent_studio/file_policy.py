"""助手文件权限策略 —— 一处收口「能读什么、写什么要点头」。

用户的四条语义（别自己改）
------------------------
1. **禁区**：``~/.hermes`` —— 读写都拒。判定必须先做 realpath：符号链接指过来也算，
   否则 ``ln -s ~/.hermes /tmp/h`` 之后读 ``/tmp/h/config.yaml`` 就绕过去了。
2. **读**：除禁区外不限制 —— 家目录、别家会话目录、系统目录都能读，**不要确认**。
3. **写**：当前会话工作目录内直接放行（不打扰）；工作目录之外的一切写入
   （家目录其他位置、别家会话目录、系统目录）先弹确认卡；拒绝或超时（无人值守）
   就是不执行。
4. **危险模式**：用户在设置里主动打开后，第 3 条的确认全部跳过；默认关。
   它是**显式同意**，所以不受「助手自己那档权限」影响。

为什么不在 AgentScope 的权限引擎里做
----------------------------------
引擎只认「在不在工作目录内」，而且 ``bypass`` 模式会跳过全部 ASK。用户要的是
**平台级的文件语义**：读不打扰、越界写必须点头，跟某个助手选了哪档权限无关。
所以这一层夹在引擎之前在 ``guard.py`` 里执行，且 bypass 也压不住它 ——
唯一能跳过的只有「危险模式」这个开关（用户亲手打开的那一个）。

审计
----
被确认 / 被拒绝 / 被危险模式跳过 / 被禁区拦截，四类都要留一条（``audit``）。
写在文件类操作这一层而不是工具内部：工具内部只知道"写成功了"，不知道
"是谁点头的"。
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------- #
# 禁区
# --------------------------------------------------------------------------- #
#: 平台自己的运行目录。``~/.hermes`` 是语义，``/root/.hermes`` 是本机真实的那个
#: （服务用户和 Hermes 的 home 不一定是同一个，两个都要挡）。
_PROTECTED_EXTRA = tuple(
    x.strip() for x in (os.environ.get("STUDIO_PROTECTED_DIRS") or "").split(",") if x.strip()
)


def _home() -> str:
    return os.path.expanduser("~")


def protected_roots() -> tuple[str, ...]:
    """禁区清单（都是 realpath 形态）。随 HOME 变化时也正确 —— 不缓存死。"""
    raw = [os.path.join(_home(), ".hermes"), "/root/.hermes", *_PROTECTED_EXTRA]
    out: list[str] = []
    for item in raw:
        real = os.path.realpath(os.path.expanduser(item))
        if real and real not in out:
            out.append(real)
    return tuple(out)


def real_path(raw: str, base: str | None = None) -> str:
    """把任意写法解析成绝对 realpath。

    · ``~`` 展开、相对路径按 ``base``（会话工作目录）算
    · **realpath**：路径里任何一段是符号链接，都按最终落点算
      —— 指向禁区的链接因此拦得住（这是本模块存在的理由之一）
    · 文件还不存在也行：realpath 会解析已有的前缀，叶子原样保留
    """
    text = str(raw or "").strip().strip("'\"")
    if not text:
        return ""
    text = os.path.expanduser(text)
    if not os.path.isabs(text):
        if not base:
            return ""
        text = os.path.join(base, text)
    return os.path.realpath(text)


def _under(path: str, root: str) -> bool:
    p = path.rstrip("/") or "/"
    r = root.rstrip("/") or "/"
    if r == "/":
        return p.startswith("/")
    return p == r or p.startswith(r + "/")


def protected_hit(path: str) -> str:
    """这个路径是不是禁区（返回命中的禁区根，空 = 不是）。

    调用方传进来的应当已经是 ``real_path`` 的结果；这里再兜一次 realpath，
    免得某条新路径忘了规范化就漏判。
    """
    if not path:
        return ""
    target = path if os.path.isabs(path) else real_path(path)
    if not target:
        return ""
    candidates = {target, os.path.realpath(target)}
    for root in protected_roots():
        for cand in candidates:
            if _under(cand, root):
                return root
    return ""


def protected_pattern_hit(pattern: str) -> str:
    """glob 模式里能确定的静态前缀落在禁区？（``/root/.hermes/**`` 连文件名都不该列）

    只认绝对路径 / ``~`` 开头的模式；相对模式按工作目录算，那不该拦
    （``**/*.md`` 这种在工作目录里找文件是正常干活）。
    """
    raw = (pattern or "").strip().strip("'\"")
    if not raw or not (raw.startswith("/") or raw.startswith("~")):
        return ""
    static = re.split(r"[*?\[]", raw, maxsplit=1)[0].rstrip("/")
    if not static:
        return ""
    return protected_hit(real_path(static))


def protected_verdict_reason(hit: str) -> str:
    """给人看的拒绝理由 —— 用户要求原话是「该目录受保护」。"""
    return f"该目录受保护（{hit} 是 Hermes 自己的运行目录，助手不能读也不能写）"


# --------------------------------------------------------------------------- #
# 路径与工作区
# --------------------------------------------------------------------------- #
def inside(path: str, roots: "list[str] | tuple[str, ...] | str | None") -> bool:
    if not roots:
        return False
    seq = [roots] if isinstance(roots, str) else list(roots)
    for root in seq:
        if not root:
            continue
        base = os.path.realpath(str(root))
        if _under(path, base):
            return True
    return False


def rel(path: str, workspace: str | None) -> str:
    """给界面用的相对路径（就在工作目录里时显示 ``./x``，更短更好认）。"""
    if workspace:
        base = os.path.realpath(workspace)
        if _under(path, base) and path != base:
            return "./" + os.path.relpath(path, base)
    return path


# --------------------------------------------------------------------------- #
# 操作描述（确认卡上要看清：哪个助手、写哪儿、干什么、写什么）
# --------------------------------------------------------------------------- #
OP_CREATE = "新建"
OP_OVERWRITE = "覆盖"
OP_DELETE = "删除"
OP_MOVE = "移动"

#: 直接点名文件的工具
FILE_READ_TOOLS = {
    "read",
    "readfile",
    "glob",
    "grep",
    "ls",
    "listdir",
    "notebookread",
}
FILE_WRITE_TOOLS = {
    "write",
    "writefile",
    "edit",
    "multiedit",
    "notebookedit",
    "delete",
    "move",
    "rename",
    "mkdir",
}
COMMAND_TOOLS = {"bash", "shell", "sh", "zsh", "run_command", "terminal", "execute", "cmd", "proc_start", "procstart"}
CODE_TOOLS = {"python", "pythonrepl", "python_repl", "py", "ipython", "notebook", "execute_code"}

#: 会写盘的 shell 命令（值 = 这个命令的"目标"取哪几个词元）
_WRITE_COMMANDS = {
    "cp", "mv", "install", "rsync", "tee", "touch", "mkdir", "ln", "truncate",
    "chmod", "chown", "sed", "dd", "rm", "rmdir", "unlink", "srm", "trash",
    "curl", "wget", "tar", "unzip", "gzip", "gunzip", "zip", "split", "shred",
}

_PREVIEW_CHARS = 600
_DIFF_LINES = 8


def _read_text(path: str, limit: int = 4000) -> str:
    """读已有文件的开头（给确认卡做"覆盖前是什么"的对照）。失败就当空。"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except Exception:  # noqa: BLE001 —— 读不了就只显示新内容
        return ""


def _lines(text: str, n: int) -> list[str]:
    out = [ln.rstrip() for ln in (text or "").splitlines()[:n]]
    return out


@dataclass
class Action:
    """一次文件动作（确认卡与审计共用这一份事实）。"""

    path: str
    op: str
    #: 相对工作目录的写法（界面显示用）
    shown: str = ""
    inside: bool = False
    protected: str = ""
    #: 目标是否已存在（决定"新建"还是"覆盖"）
    exists: bool = False
    size: int = 0
    lines: int = 0
    #: 内容摘要（新建/覆盖：前几行；命令：命令本身）
    preview: str = ""
    #: 覆盖/修改时的差异要点（before 前几行 / after 前几行）
    before: list[str] = field(default_factory=list)
    after: list[str] = field(default_factory=list)
    #: 命令通道的来源命令（审计里留着，用户能看出是怎么写的）
    command: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "shown": self.shown or self.path,
            "op": self.op,
            "inside": self.inside,
            "protected": self.protected,
            "exists": self.exists,
            "size": self.size,
            "lines": self.lines,
            "preview": self.preview,
            "before": self.before,
            "after": self.after,
            "command": self.command,
        }


def _stat(path: str) -> tuple[bool, int]:
    try:
        st = os.stat(path)
        return True, int(st.st_size)
    except OSError:
        return False, 0


def _finish(act: Action, workspace: str | None) -> Action:
    act.inside = inside(act.path, workspace) if workspace else False
    act.protected = protected_hit(act.path)
    exists, size = _stat(act.path) if not act.protected else (False, 0)
    act.exists = act.exists or exists
    if not act.size:
        act.size = size
    act.shown = rel(act.path, workspace)
    return act


def _content_summary(content: str) -> tuple[str, int]:
    text = content or ""
    return text[:_PREVIEW_CHARS], len(text.splitlines())


def action_for_tool(name: str, data: dict | None, workspace: str | None) -> Action | None:
    """文件类工具 → 一次动作描述。读类工具没有"写动作"，返回 None。"""
    short = _short(name)
    d = data or {}
    if not isinstance(d, dict):
        return None
    if short in {"glob", "grep", "ls", "listdir", "notebookread", "read", "readfile"}:
        return None
    if short not in FILE_WRITE_TOOLS:
        return None

    raw = ""
    for key in ("file_path", "path", "notebook_path", "target_file", "target", "file", "dest"):
        val = d.get(key)
        if isinstance(val, str) and val.strip():
            raw = val
            break
    if not raw:
        return None
    path = real_path(raw, workspace)
    if not path:
        return None

    if short in {"delete"}:
        op = OP_DELETE
    elif short in {"move", "rename"}:
        op = OP_MOVE
    elif short == "mkdir":
        op = OP_CREATE
    else:
        op = OP_OVERWRITE if os.path.exists(path) else OP_CREATE

    act = Action(path=path, op=op)
    content = d.get("content")
    if short in {"write", "writefile"} and isinstance(content, str):
        act.preview, act.lines = _content_summary(content)
        if act.op == OP_OVERWRITE:
            act.before = _lines(_read_text(path), _DIFF_LINES)
            act.after = _lines(content, _DIFF_LINES)
            act.lines = len(content.splitlines())
    elif short in {"edit", "multiedit", "notebookedit"}:
        old = d.get("old_string") or d.get("old") or ""
        new = d.get("new_string") or d.get("new") or ""
        if isinstance(old, str) and isinstance(new, str):
            act.preview = (new[:200] or old[:200]).strip()
            act.before = _lines(str(old), _DIFF_LINES)
            act.after = _lines(str(new), _DIFF_LINES)
    if short in {"move", "rename"}:
        dest = d.get("destination") or d.get("to") or ""
        if isinstance(dest, str) and dest.strip():
            act.after = [real_path(dest, workspace)]
    return _finish(act, workspace)


# --------------------------------------------------------------------------- #
# 命令 / 代码里的写入（尽力而为，汇报里要写清边界）
# --------------------------------------------------------------------------- #
def _short(name: str) -> str:
    n = (name or "").split("/")[-1].split(".")[-1].lower()
    if "__" in n:
        n = n.split("__")[-1]
    return n


def _tokens(seg: str) -> list[str]:
    import shlex

    try:
        return shlex.split(seg, comments=False, posix=True)
    except ValueError:
        return seg.split()


_SPLIT = re.compile(r"\|\||&&|;;|;|\n|\|")


def _looks_like_path(tok: str) -> bool:
    if not tok or tok.startswith("-") or "://" in tok:
        return False
    if tok in {".", ".."}:
        return True
    return tok.startswith("/") or tok.startswith("~") or "/" in tok or tok.startswith("./")


def _op_for_command(cmd: str, tokens: list[str]) -> str:
    base = os.path.basename(cmd)
    if base in {"rm", "rmdir", "unlink", "srm", "trash"}:
        return OP_DELETE
    if base in {"mv", "rename"}:
        return OP_MOVE
    if base == "mkdir":
        return OP_CREATE
    if base in {"chmod", "chown"}:
        return OP_OVERWRITE
    return OP_CREATE


def actions_for_command(command: str, workspace: str | None) -> list[Action]:
    """从一条 shell 命令里挑出「它要写到哪个文件」。

    只认常见的写命令（cp/mv/tee/mkdir/rm/ln/sed -i/curl -o/tar/dd of=…）。
    这是**静态**判定，动态展开（``$(...)``、变量拼路径）看不出来 ——
    真正兜底的是执行完的审计与禁区硬拦，别把这里当沙箱。
    """
    out: list[Action] = []
    text = command or ""
    for seg in [s.strip() for s in _SPLIT.split(text) if s.strip()]:
        tokens = _tokens(seg)
        if not tokens:
            continue
        # 跳过前缀（sudo/nohup/VAR=1）
        i = 0
        while i < len(tokens) and (tokens[i].startswith("-") or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i])):
            i += 1
        if i >= len(tokens):
            continue
        cmd = os.path.basename(tokens[i])
        args = tokens[i + 1 :]

        # 重定向 > / >> / tee 单独算（它们不依赖命令名）
        for m in re.finditer(r"(?:^|\s)\d?>{1,2}\s*([^\s;|&]+)", seg):
            target = m.group(1)
            if target.startswith("/") or target.startswith("~") or target.startswith("./"):
                p = real_path(target, workspace)
                if p:
                    act = Action(path=p, op=OP_OVERWRITE if os.path.exists(p) else OP_CREATE, command=seg[:240])
                    out.append(_finish(act, workspace))

        if cmd not in _WRITE_COMMANDS:
            continue

        paths = [a for a in args if _looks_like_path(a)]
        if cmd == "dd":
            paths = [a[3:] for a in args if a.startswith("of=")]
        if cmd == "sed":
            # 只有 -i 才是写；否则只是过滤
            if not any(a.startswith("-i") or a == "--in-place" for a in args):
                continue
            # 第一个非选项参数是编辑脚本（`s/a/b/`）—— 它自带 `/`，会被
            # _looks_like_path 当成文件；剔掉脚本后剩下的才是要写的文件。
            rest = [a for a in args if not a.startswith("-")]
            paths = [a for a in rest[1:] if _looks_like_path(a)]
        if cmd in {"curl", "wget"}:
            # 只有 -o / -O / --output 才落盘
            outs: list[str] = []
            for idx, a in enumerate(args):
                if a in {"-o", "--output"} and idx + 1 < len(args):
                    outs.append(args[idx + 1])
                elif a.startswith("--output="):
                    outs.append(a.split("=", 1)[1])
            paths = outs
        if not paths:
            continue
        # cp/mv/ln/install/rsync：落点是最后一个参数（源在前）
        target = paths[-1] if cmd in {"cp", "mv", "ln", "install", "rsync"} else paths[0]
        p = real_path(target, workspace)
        if not p:
            continue
        op = _op_for_command(cmd, tokens)
        if op in {OP_CREATE, OP_OVERWRITE}:
            op = OP_OVERWRITE if os.path.exists(p) else OP_CREATE
        act = Action(path=p, op=op, command=seg[:240])
        out.append(_finish(act, workspace))
    return out


_PY_WRITE_RE = re.compile(
    r"(?:open|io\.open)\s*\(\s*[f]?['\"]([^'\"\n]{1,400})['\"]\s*,\s*[^)]*['\"][wax+][bta+]*['\"]"
    r"|Path\s*\(\s*[f]?['\"]([^'\"\n]{1,400})['\"]\s*\)\s*\.\s*(write_text|write_bytes|touch|mkdir)"
    r"|(?:shutil\.)?(?:copy2?|copyfile|copy_tree|copytree|move)\s*\(\s*[f]?['\"]([^'\"\n]{1,400})['\"]\s*,\s*[f]?['\"]([^'\"\n]{1,400})['\"]"
    r"|os\.(?:remove|unlink|rename|makedirs|mkdir)\s*\(\s*[f]?['\"]([^'\"\n]{1,400})['\"]"
)


def actions_for_code(code: str, workspace: str | None) -> list[Action]:
    """从 Python 代码里认「要写哪个绝对路径」。

    同样只覆盖常见写法；代码是图灵完备的，静态分析只能挡住模型常犯的那几类。
    """
    out: list[Action] = []
    for m in _PY_WRITE_RE.finditer(code or ""):
        groups = [g for g in m.groups() if g]
        paths = [g for g in groups if g not in {"write_text", "write_bytes", "touch", "mkdir"}]
        for raw in paths:
            if not (raw.startswith("/") or raw.startswith("~")):
                continue  # 相对路径就是工作目录里，不用问
            p = real_path(raw, workspace)
            if not p:
                continue
            op = OP_OVERWRITE if os.path.exists(p) else OP_CREATE
            out.append(_finish(Action(path=p, op=op, command=(code or "")[:240]), workspace))
        if out:
            break
    return out


def protected_paths_in(text: str, workspace: str | None = None) -> str:
    """文本里出现的禁区路径（含 ``~/.hermes``、``$HOME/.hermes`` 这些写法）。

    命令/代码是动态的，先把能看见的字面量按 realpath 判一遍；
    再退一步做子串匹配（``.hermes`` 的几种家目录写法）—— 两层都不省，
    因为 ``/root/.hermes`` 这种写法在 realpath 之前就该命中。
    """
    if not text:
        return ""
    roots = protected_roots()
    # 字面量路径：绝对路径 / ~ 开头 / $HOME 开头
    for raw in re.findall(r"(?:/|~|\$HOME|\$\{HOME\})[^\s'\"`;|&()]{0,300}", text):
        probe = raw.replace("${HOME}", _home()).replace("$HOME", _home())
        real = real_path(probe, workspace)
        hit = protected_hit(real)
        if hit:
            return hit
    for root in roots:
        if root in text:
            return root
    for alias in ("~/", "$HOME/", "${HOME}/"):
        if f"{alias}.hermes" in text:
            return os.path.join(_home(), ".hermes")
    return ""


# --------------------------------------------------------------------------- #
# 危险模式（设置项）与审计
# --------------------------------------------------------------------------- #
SKIP_KEY = "file_policy_danger_mode"
#: 进程内短期缓存：权限检查每次工具调用都要判，不能每次都读库
_SKIP_CACHE: tuple[float, bool] = (0.0, False)
_SKIP_TTL = 2.0


def invalidate_skip_cache() -> None:
    global _SKIP_CACHE
    _SKIP_CACHE = (0.0, False)


async def skip_confirm() -> bool:
    """用户是否打开了「危险模式」（跳过第 3 条的写入确认）。默认 False。"""
    global _SKIP_CACHE
    ts, val = _SKIP_CACHE
    now = time.time()
    if ts and now - ts < _SKIP_TTL:
        return val
    try:
        from .db import SessionLocal
        from .settings_store import get_setting

        async with SessionLocal() as session:
            val = bool(await get_setting(session, SKIP_KEY, False))
    except Exception:  # noqa: BLE001 —— 读不到就按默认（要确认），不能因为读库失败而放宽
        val = False
    _SKIP_CACHE = (now, val)
    return val


_NAME_CACHE: dict[str, str] = {}


async def agent_name(agent_id: str) -> str:
    """助手名字（审计与确认卡都要写清"哪个助手"）。小缓存，避免每次判权限都查库。"""
    if not agent_id:
        return ""
    if agent_id in _NAME_CACHE:
        return _NAME_CACHE[agent_id]
    name = ""
    try:
        from .db import SessionLocal
        from .models import Agent

        async with SessionLocal() as session:
            row = await session.get(Agent, agent_id)
            name = str(getattr(row, "name", "") or "")
    except Exception:  # noqa: BLE001
        name = ""
    if name:
        _NAME_CACHE[agent_id] = name
    return name


RESULT_ALLOWED = "allowed"      # 工作目录内直接放行（不打扰）
RESULT_APPROVED = "approved"    # 用户点了允许
RESULT_REJECTED = "rejected"    # 用户点了拒绝
RESULT_SKIPPED = "skipped"      # 危险模式跳过确认
RESULT_BLOCKED = "blocked"      # 禁区/敏感位置拦截

RESULT_LABELS = {
    RESULT_ALLOWED: "直接放行（工作目录内）",
    RESULT_APPROVED: "用户允许",
    RESULT_REJECTED: "用户拒绝",
    RESULT_SKIPPED: "危险模式跳过",
    RESULT_BLOCKED: "拦截（禁区）",
}


async def audit(
    action: Action | dict,
    *,
    result: str,
    rule: str = "",
    agent_id: str = "",
    run_id: str = "",
    session_id: str = "",
    name: str = "",
) -> None:
    """记一条文件操作审计。**不能因为写日志失败影响主流程**。"""
    try:
        from .db import SessionLocal
        from .models import FileAudit, now_ms

        data = action.as_dict() if isinstance(action, Action) else dict(action or {})
        who = name or await agent_name(agent_id)
        detail = data.get("command") or data.get("preview") or ""
        async with SessionLocal() as session:
            session.add(
                FileAudit(
                    ts=now_ms(),
                    agent_id=agent_id or "",
                    agent_name=who or "",
                    run_id=run_id or "",
                    session_id=session_id or "",
                    path=str(data.get("path") or "")[:2000],
                    op=str(data.get("op") or "")[:16],
                    result=result,
                    rule=rule or "",
                    detail=str(detail)[:1000],
                )
            )
            await session.commit()
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("写文件审计失败", exc_info=True)
