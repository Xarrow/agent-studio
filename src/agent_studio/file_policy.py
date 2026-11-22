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
读也要留痕：**禁区里的读尝试**（结果是拦截）与**工作区之外的读**（结果是放行）
都记，``op`` 写「读」；工作区内的读不记（读是放开策略里最频繁的动作，
全记会把审计淹掉 —— 设置页的文案必须写明这个范围）。
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
#: 读（审计里要和写分开记 —— 禁区里的 ``ls`` 曾经被记成"写"，
#: 用户看不出那是「读被拦」还是「写被拦」）
OP_READ = "读"

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

#: 删除/新建这类**多目标**命令：每个参数都是一个独立目标（`rm -f a b` 删两个）。
#: 只取第一个参数会让确认卡与审计少列目标，而命令实际全都执行了。
_MULTI_TARGET_COMMANDS = {"rm", "rmdir", "unlink", "srm", "trash", "touch", "truncate", "shred"}

#: 写到这些「伪设备」等于没落盘 —— 判据是**实际效果**，不是命令里出现没出现 ``>``。
#: 现场（2026-11）：``ls /var/lib/... 2>/dev/null`` 被当成「覆盖 /dev/null」弹了
#: 一张危险写入确认卡，用户被迫去拒一条只是看一眼目录的读命令。
PSEUDO_TARGETS = frozenset(
    {
        "/dev/null",
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/tty",
        "/proc/self/fd/1",
        "/proc/self/fd/2",
    }
)


def is_pseudo_target(path: str) -> bool:
    """这个写入目标是不是伪设备/已打开的 fd（= 没有实际落盘）。"""
    if not path:
        return False
    p = os.path.normpath(path)
    return p in PSEUDO_TARGETS or p.startswith("/dev/fd/")


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


@dataclass
class CommandUnit:
    """命令里一段**可以独立保留或丢弃**的单元（顶层 ``;`` / ``&&`` / 换行隔开）。

    为什么要切：一条复合命令里可能同时含「已被用户拒绝的动作」和「新的动作」。
    整条拦下会让新动作失去被确认的机会，整条放过又会把被拒的那个再执行一遍 ——
    所以按单元裁决：丢掉被拒的单元，剩下的照常走（见 guard.``_decide_writes``）。
    """

    sep: str
    text: str
    actions: list["Action"] = field(default_factory=list)


#: 单元之间能安全拼接的分隔符。``||`` 不在此列：丢掉左操作数之后 ``a || b``
#: 还照原样跑 b 就变了语义（b 原本只在 a 失败时执行），所以带 ``||`` 的命令
#: 一律按「不可拆分」处理。
_SAFE_SEPS = {";", "&&", "\n"}


def _split_units(command: str) -> list[CommandUnit] | None:
    """按顶层 ``;`` / ``&&`` / 换行切单元；引号、括号、反引号里的不算。

    返回 ``None`` = 不能安全切分（引号/括号不平衡、heredoc、``||`` 连接）。
    宁可判「不可拆分」，也不要切坏一条命令 —— 那等于执行了别的东西。
    """
    text = command or ""
    if not text.strip():
        return []
    if "<<" in text:  # heredoc：整段是一个整体
        return None
    units: list[CommandUnit] = []
    buf: list[str] = []
    depth = 0
    quote = ""
    sep = ""
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote != "'" and i + 1 < n:
                buf.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = ""
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(text[i + 1])
            i += 2
            continue
        if ch in "([{":
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch in ")]}":
            depth -= 1
            buf.append(ch)
            i += 1
            continue
        if depth == 0 and text.startswith(("&&", "||"), i):
            if text.startswith("||", i):
                return None
            units.append(CommandUnit(sep=sep, text="".join(buf)))
            buf, sep = [], "&&"
            i += 2
            continue
        if depth == 0 and ch in ";\n":
            units.append(CommandUnit(sep=sep, text="".join(buf)))
            buf, sep = [], ("\n" if ch == "\n" else ";")
            i += 1
            continue
        buf.append(ch)
        i += 1
    if quote or depth != 0:
        return None
    units.append(CommandUnit(sep=sep, text="".join(buf)))
    return [u for u in units if u.text.strip()]


def command_units(command: str, workspace: str | None) -> list[CommandUnit] | None:
    """把命令切成单元，并解析出**每个单元**要写的文件。

    ``None`` = 不能安全拆分（调用方按「整条命令」处理）。
    """
    units = _split_units(command)
    if units is None:
        return None
    for unit in units:
        unit.actions = _unit_actions(unit.text, workspace)
    return units


def join_units(units: list[CommandUnit], keep: list[int]) -> str:
    """按原分隔符把保留的单元拼回一条命令（第一个保留单元不带分隔符）。"""
    out = ""
    for pos, idx in enumerate(keep):
        unit = units[idx]
        body = unit.text.strip()
        if pos == 0:
            out = body
            continue
        sep = unit.sep if unit.sep in _SAFE_SEPS else ";"
        out += ("\n" if sep == "\n" else f" {sep} ") + body
    return out


def _dedupe(actions: list[Action]) -> list[Action]:
    """同一个（操作, 路径）只留一条 —— 卡片与拒绝名单都不该出现两遍。"""
    seen: set[tuple[str, str]] = set()
    out: list[Action] = []
    for act in actions:
        key = (act.op, act.path)
        if key in seen:
            continue
        seen.add(key)
        out.append(act)
    return out


def _unit_actions(text: str, workspace: str | None) -> list[Action]:
    """一段命令（可以含管道）里它要写到哪个文件。"""
    out: list[Action] = []
    for seg in [s.strip() for s in _SPLIT.split(text or "") if s.strip()]:
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

        # 重定向 > / >> / tee 单独算（它们不依赖命令名）。伪设备目标不算 ——
        # `2>/dev/null` 这类降噪重定向没有实际效果，弹卡只会淹没真动作。
        for m in re.finditer(r"(?:^|\s)\d?>{1,2}\s*([^\s;|&]+)", seg):
            target = m.group(1)
            if target.startswith("/") or target.startswith("~") or target.startswith("./"):
                p = real_path(target, workspace)
                if p and not is_pseudo_target(p):
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
        if cmd == "mkdir":
            # `mkdir`（含 `-p`）到**已存在的目录**没有任何实际变更 —— 不弹卡、
            # 也不进拒绝名单。现场：助手先 `mkdir -p /var/lib/agent-studio`，
            # 目录本来就在，弹出来的卡却是「覆盖 /var/lib/agent-studio」。
            dirs = [real_path(a, workspace) for a in paths]
            dirs = [d for d in dirs if d]
            if dirs and all(os.path.isdir(d) for d in dirs):
                continue
        if not paths:
            continue
        # 删除类命令（rm/rmdir/unlink…）与 touch：**每个参数都是一个目标**。
        # 只取 paths[0] 会让卡上只列一个文件、审计也只记一条，而命令实际把
        # 后面几个一并删了（现场：rm -f a.txt b.txt 卡上只有 a）—— 卡、审计、
        # 实际执行三者必须对得上。
        if cmd in _MULTI_TARGET_COMMANDS:
            op_multi = _op_for_command(cmd, tokens)
            for raw in paths:
                p_multi = real_path(raw, workspace)
                if not p_multi or is_pseudo_target(p_multi):
                    continue
                act_multi = Action(path=p_multi, op=op_multi, command=seg[:240])
                out.append(_finish(act_multi, workspace))
            continue
        # cp/mv/ln/install/rsync：落点是最后一个参数（源在前）
        target = paths[-1] if cmd in {"cp", "mv", "ln", "install", "rsync"} else paths[0]
        p = real_path(target, workspace)
        if not p or is_pseudo_target(p):
            continue
        op = _op_for_command(cmd, tokens)
        if op in {OP_CREATE, OP_OVERWRITE}:
            op = OP_OVERWRITE if os.path.exists(p) else OP_CREATE
        act = Action(path=p, op=op, command=seg[:240])
        out.append(_finish(act, workspace))
    return _dedupe(out)


def actions_for_command(command: str, workspace: str | None) -> list[Action]:
    """从一条 shell 命令里挑出「它要写到哪个文件」（全部目标，按出现顺序）。

    只认常见的写命令（cp/mv/tee/mkdir/rm/ln/sed -i/curl -o/tar/dd of=…）。
    这是**静态**判定，动态展开（``$(...)``、变量拼路径）看不出来 ——
    真正兜底的是执行完的审计与禁区硬拦，别把这里当沙箱。

    判据是**实际效果**，不是字面量：写到 ``/dev/null`` 的重定向、对已存在目录的
    ``mkdir``、纯读命令带的无害重定向都不算写入动作（用户 2026-11 指出的噪音）。
    """
    units = command_units(command, workspace)
    if units is None:
        return _unit_actions(command, workspace)
    out: list[Action] = []
    for unit in units:
        out.extend(unit.actions)
    return _dedupe(out)


# --------------------------------------------------------------------------- #
# 读：审计也要分得清「读」和「写」
# --------------------------------------------------------------------------- #
#: 只读性质的 shell 命令。``ls ~/.hermes`` 被拦时审计要记「读」，
#: 不是记成「写」（用户 2026-11 指出的缺陷）。
_READ_COMMANDS = {
    "ls", "ll", "la", "dir", "cat", "head", "tail", "less", "more", "bat",
    "wc", "stat", "file", "du", "df", "tree", "find", "grep", "egrep", "sed",
    "fgrep", "rg", "ag", "awk", "cut", "sort", "uniq", "diff", "cmp",
    "md5sum", "sha1sum", "sha256sum", "sha512sum", "strings", "readlink",
    "realpath", "jq", "yq", "xxd", "od", "tac", "nl", "locate", "hexdump",
}

#: 这些命令的第一个非选项参数是「模式」不是路径（``grep a /path``）
_PATTERN_FIRST = {"grep", "egrep", "fgrep", "rg", "ag"}


def action_for_read_tool(name: str, data: dict | None, workspace: str | None) -> Action | None:
    """读类工具 → 一条「读」动作（只给审计用，不参与「要不要问」的判定）。"""
    short = _short(name)
    d = data if isinstance(data, dict) else {}
    raw = ""
    for key in ("file_path", "filePath", "path", "notebook_path", "dir", "directory", "target_file", "file"):
        val = d.get(key)
        if isinstance(val, str) and val.strip():
            raw = val.strip()
            break
    if not raw and short in {"glob", "grep", "rg"}:
        for key in ("pattern", "glob", "file_pattern"):
            val = d.get(key)
            if isinstance(val, str) and val.strip() and val.strip()[:1] in ("/", "~"):
                # `/root/.hermes/**` → 静态前缀 `/root/.hermes`
                raw = re.split(r"[*?\[]", val.strip(), maxsplit=1)[0].rstrip("/") or "/"
                break
    if not raw:
        return None
    path = real_path(raw, workspace)
    if not path:
        return None
    return _finish(Action(path=path, op=OP_READ), workspace)


def read_actions_for_command(command: str, workspace: str | None) -> list[Action]:
    """一条 shell 命令里「它要读哪些文件」（静态解析，和写那条同源同局限）。

    只认常见的只读命令；``cat a | grep b`` 这种拆段后逐段判。
    判定不出来（``ls`` 不带路径 = 读工作目录）就返回空 —— 工作目录内的读不记。
    """
    out: list[Action] = []
    for seg in [s.strip() for s in _SPLIT.split(command or "") if s.strip()]:
        tokens = _tokens(seg)
        if not tokens:
            continue
        i = 0
        while i < len(tokens) and (
            tokens[i].startswith("-") or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i])
        ):
            i += 1
        if i >= len(tokens):
            continue
        cmd = os.path.basename(tokens[i])
        args = tokens[i + 1 :]
        # 重定向的**源**也算读（`echo x > f` 里的 f 不是读；`cmd < f` 是）
        if cmd not in _READ_COMMANDS:
            continue
        if cmd == "sed" and any(a.startswith("-i") or a == "--in-place" for a in args):
            continue  # sed -i 是写，归写那条
        paths = [a for a in args if _looks_like_path(a)]
        if cmd in _PATTERN_FIRST:
            # 第一个非选项参数是模式（`grep foo /path`）—— 但它也可能是路径写法；
            # 模式里带 `/` 的例子（`grep a/b f`）在这种静态解析里分不清，故取最后一个。
            paths = paths[-1:] or []
        if not paths:
            continue
        for target in paths[:3]:
            p = real_path(target, workspace)
            if p:
                out.append(_finish(Action(path=p, op=OP_READ, command=seg[:240]), workspace))
    return out


def first_path_in(text: str, workspace: str | None = None) -> str:
    """命令文本里第一个像路径的词元（审计兜底：判定不出动作类型时给个能认的路径）。"""
    for raw in re.findall(r"(?:^|[\s'\"=<>|;])((?:/|~/|\./)[^\s'\"`;|&()]{0,300})", text or ""):
        real = real_path(raw, workspace)
        if real:
            return real
    return ""


def is_read_command(command: str) -> bool:
    """这条命令是不是只读性质（只看每段的首个词）。

    审计分类用：解析不出具体路径时，``ls``/``cat`` 仍要记「读」，
    而 ``shutdown``/``mkfs`` 这类被拦下时不能顺手记成「读」（那是谎报操作类型）。
    """
    for seg in [s.strip() for s in _SPLIT.split(command or "") if s.strip()]:
        tokens = _tokens(seg)
        i = 0
        while i < len(tokens) and (
            tokens[i].startswith("-") or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i])
        ):
            i += 1
        if i < len(tokens) and os.path.basename(tokens[i]) in _READ_COMMANDS:
            return True
    return False


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
#: 重复发起已被拦下（不是用户这次又拒绝了一次 —— 绝不能记成「用户拒绝」）
RESULT_REPEAT_BLOCKED = "repeat_blocked"

RESULT_LABELS = {
    RESULT_ALLOWED: "直接放行",
    RESULT_APPROVED: "用户允许",
    RESULT_REJECTED: "用户拒绝",
    RESULT_SKIPPED: "危险模式跳过",
    RESULT_BLOCKED: "拦截（禁区）",
    RESULT_REPEAT_BLOCKED: "重复发起已拦截",
}


# --------------------------------------------------------------------------- #
# 会话级「已拒绝动作」名单
# --------------------------------------------------------------------------- #
#: 名单里一条最多 1024 字符（与 models.SessionDeniedAction.path 对齐）
_MAX_PATH = 1024

#: 说「别做」的词 —— 出现这些就**不**算重新要求（宁可按拦截处理）
_RETRY_STOP = (
    "不要写", "别写", "不用写", "不想写", "不写了", "不要动", "别动", "不要删", "别删",
    "不要再", "别再来", "算了", "取消", "不用了", "不要做", "别做", "先别",
)

#: 「明确要求做这个动作」的动词（按操作类型分开：拒绝的是新建，说「删了它」不算重提）
_RETRY_VERBS: dict[str, tuple[str, ...]] = {
    OP_CREATE: (
        "写", "新建", "创建", "生成", "保存", "落盘", "存到", "存成", "覆盖", "重写",
        "再试", "重试", "重做", "重来", "继续写", "再写", "试试", "write", "create", "save", "overwrite",
    ),
    OP_OVERWRITE: (
        "写", "覆盖", "改", "更新", "重写", "保存", "落盘", "再试", "重试", "重做", "重来",
        "试试", "write", "overwrite", "save", "update",
    ),
    OP_DELETE: ("删", "删除", "移除", "清掉", "delete", "remove"),
    OP_MOVE: ("移动", "挪", "改名", "重命名", "move", "rename"),
}


_WORD_RE = re.compile(r"[a-z0-9]+")
#: 「标识符式」文件名（含数字/连字符/下划线/点）—— 这种名字里的单词元是有意义的
#: （``b2fix2-a`` 里的 ``a`` 就是用户嘴里的「A」文件），普通英文文件名不放宽。
_STEM_IDENT_RE = re.compile(r"[0-9_.-]")


def names_path(text: str, path: str) -> bool:
    """消息里是不是点了这个文件的名字（全路径 / 文件名 / 够长的主干 / 标识符词元）。

    短于 5 个字符的主干不认 —— 「a」这种会命中任意一句话，那就不叫"明确提到"。
    """
    raw = (text or "").strip()
    if not raw or not path:
        return False
    if path in raw:
        return True
    base = os.path.basename(path)
    if base and base in raw:
        return True
    stem = os.path.splitext(base)[0]
    if len(stem) >= 5 and stem in raw:
        return True
    if len(stem) < 5 or not _STEM_IDENT_RE.search(stem):
        return False
    # 标识符式文件名：允许拿其中的**单字母**词元指代它。现场（2026-11）：被拒的是
    # ``b2fix2-a.txt``，用户说「还是把 A 写了吧」—— 他确实点的是那个文件，
    # 不该因为没说全名就当成"没重提"而继续拦。
    #
    # 刻意**不**拿多字母词元去比（``b2fix2`` 这种前缀在同一个目录里往往好几个文件
    # 共用，谁提到兄弟文件都会误命中 —— 实测就把"写 B"判成了"重提 A"）。
    # 判断不准时按否决处理：多字母只认全名/主干/文件名。
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in raw)
    for tok in _WORD_RE.findall(stem.lower()):
        if len(tok) != 1:
            continue
        if re.search(rf"(?<![A-Za-z0-9]){tok.upper()}(?![A-Za-z0-9])", raw):
            return True
        if has_cjk and re.search(rf"(?<![A-Za-z0-9]){tok}(?![A-Za-z0-9])", raw):
            return True
    return False


def explicit_retry(text: str, action: Action) -> bool:
    """用户**这条消息**是不是在明确要求重做那个被拒绝的动作。

    判断不准时按**否决**处理（宁可按拦截，也不替用户放行一个他拒绝过的写入）：
    必须同时满足「提到这个文件」+「有该操作的动词」+「没有否定词」。
    """
    raw = (text or "").strip()
    if not raw or action is None:
        return False
    if any(stop in raw for stop in _RETRY_STOP):
        return False
    if not names_path(raw, action.path):
        return False
    verbs = _RETRY_VERBS.get(action.op) or _RETRY_VERBS[OP_CREATE]
    return any(verb in raw for verb in verbs)


def _as_action(action: Action | dict | None) -> Action | None:
    """``Action`` / 确认卡上那份 dict（``file_actions``）都收，免得两处各写一套。"""
    if isinstance(action, Action):
        return action
    if isinstance(action, dict):
        path = real_path(str(action.get("path") or ""))
        if not path:
            return None
        return Action(path=path, op=str(action.get("op") or ""))
    return None


async def remember_denial(
    action: Action | dict,
    *,
    session_id: str = "",
    agent_id: str = "",
    run_id: str = "",
) -> None:
    """用户拒绝了这个动作 → 记进该会话的拒绝名单。**写失败不影响主流程**。"""
    act = _as_action(action)
    if act is None or not session_id:
        return
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import SessionDeniedAction, now_ms

        async with SessionLocal() as session:
            row = (
                await session.execute(
                    select(SessionDeniedAction).where(
                        SessionDeniedAction.session_id == session_id,
                        SessionDeniedAction.op == act.op,
                        SessionDeniedAction.path == act.path[:_MAX_PATH],
                    )
                )
            ).scalar_one_or_none()
            if row is None:
                session.add(
                    SessionDeniedAction(
                        session_id=session_id,
                        op=act.op,
                        path=act.path[:_MAX_PATH],
                        agent_id=agent_id or "",
                        run_id=run_id or "",
                        created_at=now_ms(),
                    )
                )
            else:
                row.created_at = now_ms()
                row.run_id = run_id or row.run_id
            await session.commit()
    except Exception:  # noqa: BLE001 —— 记不住名单最坏是"再问一次"，不能拖垮这一轮
        import logging

        logging.getLogger(__name__).warning("记录会话拒绝名单失败", exc_info=True)


async def forget_denial(action: Action | dict, *, session_id: str = "") -> None:
    """用户改主意点了允许（或明确重新要求并允许）→ 从名单里划掉。"""
    act = _as_action(action)
    if act is None or not session_id:
        return
    try:
        from sqlalchemy import delete

        from .db import SessionLocal
        from .models import SessionDeniedAction

        async with SessionLocal() as session:
            await session.execute(
                delete(SessionDeniedAction).where(
                    SessionDeniedAction.session_id == session_id,
                    SessionDeniedAction.op == act.op,
                    SessionDeniedAction.path == act.path[:_MAX_PATH],
                )
            )
            await session.commit()
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("清理会话拒绝名单失败", exc_info=True)


async def denied_in_session(session_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """这个会话里被拒绝过的动作（渲染进 system prompt 那份，时间正序）。"""
    if not session_id:
        return []
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import SessionDeniedAction

        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    select(SessionDeniedAction)
                    .where(SessionDeniedAction.session_id == session_id)
                    .order_by(SessionDeniedAction.created_at.asc(), SessionDeniedAction.id.asc())
                    .limit(limit)
                )
            ).scalars().all()
        return [
            {
                "op": str(r.op or ""),
                "path": str(r.path or ""),
                "ts": int(r.created_at or 0),
                "run_id": str(r.run_id or ""),
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001 —— 读不到就当没拒绝过（最坏是再问一次）
        import logging

        logging.getLogger(__name__).warning("读取会话拒绝名单失败", exc_info=True)
        return []


async def denial_hit(
    action: Action | dict,
    *,
    session_id: str = "",
    user_text: str = "",
) -> dict[str, Any] | None:
    """这条动作要不要按「用户在本会话拒绝过」拦下（返回那条事实）。

    例外：用户**这条消息**里明确重新要求同一个动作 → 返回 None（照常弹卡确认）。
    """
    act = _as_action(action)
    if act is None or not session_id:
        return None
    for item in await denied_in_session(session_id):
        if item.get("op") == act.op and item.get("path") == act.path[:_MAX_PATH]:
            if explicit_retry(user_text, act):
                return None
            return item
    return None



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
