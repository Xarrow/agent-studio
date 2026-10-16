"""从 GitHub 仓库装 Skill —— 「像 npx skills add 那样一条引用装进来」的服务端实现。

为什么要这一层
==============
平台原来的导入要么让人贴**完整 clone URL**，要么给本地路径；而社区的技能仓库
一律是这么分发的::

    npx skills add tt-a1i/archify
    npx skills add vercel-labs/skills/skills --skill web-design
    npx skills add minio/skills/aimem --global

也就是「``owner/repo[/目录][@技能名]``」一句话 —— 用户脑子里有这个仓库地址，
不该被要求换算成 clone URL + 子目录 + 版本号三个字段。

本模块负责三件事（都是纯函数 / 无框架依赖，便于单测）：

1. **解析引用**：把 ``tt-a1i/archify``、``tt-a1i/archify@v2.16.0``、
   ``tt-a1i/archify/skills/foo``、GitHub 网页链接、``git@github.com:o/r.git``
   统一成 ``RepoRef``。
2. **取回仓库**：走 **codeload tarball**（不依赖 git 二进制，也不会因为
   代理/网络策略让完整 clone 卡几十秒）；直连失败自动换 gh-proxy 镜像。
   tarball 的根目录形如 ``archify-<sha>``，顺带能拿到 commit 短标记。
3. **发现技能**：扫 tarball 里所有含 ``SKILL.md`` 的目录 —— 与社区 CLI 的
   约定一致（``skills/``、``.agents/skills/``、``.claude/skills/``、仓库根）。
   返回可预览的候选列表（名字/描述/路径/附属文件数），安装时按选中的路径提取。

收敛点：**只认 UTF-8 文本附属文件**（提取时 esacpe 掉二进制），单文件上限
200KB —— 和平台原有的本地导入口径一致，避免把图片/二进制塞进 DB。
"""

from __future__ import annotations

import io
import os
import re
import tarfile
from dataclasses import dataclass, field
from typing import Any

import httpx
import yaml

# 单个附属文件上限（与 api/skills.py 的本地导入口径保持一致）
MAX_FILE_BYTES = 200_000
# 一个仓库最多认多少个技能（防止误指到 monorepo 根上炸出几百个）
MAX_SKILLS = 100

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)

# 社区 CLI 约定的技能目录（相对仓库根）
CONVENTION_DIRS = ("skills/", ".agents/skills/", ".claude/skills/")


@dataclass
class RepoRef:
    """一条仓库引用解析后的结果。"""

    owner: str
    repo: str
    ref: str | None = None        # 分支/标签/SHA，None = 仓库默认分支
    subpath: str | None = None    # 仓库内子目录（限定扫描范围）
    skill: str | None = None      # 只要这一个技能（按目录名或 frontmatter name 匹配）

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def display(self) -> str:
        parts = [self.slug]
        if self.subpath:
            parts.append("/" + self.subpath.strip("/"))
        s = "".join(parts)
        if self.skill:
            s += f"@{self.skill}"
        if self.ref:
            s += f"#{self.ref}"
        return s

    @property
    def web_url(self) -> str:
        base = f"https://github.com/{self.slug}"
        if self.subpath:
            return f"{base}/tree/{self.ref or 'HEAD'}/{self.subpath.strip('/')}"
        return base


def parse_repo_ref(raw: str) -> RepoRef:
    """解析各种写法的仓库引用。

    支持（都能从 ``npx skills add`` 的文档里见到）::

        tt-a1i/archify
        tt-a1i/archify/skills/diagramming
        tt-a1i/archify@v2.16.0          # @ 版本（分支/标签/SHA）
        tt-a1i/archify/skills/foo@main
        https://github.com/tt-a1i/archify
        https://github.com/tt-a1i/archify/tree/main/skills/foo
        git@github.com:tt-a1i/archify.git
        git+https://github.com/tt-a1i/archify.git

    ``--skill <name>`` 的选择结果由调用方通过 ``skill=`` 传入（网页端是勾选），
    因为 ``owner/repo/foo`` 里的 ``foo`` 既可能是目录也可能是技能名 ——
    解析阶段一律当**子目录**，匹配不到再退化成技能名（见 ``pick_skills``）。
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("请填写仓库引用，例如 tt-a1i/archify")

    # URL 形态 → 拆出 owner/repo/(tree/ref/subpath)
    m = re.match(
        r"^(?:git\+)?(?:https?://|git@|ssh://git@)(?:[^/]*github\.com|github\.com)[:/]+"
        r"(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?"
        r"(?:/tree/(?P<ref>[^/\s]+)(?:/(?P<sub>.*?))?)?/?$",
        s,
        re.IGNORECASE,
    )
    if m:
        g = m.groupdict()
        return RepoRef(
            owner=g["owner"],
            repo=g["repo"],
            ref=(g.get("ref") or None),
            subpath=((g.get("sub") or "").strip("/") or None),
        )

    if "://" in s or s.startswith("git@"):
        raise ValueError("只认 GitHub 仓库地址（https://github.com/… 或 owner/repo）")

    skill = None
    # 允许 owner/repo/sub@ref 这种「版本写在末尾」的写法
    body, _, tail = s.partition("@")
    parts = [p for p in body.split("/") if p not in ("", ".")]
    if len(parts) < 2:
        raise ValueError("要写成 owner/repo（可以多加仓库内目录，如 owner/repo/skills/foo）")
    owner, repo = parts[0], parts[1]
    subpath = "/".join(parts[2:]) or None
    ref = tail or None
    if skill and not subpath:
        subpath = skill
    return RepoRef(owner=owner, repo=repo, ref=ref, subpath=subpath, skill=skill)


# --------------------------------------------------------------------------- #
# 取回
# --------------------------------------------------------------------------- #
def tarball_urls(owner: str, repo: str, ref: str | None) -> list[str]:
    """候选下载地址，按「先直连、后镜像」排。

    本机实测：``codeload.github.com`` 直连可通（~7s），``gh-proxy.com`` 包裹
    codeload 也可通（~6s）；完整 ``git clone`` 在受限网络下最慢、最容易卡死，
    所以这里彻底不用 git。
    """
    r = ref or "HEAD"
    inner = f"https://codeload.github.com/{owner}/{repo}/tar.gz/{r}"
    return [
        inner,
        f"https://gh-proxy.com/{inner}",
        f"https://api.github.com/repos/{owner}/{repo}/tarball/{r}",
    ]


async def fetch_repo_tarball(
    ref: RepoRef, *, timeout: float = 60.0
) -> tuple[bytes, str, str | None]:
    """下载仓库 tarball → (数据, 命中的下载地址, tarball 根目录名)。

    根目录名形如 ``archify-<sha>``（按分支取时是 commit，按标签取时是标签名），
    可以当「装的是哪一版」的粗记录用；精确 SHA 由 ``resolve_head`` 单独查。
    """
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for url in tarball_urls(ref.owner, ref.repo, ref.ref):
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    errors.append(f"{url} → HTTP {resp.status_code}")
                    continue
                data = resp.content
                if len(data) < 100:
                    errors.append(f"{url} → 内容异常（{len(data)} 字节）")
                    continue
                root = _tarball_root(data)
                return data, url, root
            except httpx.HTTPError as exc:  # 超时/连接失败 → 换下一个
                errors.append(f"{url} → {exc.__class__.__name__}")
    raise ValueError("仓库下载失败：" + "；".join(errors[:3]))


def _tarball_root(data: bytes) -> str | None:
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            for name in tf.getnames()[:1]:
                return name.split("/")[0]
    except tarfile.TarError:
        return None
    return None


def tarball_sha(root: str | None) -> str | None:
    """从根目录名里抠出 40 位 commit（``archify-<sha>``）。"""
    if not root:
        return None
    m = re.search(r"-([0-9a-f]{40})$", root)
    return m.group(1) if m else None


async def resolve_head(ref: RepoRef, *, timeout: float = 12.0) -> dict[str, Any]:
    """查仓库元信息：默认分支 + 该 ref 的精确 commit。

    拿不到不算失败（匿名 API 有速率限制）—— 返回空 dict，安装照样进行，
    只是 source 里少个 sha。
    """
    headers = {}
    token = os.environ.get("GITHUB_TOKEN") or ""
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["Accept"] = "application/vnd.github+json"
    out: dict[str, Any] = {}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
            r = await client.get(f"https://api.github.com/repos/{ref.owner}/{ref.repo}")
            if r.status_code == 200:
                j = r.json()
                out["default_branch"] = j.get("default_branch")
                out["description"] = j.get("description") or ""
                out["stars"] = j.get("stargazers_count")
                out["license"] = ((j.get("license") or {}) or {}).get("spdx_id")
            target = ref.ref or out.get("default_branch") or "HEAD"
            r2 = await client.get(
                f"https://api.github.com/repos/{ref.owner}/{ref.repo}/commits/{target}"
            )
            if r2.status_code == 200:
                out["sha"] = r2.json().get("sha")
    except (httpx.HTTPError, ValueError):
        pass
    return out


# --------------------------------------------------------------------------- #
# 发现
# --------------------------------------------------------------------------- #
@dataclass
class SkillEntry:
    """仓库里的一个技能。"""

    path: str                     # 相对仓库根的目录（"" = 仓库根就是技能）
    name: str                     # frontmatter name，缺省用目录名
    description: str
    content: str                  # SKILL.md 全文
    files: dict[str, str] = field(default_factory=dict)   # 相对技能目录的附属文件

    @property
    def convention(self) -> bool:
        return any(self.path.startswith(d) or f"/{d}" in f"/{self.path}/" for d in CONVENTION_DIRS)

    def brief(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.name,
            "description": self.description,
            "files": len(self.files),
            "convention": self.convention,
        }


def parse_skill_md(text: str, fallback_name: str) -> tuple[str, str]:
    """解析 SKILL.md 的 YAML frontmatter → (name, description)。

    与 Claude Code / Hermes / AgentScope 的 skill 格式一致（和 api/skills.py 同源，
    但这里保持独立以免 import 环）。
    """
    name, description = fallback_name, ""
    m = _FRONTMATTER.match(text)
    if m:
        try:
            meta = yaml.safe_load(m.group(1)) or {}
            if isinstance(meta, dict):
                name = str(meta.get("name") or name)
                description = str(meta.get("description") or "")
        except yaml.YAMLError:
            pass
    if not description:
        body = _FRONTMATTER.sub("", text)
        for line in body.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                description = s[:200]
                break
    return name, description


def _decode(raw: bytes) -> str | None:
    """只收文本：解码失败（二进制）就跳过 —— 别把图片塞进 DB。"""
    if len(raw) > MAX_FILE_BYTES:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan_tarball(data: bytes, *, subpath: str | None = None) -> list[SkillEntry]:
    """扫出 tarball 里所有技能（按约定目录优先排序）。

    ``subpath`` 给了就只看那棵子树；那棵子树自己带 SKILL.md 时就是它一个。
    """
    want = (subpath or "").strip("/")
    found: list[SkillEntry] = []
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    except tarfile.TarError as exc:
        raise ValueError(f"仓库包解析失败: {exc}") from exc

    with tf:
        members = [m for m in tf.getmembers() if m.isfile()]
        if not members:
            raise ValueError("仓库包里没有文件")
        root = members[0].name.split("/")[0]
        skill_mds: list[tarfile.TarInfo] = []
        for m in members:
            rel = m.name[len(root) + 1 :] if m.name.startswith(root + "/") else m.name
            if rel.rsplit("/", 1)[-1] != "SKILL.md":
                continue
            if ".git" in rel.split("/"):
                continue
            if want and not (rel == "SKILL.md" or rel.startswith(want + "/") or rel == f"{want}/SKILL.md"):
                continue
            skill_mds.append(m)
        if not skill_mds:
            where = f"目录 {want}/" if want else "仓库"
            raise ValueError(f"{where}里没找到 SKILL.md —— 确认一下是不是技能仓库，或换个子目录")

        for m in skill_mds[:MAX_SKILLS]:
            rel = m.name[len(root) + 1 :]
            folder = rel[: -len("SKILL.md")].rstrip("/")
            fobj = tf.extractfile(m)
            if fobj is None:
                continue
            content = _decode(fobj.read())
            if content is None:
                continue
            files: dict[str, str] = {}
            prefix = (folder + "/") if folder else ""
            for other in members:
                orel = other.name[len(root) + 1 :]
                if orel == rel or not orel.startswith(prefix):
                    continue
                tail = orel[len(prefix) :]
                if not tail or tail.rsplit("/", 1)[-1] == "SKILL.md":
                    continue          # 子技能自己的 SKILL.md 不算附属文件
                of = tf.extractfile(other)
                if of is None:
                    continue
                text = _decode(of.read())
                if text is not None:
                    files[tail] = text
            name, description = parse_skill_md(content, folder.rsplit("/", 1)[-1] or "skill")
            found.append(
                SkillEntry(path=folder, name=name, description=description, content=content, files=files)
            )

    # 约定目录（skills/、.agents/skills/…）排前面 —— 和社区 CLI 的发现顺序一致
    found.sort(key=lambda e: (not e.convention, e.path))
    return found


def pick_skills(entries: list[SkillEntry], *, paths: list[str] | None = None) -> list[SkillEntry]:
    """按用户勾选的路径（或 ``owner/repo/名字`` 里写的名字）挑要装的技能。"""
    if not paths:
        return entries
    wanted = {(p or "").strip("/") for p in paths}
    chosen = [e for e in entries if e.path.strip("/") in wanted]
    if chosen:
        return chosen
    # 退化：把给的字符串当**技能名**匹配（目录名或 frontmatter name）
    chosen = [e for e in entries if e.name in wanted or e.path.rsplit("/", 1)[-1] in wanted]
    if chosen:
        return chosen
    raise ValueError(
        "没找到指定的技能：" + "、".join(sorted(wanted)) + "；仓库里有：" + "、".join(e.name for e in entries[:12])
    )


# --------------------------------------------------------------------------- #
# 命令行兼容层
# --------------------------------------------------------------------------- #
@dataclass
class SkillsCmd:
    """``npx skills …`` 这条命令解析后的结果。

    为什么要能解析整条命令：技能仓库 README 里写的安装方式一律是
    ``npx skills add minio/skills/aimem`` —— 用户（和助手）手里有的就是
    **这一行字**。让他自己拆成「引用 + 子目录 + 版本」三个字段，等于
    要求他先把命令读一遍再翻译，徒增出错面。所以平台直接吃整条命令。
    """

    action: str                      # add | list | remove | update | find
    ref: str | None = None           # owner/repo[/目录]（可能带 @版本）
    skill: str | None = None         # --skill
    all: bool = False                # --all
    list_only: bool = False          # --list（只看有什么）
    agents: list[str] = field(default_factory=list)   # --agent（可多次）
    global_: bool = False            # --global / -g
    yes: bool = False                # --yes / -y
    runner: str = "npx"              # npx / pnpm dlx / bunx / skills
    target: str | None = None        # remove/update 的目标（技能名或引用）


# 包执行器：命令可能以其中任何一个开头
_RUNNERS = ("npx", "pnpx", "bunx", "yarn dlx", "pnpm dlx", "npx --yes", "npx -y")
# 需要的那个包（可能是 skills / skills@latest / skills@2.1.0）
_PKG_RE = re.compile(r"^skills(@[\w.\-+]+)?$")

# action 别名：社区 CLI 与 git/npm 的习惯都认
_ACTIONS = {
    "add": "add",
    "i": "add",
    "install": "add",
    "list": "list",
    "ls": "list",
    "remove": "remove",
    "rm": "remove",
    "uninstall": "remove",
    "update": "update",
    "up": "update",
    "upgrade": "update",
    "find": "find",
    "search": "find",
    "browse": "find",
}

# npx 自己吃掉、不带值的开关
_NPX_FLAGS = {"-y", "--yes", "-q", "--quiet", "--no-install", "--ignore-existing", "--prefer-online", "-f"}
# npx 自己吃掉、带值的开关
_NPX_VALUE_FLAGS = {"-p", "--package", "--registry", "--cache", "--userconfig", "--call", "-c"}
# skills 子命令的带值开关
_SKILLS_VALUE_FLAGS = {"--skill": "skill", "-s": "skill", "--agent": "agents", "-a": "agents",
                       "--category": "category", "--name": "name", "--ref": "ref"}
# skills 子命令的布尔开关（-g/--global 在平台上默认就成立，收下不报错）
_SKILLS_BOOL_FLAGS = {"--all": "all", "--list": "list_only", "-l": "list_only",
                      "--global": "global_", "-g": "global_", "--yes": "yes", "-y": "yes",
                      "--force": "yes"}


def parse_skills_cmd(cmd: str) -> SkillsCmd | None:
    """把一条命令行解析成动作。不是 skills 命令就返回 ``None``（交给别的路径处理）。

    支持（都是社区文档里真实出现的写法）::

        npx skills add tt-a1i/archify
        npx skills@latest add minio/skills/aimem --skill aimem -g -y
        npx -y skills add owner/repo --agent 通用助手
        pnpm dlx skills add owner/repo --all
        skills add owner/repo            # 已经装过 CLI 的机器
        npx skills list / remove x / update / find 关键词

    ⚠️ 非 ``skills`` 的包（``npx cowsay``）我们**帮不了** —— 那需要真的 Node，
    所以明确返回 ``None``，让调用方把「本机没有 Node」这件事讲清楚，
    而不是假装成功（静默失败比报错更坏）。
    """
    text = (cmd or "").strip()
    if not text:
        return None
    # 允许整段粘进来（含行首 $ 、换行、注释）
    text = text.splitlines()[0].strip()
    text = text.lstrip("$").strip()
    for sep in ("&&", ";", "|"):
        if sep in text:
            text = text.split(sep)[0].strip()
    try:
        tokens = _split_tokens(text)
    except ValueError:
        return None
    if not tokens:
        return None

    runner = ""
    # ① 剥包执行器前缀（npx / pnpx / bunx / pnpm dlx / yarn dlx）
    while tokens:
        head = tokens[0]
        if head in ("npx", "pnpx", "bunx"):
            runner = head
            tokens = tokens[1:]
            break
        if head in ("pnpm", "yarn") and len(tokens) > 1 and tokens[1] == "dlx":
            runner = f"{head} dlx"
            tokens = tokens[2:]
            break
        if head == "dlx":            # `npx dlx skills` 这种写法一并容忍
            tokens = tokens[1:]
            continue
        break

    if runner:
        # ② 剥 npx 自己的开关，直到拿到包名；包名不是 skills 就与我们无关
        pkg: str | None = None
        while tokens:
            head = tokens[0]
            if head in _NPX_FLAGS:
                tokens = tokens[1:]
                continue
            if head in _NPX_VALUE_FLAGS:
                tokens = tokens[2:]
                continue
            pkg = head
            tokens = tokens[1:]
            break
        if pkg is None or not _PKG_RE.match(pkg):
            return None      # 别的 npm 包 → 需要真 Node，我们帮不了
    else:
        # ③ 直接以 CLI 自己开头：`skills add owner/repo`
        if not tokens or tokens[0] != "skills":
            return None
        runner = "skills"
        tokens = tokens[1:]

    if not tokens:
        # 光写 `npx skills` → 当「看有什么」处理
        return SkillsCmd(action="list", runner=runner)

    action = _ACTIONS.get(tokens[0].lower())
    if action is None:
        return None
    out = SkillsCmd(action=action, runner=runner)
    rest = tokens[1:]

    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in _SKILLS_BOOL_FLAGS:
            setattr(out, _SKILLS_BOOL_FLAGS[tok], True)
        elif tok in _SKILLS_VALUE_FLAGS:
            if i + 1 >= len(rest):
                raise ValueError(f"{tok} 后面要跟一个值")
            attr = _SKILLS_VALUE_FLAGS[tok]
            if attr == "agents":
                out.agents.append(rest[i + 1])
            elif attr == "skill":
                out.skill = rest[i + 1]
            i += 1
        elif tok.startswith("--") and "=" in tok:
            key, _, val = tok.partition("=")
            if key in _SKILLS_VALUE_FLAGS:
                attr = _SKILLS_VALUE_FLAGS[key]
                if attr == "agents":
                    out.agents.append(val)
                elif attr == "skill":
                    out.skill = val
        elif not tok.startswith("-"):
            if action == "add" and out.ref is None:
                out.ref = tok
            elif out.target is None:
                out.target = tok
        i += 1

    if action == "add" and not out.ref:
        raise ValueError("命令里没给仓库，比如：npx skills add tt-a1i/archify")
    return out


def _split_tokens(text: str) -> list[str]:
    """按空格切词，支持引号（README 里的命令常带引号参数）。"""
    out: list[str] = []
    cur = ""
    quote: str | None = None
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            else:
                cur += ch
        elif ch in ("'", '"'):
            quote = ch
        elif ch.isspace():
            if cur:
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if quote:
        raise ValueError("引号没闭合")
    if cur:
        out.append(cur)
    return out
