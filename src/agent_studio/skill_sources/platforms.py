"""托管平台适配表：主机名 → 归档地址模板 / 引用解析接口 / 认证头。

内置 GitHub 与 GitLab；企业自建实例通过配置追加（用户填主机名与模板）。
**不内置任何第三方公共镜像地址**（gh-proxy 之类只能由用户自己配）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Platform:
    name: str                       # github | gitlab | git（通用）
    hosts: tuple[str, ...]
    archive_template: str = ""      # {owner} {repo} {ref} {host}
    api_template: str = ""          # 取 commit / 默认分支
    ref_template: str = ""          # 解析某个 ref 的提交：{owner} {repo} {ref}
    auth_header: str = "Authorization"
    auth_scheme: str = "Bearer"
    raw_template: str = ""          # 单文件地址（可选）
    extra_headers: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "hosts": list(self.hosts),
            "archive_template": self.archive_template,
            "api_template": self.api_template,
            "ref_template": self.ref_template,
            "auth_header": self.auth_header,
            "auth_scheme": self.auth_scheme,
            "raw_template": self.raw_template,
        }


GITHUB = Platform(
    name="github",
    hosts=("github.com", "www.github.com"),
    archive_template="https://codeload.{host}/{owner}/{repo}/tar.gz/{ref}",
    api_template="https://api.github.com/repos/{owner}/{repo}",
    ref_template="https://api.github.com/repos/{owner}/{repo}/commits/{ref}",
    # GitHub 的 tarball 端点也接受 token；归档走 codeload 时带 Authorization 会被忽略
    raw_template="https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}",
)

GITLAB = Platform(
    name="gitlab",
    hosts=("gitlab.com",),
    archive_template="https://{host}/{owner}/{repo}/-/archive/{ref}/{repo}-{ref}.tar.gz",
    api_template="https://{host}/api/v4/projects/{owner}%2F{repo}",
    ref_template="https://{host}/api/v4/projects/{owner}%2F{repo}/repository/commits/{ref}",
    auth_header="PRIVATE-TOKEN",
    auth_scheme="",
    raw_template="https://{host}/{owner}/{repo}/-/raw/{ref}/{path}",
)

GENERIC = Platform(name="git", hosts=())

BUILTIN = (GITHUB, GITLAB)


def load_platforms(extra: list[dict[str, Any]] | None = None) -> list[Platform]:
    """内置 + 用户自定义（同名主机以用户的为准）。"""
    out = {p.name: p for p in BUILTIN}
    for item in extra or []:
        try:
            host = str(item.get("host") or "").strip().lower()
            if not host:
                continue
            name = str(item.get("name") or host)
            out[f"custom:{host}"] = Platform(
                name=name,
                hosts=(host,),
                archive_template=str(item.get("archive_template") or ""),
                api_template=str(item.get("api_template") or ""),
                ref_template=str(item.get("ref_template") or ""),
                auth_header=str(item.get("auth_header") or "Authorization"),
                auth_scheme=str(item.get("auth_scheme") or ""),
                raw_template=str(item.get("raw_template") or ""),
            )
        except Exception:  # noqa: BLE001 - 配置写错不该拖垮整个页面
            continue
    return list(out.values())


def platform_for(host: str, extra: list[dict[str, Any]] | None = None) -> Platform | None:
    h = (host or "").lower()
    plats = load_platforms(extra)
    for p in plats:
        if h in p.hosts:
            return p
    # 同后缀匹配（git.example.com 命中用户登记的企业实例主机）
    for p in plats:
        for ph in p.hosts:
            if ph and h.endswith("." + ph):
                return p
    return None


def archive_url(plat: Platform, *, host: str, owner: str, repo: str, ref: str, base: str | None = None) -> str:
    tpl = plat.archive_template or GITHUB.archive_template
    url = tpl.format(host=host, owner=owner, repo=repo, ref=ref)
    if base:
        # 镜像：把模板的主机换成镜像（镜像地址由用户配，禁止内置）
        return base.rstrip("/") + "/" + url.split("://", 1)[-1].split("/", 1)[-1]
    return url
