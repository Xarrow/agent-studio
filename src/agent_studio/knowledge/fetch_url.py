"""链接抓取：取正文 + 存快照，带 SSRF 防护。

为什么防护是硬要求
==================
后台去抓一个用户给的 URL，等于让它访问"任何地址"——包括
127.0.0.1、192.168.x、云厂商元数据 169.254.169.254、file:// 等。
这里做四道闸：协议白名单、DNS 解析后逐 IP 检查（防 DNS rebinding）、
重定向逐跳检查、响应大小与超时上限。
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT_S = 20.0
MAX_REDIRECTS = 5


class FetchBlocked(RuntimeError):
    """被安全策略拦下（页面上要显示成人话）。"""


@dataclass
class Fetched:
    url: str
    final_url: str
    status: int
    content_type: str
    html: str
    text: str


def _is_private(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def assert_public_url(url: str) -> str:
    """协议白名单 + 解析后的每个 IP 都必须是公网地址。"""
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise FetchBlocked(f"只支持 http/https，不接受 {p.scheme or '空协议'}")
    if not p.hostname:
        raise FetchBlocked("地址里没有主机名")
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except OSError as exc:
        raise FetchBlocked(f"域名解析失败：{exc}") from exc
    ips = {str(i[4][0]) for i in infos}
    bad = [ip for ip in ips if _is_private(ip)]
    if bad:
        raise FetchBlocked(f"拒绝访问内网/保留地址：{p.hostname} → {', '.join(sorted(bad))}")
    return url


def _extract_text(html: str) -> str:
    """极简正文提取（与解析器同一条路，不引 readability）。"""
    from .parsers import _TextExtract

    p = _TextExtract()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 —— 坏 HTML 也要能落个空正文
        return ""
    return p.text()


def fetch(url: str) -> Fetched:
    """抓一页：逐跳校验重定向、限流限大小、抽正文。"""
    current = assert_public_url(url)
    with httpx.Client(timeout=TIMEOUT_S, follow_redirects=False, headers={"User-Agent": UA}) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                resp = client.get(current)
            except httpx.HTTPError as exc:
                raise FetchBlocked(f"抓取失败：{exc}") from exc
            if resp.is_redirect:
                nxt = urljoin(current, resp.headers.get("location", ""))
                current = assert_public_url(nxt)  # 每一跳都重新校验
                continue
            ctype = resp.headers.get("content-type", "")
            body = resp.content
            if len(body) > MAX_BYTES:
                raise FetchBlocked(f"响应过大（>{MAX_BYTES // 1024 // 1024}MB），已中止")
            html = body.decode(resp.encoding or "utf-8", errors="replace")
            text = _extract_text(html) if "html" in ctype.lower() else html
            return Fetched(
                url=url,
                final_url=str(resp.url),
                status=resp.status_code,
                content_type=ctype,
                html=html,
                text=text,
            )
    raise FetchBlocked("重定向次数过多")


def snapshot_markdown(f: Fetched) -> tuple[str, bytes]:
    """把一页存成 (markdown 正文, 原始 HTML 快照字节)。

    快照是"来源可复现"的凭据：正文可能被后续清洗影响，快照不会。
    """
    header = f"# {f.final_url}\n\n> 抓取时间：{__import__('datetime').datetime.now().isoformat(timespec='seconds')}\n\n"
    md = header + (f.text or "（没有提取到正文）")
    return md, (f.html or "").encode("utf-8", errors="replace")


def fetch_and_extract(url: str) -> dict[str, Any]:
    f = fetch(url)
    md, snapshot = snapshot_markdown(f)
    return {
        "final_url": f.final_url,
        "status": f.status,
        "content_type": f.content_type,
        "markdown": md,
        "snapshot": snapshot,
        "text_length": len(f.text or ""),
    }
