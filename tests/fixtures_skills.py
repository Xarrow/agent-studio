"""受控夹具：本地裸 Git 仓库、归档 HTTP 服务、记录型代理、自签名 CA。

全部离线可复现：不访问任何外部网络，端口都取随机空闲端口。
"""

from __future__ import annotations

import http.server
import io
import os
import socket
import socketserver
import ssl
import subprocess
import tarfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SKILL_MD = "---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\n{body}\n"


def skill_tree(root: Path, skills: dict[str, str]) -> Path:
    """造一棵「仓库」：{技能名: 描述} → skills/<名字>/SKILL.md + 附属文件。"""
    for name, desc in skills.items():
        d = root / "skills" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(SKILL_MD.format(name=name, desc=desc, body="示例指令"), encoding="utf-8")
        (d / "note.md").write_text(f"{name} 的附属文件\n", encoding="utf-8")
    return root


def make_git_repo(root: Path, files: dict[str, str] | None = None) -> str:
    """建一个真 Git 仓库并提交，返回 commit sha。"""
    root.mkdir(parents=True, exist_ok=True)
    if files:
        for rel, text in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
    }
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=root, env=env, capture_output=True, text=True, check=True
    )
    run("init", "-q", "-b", "main")
    run("add", "-A")
    run("commit", "-q", "-m", "init")
    return run("rev-parse", "HEAD").stdout.strip()


def git_clone_bare(src: Path, dest: Path) -> Path:
    subprocess.run(["git", "clone", "-q", "--bare", str(src), str(dest)], check=True, capture_output=True)
    return dest


def tarball_of(root: Path, *, strip_top: str = "repo-main") -> bytes:
    """把目录打成 GitHub 风格的 tar.gz（顶层目录一个）。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            tf.add(p, arcname=f"{strip_top}/{p.relative_to(root)}")
    return buf.getvalue()


def evil_tarball(kind: str) -> bytes:
    """构造恶意压缩包：路径穿越 / 绝对路径 / 符号链接 / 设备文件。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        if kind == "traversal":
            data = b"pwn"
            ti = tarfile.TarInfo("../evil.txt")
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
        elif kind == "absolute":
            data = b"pwn"
            ti = tarfile.TarInfo("/etc/evil.txt")
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
        elif kind == "symlink":
            ti = tarfile.TarInfo("link")
            ti.type = tarfile.SYMTYPE
            ti.linkname = "/etc/passwd"
            tf.addfile(ti)
        elif kind == "device":
            ti = tarfile.TarInfo("dev")
            ti.type = tarfile.CHRTYPE
            tf.addfile(ti)
    return buf.getvalue()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --------------------------------------------------------------------------- #
# 归档 HTTP 服务
# --------------------------------------------------------------------------- #
@dataclass
class ArchiveServer:
    """按路径回不同内容：{"/repo.tar.gz": bytes}；支持重定向与 429/407。"""

    routes: dict[str, bytes] = field(default_factory=dict)
    redirects: dict[str, str] = field(default_factory=dict)
    statuses: dict[str, int] = field(default_factory=dict)
    hits: list[str] = field(default_factory=list)
    port: int = 0
    _srv: Any = None

    def start(self) -> "ArchiveServer":
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.hits.append(self.path)
                if self.path in outer.statuses:
                    code = outer.statuses[self.path]
                    self.send_response(code)
                    self.send_header("Content-Length", "0")
                    if code == 407:
                        self.send_header("Proxy-Authenticate", 'Basic realm="x"')
                    self.end_headers()
                    return
                if self.path in outer.redirects:
                    self.send_response(302)
                    self.send_header("Location", outer.redirects[self.path])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = outer.routes.get(self.path)
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/gzip")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # 安静
                return

        self.port = free_port()
        self._srv = socketserver.ThreadingTCPServer(("127.0.0.1", self.port), H)
        self._srv.daemon_threads = True
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._srv:
            self._srv.shutdown()
            self._srv.server_close()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"


# --------------------------------------------------------------------------- #
# 记录型代理（支持 CONNECT 与绝对 URI 转发，可选 Basic 认证）
# --------------------------------------------------------------------------- #
@dataclass
class ProxyFixture:
    require_auth: str = ""          # "user:pass" 或空
    log: list[dict[str, Any]] = field(default_factory=list)
    port: int = 0
    _srv: Any = None

    def start(self) -> "ProxyFixture":
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _auth_ok(self) -> bool:
                if not outer.require_auth:
                    return True
                got = self.headers.get("Proxy-Authorization", "")
                import base64

                want = "Basic " + base64.b64encode(outer.require_auth.encode()).decode()
                return got.strip() == want

            def do_CONNECT(self):  # noqa: N802
                outer.log.append({"method": "CONNECT", "target": self.path, "auth": bool(self.headers.get("Proxy-Authorization"))})
                if not self._auth_ok():
                    self.send_response(407)
                    self.send_header("Proxy-Authenticate", 'Basic realm="fixture"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                host, _, port = self.path.partition(":")
                try:
                    up = socket.create_connection((host, int(port or 443)), timeout=10)
                except OSError:
                    self.send_error(502)
                    return
                self.send_response(200, "Connection Established")
                self.end_headers()
                self._tunnel(up)

            def _tunnel(self, up):
                import select

                socks = [self.connection, up]
                while True:
                    r, _, _ = select.select(socks, [], [], 5)
                    if not r:
                        break
                    for s in r:
                        data = s.recv(65536)
                        if not data:
                            up.close()
                            return
                        (up if s is self.connection else self.connection).sendall(data)

            def do_GET(self):  # noqa: N802
                outer.log.append({"method": "GET", "target": self.path, "auth": bool(self.headers.get("Proxy-Authorization"))})
                if not self._auth_ok():
                    self.send_response(407)
                    self.send_header("Proxy-Authenticate", 'Basic realm="fixture"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                import urllib.request

                req = urllib.request.Request(self.path, headers={
                    k: v for k, v in self.headers.items()
                    if k.lower() not in ("proxy-authorization", "proxy-connection", "connection", "host")
                })
                try:
                    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
                        body = resp.read()
                        self.send_response(resp.status)
                        for k, v in resp.headers.items():
                            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                                self.send_header(k, v)
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                except Exception:  # noqa: BLE001
                    self.send_error(502)

            def log_message(self, *a):
                return

        self.port = free_port()
        self._srv = socketserver.ThreadingTCPServer(("127.0.0.1", self.port), H)
        self._srv.daemon_threads = True
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._srv:
            self._srv.shutdown()
            self._srv.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


# --------------------------------------------------------------------------- #
# 自签名 CA + 本地 HTTPS 服务
# --------------------------------------------------------------------------- #
def make_self_signed(tmp: Path, host: str = "127.0.0.1") -> tuple[Path, Path]:
    """生成自签名证书（cryptography 已随依赖装好，不新增依赖）。"""
    from datetime import datetime, timedelta

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow() - timedelta(days=1))
        .not_valid_after(datetime.utcnow() + timedelta(days=30))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host), x509.IPAddress(__import__("ipaddress").ip_address(host))]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_p = tmp / "key.pem"
    cert_p = tmp / "cert.pem"
    key_p.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    cert_p.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_p, key_p


@dataclass
class HttpsServer(ArchiveServer):
    cert: Path | None = None
    key: Path | None = None

    def start(self) -> "HttpsServer":
        super().start()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(self.cert), keyfile=str(self.key))
        self._srv.socket = ctx.wrap_socket(self._srv.socket, server_side=True)
        return self

    @property
    def base(self) -> str:
        return f"https://127.0.0.1:{self.port}"


def wait_port(port: int, timeout: float = 5.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"端口 {port} 没起来")
