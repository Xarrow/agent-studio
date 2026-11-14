"""网络策略：代理 / 绕过 / 自定义 CA / 超时重试 / 重定向安全。

一份策略对三条路径同时生效：
1. 原生 HTTP 下载（``httpx``，proxy 参数）；
2. ``git`` 子进程（**临时** GIT_CONFIG_GLOBAL，绝不改用户配置）；
3. 委托的 ``npx``（环境变量 + 临时 npm 配置覆盖层，绝不改用户 .npmrc）。

红线：
- 不提供全局"跳过证书校验"；
- 跨主机重定向剥离认证头；
- 不允许 https → http 降级；
- 代理密码、令牌只从调用方取，绝不写日志、绝不拼进 URL 或命令行参数。
"""

from __future__ import annotations

import ipaddress
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

LOOPBACK = ("127.0.0.0/8", "::1/128", "localhost")


def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default

PROXY_MODES = ("system", "env", "manual", "off")
MAX_REDIRECTS = 5


class NetError(RuntimeError):
    """带机器可读错误码的网络失败。"""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


@dataclass
class NetPolicy:
    proxy_mode: str = "env"                  # system | env | manual | off
    proxy_url: str = ""                      # manual 时有效：http://user:pass@host:port
    bypass: list[str] = field(default_factory=list)
    ca_file: str = ""                        # 额外受信 CA（PEM）
    connect_timeout: float = 30.0
    read_timeout: float = 120.0
    retries: int = 2
    mirrors: list[str] = field(default_factory=list)   # 有序镜像前缀
    allow_plaintext_hosts: list[str] = field(default_factory=list)
    #: 默认绕过回环地址（本地服务不该被塞进公司代理）；夹具测试会关掉它
    bypass_loopback: bool = True
    registry: str = ""                       # npm registry 覆盖（空 = 沿用用户配置）

    # ---------------- 读取 ----------------
    @classmethod
    def from_settings(cls, data: dict[str, Any] | None) -> "NetPolicy":
        d = data or {}
        mode = str(d.get("proxy_mode") or "env")
        if mode not in PROXY_MODES:
            mode = "env"
        bypass = d.get("bypass") or []
        if isinstance(bypass, str):
            bypass = [x.strip() for x in bypass.split(",") if x.strip()]
        return cls(
            proxy_mode=mode,
            proxy_url=str(d.get("proxy_url") or ""),
            bypass=[str(x).strip() for x in bypass if str(x).strip()],
            ca_file=str(d.get("ca_file") or ""),
            connect_timeout=float(d.get("connect_timeout") or 30.0),
            read_timeout=float(d.get("read_timeout") or 120.0),
            retries=_as_int(d.get("retries"), 2),
            mirrors=[str(x).strip().rstrip("/") for x in (d.get("mirrors") or []) if str(x).strip()],
            allow_plaintext_hosts=[str(x).strip().lower() for x in (d.get("allow_plaintext_hosts") or [])],
            bypass_loopback=bool(d.get("bypass_loopback", True)),
            registry=str(d.get("registry") or ""),
        )

    def public_dict(self) -> dict[str, Any]:
        """给界面看的：**不含密码**（proxy_url 里的 user:pass 抹掉）。"""
        return {
            "proxy_mode": self.proxy_mode,
            "proxy_url": scrub_url(self.proxy_url),
            "bypass": list(self.bypass),
            "ca_file": self.ca_file,
            "connect_timeout": self.connect_timeout,
            "read_timeout": self.read_timeout,
            "retries": self.retries,
            "mirrors": list(self.mirrors),
            "allow_plaintext_hosts": list(self.allow_plaintext_hosts),
            "bypass_loopback": self.bypass_loopback,
            "registry": self.registry,
        }

    # ---------------- 代理判定 ----------------
    def should_bypass(self, host: str) -> bool:
        h = (host or "").lower().strip(".")
        if not h:
            return True
        rules = list(self.bypass) + (list(LOOPBACK) if self.bypass_loopback else [])
        for rule in rules:
            r = rule.strip().lower()
            if not r:
                continue
            if "/" in r:
                try:
                    net = ipaddress.ip_network(r, strict=False)
                    ip = ipaddress.ip_address(h)
                    if ip in net:
                        return True
                except ValueError:
                    continue
                continue
            r = r.lstrip("*.")
            if h == r or h.endswith("." + r):
                return True
        return False

    def proxy_for(self, host: str) -> str | None:
        if self.should_bypass(host):
            return None
        if self.proxy_mode == "off":
            return None
        if self.proxy_mode == "manual":
            return self.proxy_url or None
        if self.proxy_mode == "env":
            return (
                os.environ.get("HTTPS_PROXY")
                or os.environ.get("https_proxy")
                or os.environ.get("ALL_PROXY")
                or os.environ.get("all_proxy")
                or os.environ.get("HTTP_PROXY")
                or os.environ.get("http_proxy")
                or None
            )
        if self.proxy_mode == "system":
            # 系统代理读 OS 设置；Linux 上没有统一接口，退化为环境变量并标注
            return (
                os.environ.get("HTTPS_PROXY")
                or os.environ.get("https_proxy")
                or os.environ.get("ALL_PROXY")
                or os.environ.get("all_proxy")
                or None
            )
        return None

    # ---------------- httpx ----------------
    def client(self, *, headers: dict[str, str] | None = None, proxy: str | None = None) -> httpx.AsyncClient:
        verify: Any = True
        if self.ca_file:
            verify = self.ca_file
        return httpx.AsyncClient(
            timeout=httpx.Timeout(self.read_timeout, connect=self.connect_timeout),
            follow_redirects=False,      # 自己走，才能做跨主机脱敏与降级拦截
            verify=verify,
            headers=headers or {},
            proxy=proxy or None,
        )

    async def get(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        auth_host: str | None = None,
        max_bytes: int | None = None,
    ) -> tuple[bytes, str]:
        """带重定向校验的 GET。

        返回 (内容, 最终 URL)。``auth_host`` 给了：只有主机与之一致时才保留
        认证头（跨主机重定向一律剥离）。
        """
        host = (urlparse(url).hostname or "").lower()
        _check_plaintext(url, self)
        hdrs = dict(headers or {})
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                return await self._get_once(url, hdrs, host, auth_host, max_bytes)
            except NetError as exc:
                if exc.code in ("redirect_downgrade", "redirect_protocol", "too_many_redirects", "http_error"):
                    raise
                last = exc
            except httpx.HTTPError as exc:
                last = exc
            if attempt < self.retries:
                import asyncio

                await asyncio.sleep(0.5 * (2**attempt))
        raise NetError(classify_error(last), f"下载失败：{last}", "检查代理/网络，或跑一次「测试连接」")

    async def _get_once(
        self,
        url: str,
        hdrs: dict[str, str],
        host: str,
        auth_host: str | None,
        max_bytes: int | None,
    ) -> tuple[bytes, str]:
        cur = url
        h = dict(hdrs)
        for _ in range(MAX_REDIRECTS + 1):
            proxy = self.proxy_for((urlparse(cur).hostname or "").lower())
            async with self.client(headers=h, proxy=proxy) as client:
                async with client.stream("GET", cur) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        loc = resp.headers.get("location")
                        if not loc:
                            raise NetError("http_error", f"重定向没有 Location：{cur}")
                        nxt = str(httpx.URL(cur).join(loc))
                        _check_redirect(cur, nxt)
                        if (urlparse(nxt).hostname or "").lower() != (urlparse(cur).hostname or "").lower():
                            # 跨主机：剥掉认证头（评审要求，不允许转发凭证）
                            h = {k: v for k, v in h.items() if k.lower() not in ("authorization", "private-token")}
                        cur = nxt
                        continue
                    if resp.status_code == 407:
                        raise NetError("proxy_auth", "代理要求认证（407）", "检查代理用户名/密码")
                    if resp.status_code == 429:
                        raise NetError("rate_limited", "对方限流（429）", "稍后再试，或配置令牌提高额度")
                    if resp.status_code >= 400:
                        raise NetError("http_error", f"HTTP {resp.status_code}：{cur}", "确认仓库存在且可访问")
                    buf = bytearray()
                    async for chunk in resp.aiter_bytes(65536):
                        buf += chunk
                        if max_bytes and len(buf) > max_bytes:
                            raise NetError("too_large", f"内容超过上限 {max_bytes} 字节", "换个来源，或放宽限制")
                    return bytes(buf), str(resp.url)
        raise NetError("too_many_redirects", "重定向次数过多", "检查来源地址是否被劫持")

    # ---------------- 子进程环境 ----------------
    def git_env(self) -> dict[str, str]:
        """git 子进程环境：临时 GIT_CONFIG_GLOBAL，不改用户配置，跑完即删。"""
        env = dict(os.environ)
        env["GIT_TERMINAL_PROMPT"] = "0"
        cfg_lines: list[str] = []
        proxy = self.proxy_for("github.com")
        if proxy:
            cfg_lines.append(f"[http]\n\tproxy = {proxy}\n")
        if self.ca_file:
            cfg_lines.append(f"[http]\n\tsslCAInfo = {self.ca_file}\n")
        if cfg_lines:
            fd, path = tempfile.mkstemp(prefix="studio-gitconfig-", suffix=".conf")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("".join(cfg_lines))
            env["GIT_CONFIG_GLOBAL"] = path
            env["GIT_CONFIG_SYSTEM"] = os.devnull
        return env

    def npm_env(self) -> dict[str, str]:
        """npx 子进程环境：代理、registry、CA 全走环境/覆盖层，不碰用户 .npmrc。"""
        env = dict(os.environ)
        proxy = self.proxy_for("registry.npmjs.org")
        if proxy:
            env["npm_config_proxy"] = proxy
            env["npm_config_https_proxy"] = proxy
            env.setdefault("HTTPS_PROXY", proxy)
        if self.ca_file:
            env["npm_config_cafile"] = self.ca_file
        if self.registry:
            env["npm_config_registry"] = self.registry
        return env


# --------------------------------------------------------------------------- #
# 判定辅助
# --------------------------------------------------------------------------- #
def scrub_url(url: str) -> str:
    """把 URL 里的用户名密码换成 ``***``（日志/界面用）。"""
    if not url or "@" not in url:
        return url
    scheme, _, rest = url.partition("://")
    if not rest:
        return url
    cred, _, host = rest.rpartition("@")
    if ":" in cred:
        user = cred.split(":", 1)[0]
        return f"{scheme}://{user}:***@{host}"
    return f"{scheme}://***@{host}"


def _check_plaintext(url: str, policy: NetPolicy) -> None:
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme == "https":
        return
    if u.scheme == "http" and host in policy.allow_plaintext_hosts:
        return
    # 回环/本机：明文是本地开发与内网服务的常态（仍然只在本机栈内）
    if u.scheme == "http" and (host in ("localhost", "::1") or host.startswith("127.")):
        return
    if u.scheme == "http":
        raise NetError(
            "insecure_transport",
            f"拒绝明文传输：{host}",
            "该来源需要 https；确实要走明文请在来源上显式勾选「允许明文传输」",
        )


def _check_redirect(cur: str, nxt: str) -> None:
    a, b = urlparse(cur), urlparse(nxt)
    if b.scheme not in ("http", "https"):
        raise NetError("redirect_protocol", f"重定向到非 http(s) 协议：{b.scheme}")
    if a.scheme == "https" and b.scheme == "http":
        raise NetError("redirect_downgrade", "重定向从 https 降级到 http，已拒绝")


def classify_error(exc: Exception | None) -> str:
    """把底层异常映射成界面能解释的错误码。"""
    if exc is None:
        return "unknown"
    text = str(exc).lower()
    name = type(exc).__name__.lower()
    if "timeout" in name or "timed out" in text:
        return "timeout"
    if "certificate" in text or "ssl" in text or "tls" in text:
        return "certificate"
    if "name or service not known" in text or "nodename nor servname" in text or "getaddrinfo" in text:
        return "dns"
    if "connection refused" in text or "connect call failed" in text:
        return "connection_refused"
    if "407" in text:
        return "proxy_auth"
    if "handshake" in text:
        return "handshake"
    return "network"
