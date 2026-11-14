"""来源字符串 → 统一来源描述（纯函数，不联网）。

契约
====
``parse_source(raw, *, sources=None, cwd=None, strict=True)`` 返回 ``SourceRef``：

    kind:      github | gitlab | git | local
    host:      主机名（本地来源为空串）
    owner/repo 仓库（本地来源为空串）
    ref:       分支/标签/SHA，None = 仓库默认分支
    subpath:   仓库内子目录（规范化，不带首尾斜杠）
    skill:     只要这一个技能（@名字）
    raw:       原始输入
    source_id: 命中的已登记来源（(I) 的 SourceDef）id，可为 None
    ambiguity: 解析时给出多种可能解释的说明（取最具体者）
    notes:     采用了哪种解释

支持的写法（按「最具体优先」匹配）
---------------------------------
本地路径：绝对/相对/``~`` 开头，且磁盘上存在
简写：``owner/repo``、``owner/repo/子路径``、``owner/repo@技能``、
      ``owner/repo#ref``、``owner/repo#ref@技能``、``owner/repo/子路径@技能``
URL：``https://github.com/o/r``、``/tree/<ref>/<sub>``、``.git`` 结尾、
     ``https://gitlab.com/o/r``、``https://host/group/sub/repo``（GitLab 多级）
SSH：``git@host:o/r.git``、``ssh://git@host:22/o/r.git``
其他：``https://host/o/r.git`` 视为通用 git；无法判断时报 unrecognized_source
已登记来源引用：``来源名:技能名``、``来源名/子路径@技能名``

安全：拒绝控制字符、空白、``..`` 片段、非 http/https/ssh 协议、file:// 与设备路径。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# 子路径/ref 里不允许出现的东西
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_BAD_SCHEMES = ("file:", "data:", "javascript:", "ftp:", "gopher:", "\\\\")
_SCP = re.compile(r"^(?P<user>[\w.\-]+)@(?P<host>[\w.\-]+):(?P<path>[^:]+)$")
_SSH_URL = re.compile(r"^ssh://(?:(?P<user>[\w.\-]+)@)?(?P<host>[\w.\-]+)(?::\d+)?/(?P<path>.+)$")
_HTTP = re.compile(r"^https?://", re.IGNORECASE)
_SLUG = re.compile(r"^[A-Za-z0-9_.\-]+$")
_OWNER_REPO = re.compile(r"^(?P<owner>[A-Za-z0-9_.\-]+)/(?P<repo>[A-Za-z0-9_.\-]+)(?P<rest>/.*)?$")
_REF_OK = re.compile(r"^[A-Za-z0-9_.\-/]{1,120}$")


class SourceError(ValueError):
    """带错误码的解析失败 —— 界面按码给下一步建议，不用猜字符串。"""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


@dataclass
class SourceRef:
    kind: str = "git"
    host: str = ""
    owner: str = ""
    repo: str = ""
    ref: str | None = None
    subpath: str | None = None
    skill: str | None = None
    raw: str = ""
    source_id: str | None = None
    ambiguity: list[str] = field(default_factory=list)
    notes: str = ""

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}" if self.owner else ""

    @property
    def is_local(self) -> bool:
        return self.kind == "local"

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "host": self.host,
            "owner": self.owner,
            "repo": self.repo,
            "ref": self.ref,
            "subpath": self.subpath,
            "skill": self.skill,
            "raw": self.raw,
            "source_id": self.source_id,
            "ambiguity": list(self.ambiguity),
            "notes": self.notes,
            "slug": self.slug,
        }


# --------------------------------------------------------------------------- #
# 校验小工具
# --------------------------------------------------------------------------- #
def _reject_bad(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        raise SourceError("empty_source", "来源是空的", "给一个地址，例如 tt-a1i/archify")
    if _CTRL.search(s):
        raise SourceError("invalid_source", "来源里含控制字符", "重新粘贴一次地址")
    low = s.lower()
    if any(low.startswith(x) for x in _BAD_SCHEMES):
        raise SourceError("invalid_source", f"不支持的协议：{s.split(':')[0]}", "只接受 http/https/ssh/git 或本地路径")
    # 任意位置的 .. 路径片段
    for seg in re.split(r"[\\/]", s):
        if seg == "..":
            raise SourceError("invalid_source", "来源里不能有 .. 片段", "用仓库内相对路径，别跳出仓库")
    return s


def _clean_seg(x: str) -> str:
    return (x or "").strip().strip("/")


def _clean_ref(ref: str | None) -> str | None:
    if not ref:
        return None
    r = ref.strip().strip("/")
    if not r:
        return None
    if not _REF_OK.match(r) or ".." in r:
        raise SourceError("invalid_ref", f"版本号不合法：{ref}", "分支/标签只接受字母数字与 . _ -")
    return r


def _split_at_tail(s: str) -> tuple[str, str | None]:
    """``owner/repo/sub@skill`` → (body, skill)。仓库名里的 @ 不算（必须出现在路径段之后）。"""
    if "@" not in s:
        return s, None
    body, _, tail = s.rpartition("@")
    if not tail or "/" in tail:
        return s, None
    return body, tail


def _split_hash_tail(s: str) -> tuple[str, str | None]:
    if "#" not in s:
        return s, None
    body, _, ref = s.rpartition("#")
    return body, _clean_ref(ref)


def _platform_of(host: str) -> str:
    h = (host or "").lower()
    if h in ("github.com", "www.github.com"):
        return "github"
    if "gitlab" in h:
        return "gitlab"
    return "git"


# --------------------------------------------------------------------------- #
# 已登记来源的引用：<来源名>:<技能> / <来源名>/<子路径>@<技能>
# --------------------------------------------------------------------------- #
def _match_registered(s: str, sources: Iterable[Any] | None) -> tuple[Any, str | None, str | None] | None:
    """在已登记来源里找 ``名字:技能`` / ``名字/子路径@技能`` 的写法。"""
    if not sources:
        return None
    table: dict[str, Any] = {}
    for sd in sources:
        name = (getattr(sd, "name", "") or "").strip()
        sid = getattr(sd, "id", "") or ""
        for key in {name, name.lower(), sid, sid.lower()}:
            if key:
                table[key] = sd
    head, sep, tail = s.partition(":")
    if sep:
        sd = table.get(head) or table.get(head.lower())
        if sd is not None:
            rest = tail.strip().strip("/")
            if not rest:
                return sd, None, None
            rest, skill = _split_at_tail(rest)
            if "/" in rest:
                return sd, rest or None, skill
            return sd, None, (skill or rest or None)
    # 名字/子路径@技能
    body, skill = _split_at_tail(s)
    for key, sd in table.items():
        if key and (body == key or body.startswith(key + "/")):
            return sd, (body[len(key) :].strip("/") or None), skill
    return None


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def parse_source(
    raw: str,
    *,
    sources: Iterable[Any] | None = None,
    cwd: str | None = None,
    strict: bool = True,
) -> SourceRef:
    """解析来源。``sources`` 给了就支持 ``<来源名>:<技能>`` 的引用写法。"""
    s = _reject_bad(raw)
    if s.lower().startswith("git+"):
        s = s[4:]

    # 1) 已登记来源（最具体：它带着认证与网络策略）
    hit = _match_registered(s, sources)
    if hit is not None:
        sd, sub, skill = hit
        return SourceRef(
            kind=getattr(sd, "kind", "git") or "git",
            host=(getattr(sd, "host", "") or ""),
            owner=(getattr(sd, "owner", "") or ""),
            repo=(getattr(sd, "repo", "") or ""),
            ref=_clean_ref(getattr(sd, "ref", None) or None) if getattr(sd, "kind", "") == "git" else None,
            subpath=_clean_seg(sub or getattr(sd, "subpath", "") or "") or None,
            skill=skill,
            raw=raw,
            source_id=getattr(sd, "id", None),
            notes=f"命中已登记来源「{getattr(sd, 'name', '')}」",
        )

    # 2) 本地路径（存在才算 —— 否则 "owner/repo" 会被误判成相对路径）
    cand = os.path.expanduser(s) if s.startswith("~") else s
    if os.path.isabs(cand) or s.startswith("./") or s.startswith("../") or s.startswith("~"):
        base = cwd or os.getcwd()
        full = os.path.abspath(os.path.join(base, cand)) if not os.path.isabs(cand) else os.path.abspath(cand)
        if os.path.isdir(full) or os.path.isfile(full):
            return SourceRef(kind="local", raw=raw, subpath=None, notes=f"本地目录 {full}")
        if strict:
            raise SourceError("local_not_found", f"本地路径不存在：{s}", "确认路径，或改用仓库地址")
        return SourceRef(kind="local", raw=raw, notes="本地路径（未找到）")
    # 裸名字在磁盘上恰好存在（相对 cwd）
    if os.path.isdir(os.path.join(cwd or os.getcwd(), s)) and "/" not in s:
        return SourceRef(kind="local", raw=raw, notes="本地目录（相对当前目录）")

    # 3) URL / SSH
    body, skill = _split_at_tail(s)
    body, ref_from_hash = _split_hash_tail(body)

    m = _SCP.match(body)
    if m:
        return _from_scp(m, body, raw, skill, ref_from_hash)
    m = _SSH_URL.match(body)
    if m:
        return _from_ssh_url(m, body, raw, skill, ref_from_hash)

    if _HTTP.match(body):
        return _from_http(body, raw, skill, ref_from_hash)

    if "://" in body:
        raise SourceError("unrecognized_source", f"看不懂这个地址：{body}", "示例：owner/repo、https://github.com/o/r、git@host:o/r.git")

    # 4) owner/repo 简写
    mg = _OWNER_REPO.match(body)
    if not mg:
        raise SourceError(
            "unrecognized_source",
            f"看不懂这个来源：{body}",
            "写法：owner/repo、owner/repo/子目录、owner/repo@技能、owner/repo#分支，或完整仓库地址",
        )
    owner, repo, rest = mg.group("owner"), mg.group("repo"), (mg.group("rest") or "")
    if not _SLUG.match(owner) or not _SLUG.match(repo):
        raise SourceError("invalid_source", f"仓库名不合法：{body}", "owner/repo 只用字母数字与 . _ -")
    sub = _clean_seg(rest)
    ambiguity: list[str] = []
    notes = "按 owner/repo 简写解析（GitHub）"
    if sub:
        # owner/repo/skills/foo 与 owner/repo/技能名 二义：解析阶段一律当子目录，
        # 发现阶段找不到同名目录时再退化成技能名匹配（pick_skills 已实现）。
        ambiguity.append(f"「{sub}」可能是子目录，也可能是技能名；先按子目录找，找不到再按技能名")
    return SourceRef(
        kind="github",
        host="github.com",
        owner=owner,
        repo=repo,
        ref=ref_from_hash,
        subpath=sub or None,
        skill=skill,
        raw=raw,
        ambiguity=ambiguity + ([f"「@{skill}」按技能名理解；若是分支/标签，用 # 明确"] if skill else []),
        notes=notes,
    )


def _from_scp(m: re.Match[str], body: str, raw: str, skill: str | None, ref: str | None) -> SourceRef:
    host = m.group("host")
    path = m.group("path")
    owner, repo, sub = _split_git_path(host, path)
    return SourceRef(
        kind=_platform_of(host),
        host=host,
        owner=owner,
        repo=repo,
        ref=ref,
        subpath=sub,
        skill=skill,
        raw=raw,
        notes="SSH 形式（取回需要 git）",
    )


def _from_ssh_url(m: re.Match[str], body: str, raw: str, skill: str | None, ref: str | None) -> SourceRef:
    host = m.group("host")
    owner, repo, sub = _split_git_path(host, m.group("path"))
    return SourceRef(
        kind=_platform_of(host),
        host=host,
        owner=owner,
        repo=repo,
        ref=ref,
        subpath=sub,
        skill=skill,
        raw=raw,
        notes="ssh:// 形式（取回需要 git）",
    )


def _split_git_path(host: str, path: str) -> tuple[str, str, str | None]:
    """``o/r.git`` → (o, r, None)；GitLab ``grp/sub/r.git`` → (grp/sub, r, None)。"""
    p = path.strip("/")
    if p.endswith(".git"):
        p = p[:-4]
    parts = [x for x in p.split("/") if x]
    if len(parts) < 2:
        raise SourceError("invalid_source", f"仓库路径不完整：{path}", "至少要有 owner/repo")
    if _platform_of(host) == "gitlab" and len(parts) > 2:
        # GitLab 支持多级 group：最后两段才是 repo 与（可能的）子目录 —— 无法区分，
        # 保守：owner = 全部前缀，repo = 最后一段
        return "/".join(parts[:-1]), parts[-1], None
    return parts[0], parts[1], "/".join(parts[2:]) or None


def _from_http(url: str, raw: str, skill: str | None, ref: str | None) -> SourceRef:
    from urllib.parse import unquote, urlparse

    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise SourceError("invalid_source", f"不支持的协议：{u.scheme}", "只接受 http/https")
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        raise SourceError("invalid_source", f"地址里没有主机名：{url}", "检查一下链接")
    segs = [x for x in u.path.split("/") if x]
    if segs and segs[0] == "-":  # gem 风格，不认
        raise SourceError("unrecognized_source", "这不是仓库地址", "用仓库根地址或 /tree/ 地址")

    # /tree/<ref>/<sub> （GitHub）与 /-/tree/<ref>/<sub>（GitLab）
    ref2, sub = ref, None
    if "tree" in segs:
        i = segs.index("tree")
        before, after = segs[:i], segs[i + 1 :]
        while before and before[-1] in ("-", "tree"):
            before = before[:-1]
        if after:
            ref2 = unquote(after[0])
            sub = "/".join(after[1:]) or None
        segs = before
    if segs and segs[-1].endswith(".git"):
        segs[-1] = segs[-1][:-4]
    if len(segs) < 2:
        raise SourceError("unrecognized_source", f"地址里看不出 owner/repo：{url}", "指向仓库根，而不是主页")
    owner = "/".join(segs[:-1])
    repo = segs[-1]
    return SourceRef(
        kind=_platform_of(host),
        host=host,
        owner=owner,
        repo=repo,
        ref=_clean_ref(ref2),
        subpath=(_clean_seg(sub or "") or None),
        skill=skill,
        raw=raw,
        notes="完整 URL",
    )
