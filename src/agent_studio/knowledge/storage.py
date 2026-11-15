"""存储后台抽象：本地磁盘 + S3 兼容（SigV4 手写，不引第三方 SDK）。

为什么这么设计
==============
* 原始件将来可能落在 OSS / COS / MinIO / S3；应用库里只存**元数据 + 对象键**，
  换后台不影响检索与目录。
* 零第三方依赖是本项目的既有约束（`boto3` 没装、也不想为了一个桶拉进来），
  所以 S3 走标准 SigV4 签名 + httpx 直连，够用且可控。
* 内容寻址：对象键包含 sha256，天然去重；同名更新 = 新对象、老对象不动。

接口只有五个动作：put / get / delete / stat / test。
"""

from __future__ import annotations

import hashlib
import hmac
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote, urlparse

import httpx

#: 对象键 = 前缀 + 内容寻址 + 文件名（保留原名便于人工排查）
DEFAULT_TEMPLATE = "{prefix}{sha256[:2]}/{sha256}/{name}"


@dataclass
class PutResult:
    key: str
    path: str
    size: int
    sha256: str


class StorageError(RuntimeError):
    """存储层失败（页面要显示人话，不要抛原始 stack）。"""


class BaseProvider:
    type = "base"

    def put_stream(self, key: str, stream: BinaryIO, *, content_type: str = "") -> PutResult:  # pragma: no cover
        raise NotImplementedError

    def get_bytes(self, key: str) -> bytes:  # pragma: no cover
        raise NotImplementedError

    def delete(self, key: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def stat(self, key: str) -> dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def test(self) -> dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def display_path(self, key: str) -> str:
        return key


class LocalProvider(BaseProvider):
    """本地磁盘：root 下按对象键落文件。"""

    type = "local"

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _p(self, key: str) -> Path:
        target = (self.root / key).resolve()
        root = self.root.resolve()
        if root not in target.parents and target != root:
            raise StorageError("对象键越界（拒绝写到存储根目录之外）")
        return target

    def put_stream(self, key: str, stream: BinaryIO, *, content_type: str = "") -> PutResult:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        size = 0
        with p.open("wb") as f:
            while True:
                buf = stream.read(1024 * 1024)
                if not buf:
                    break
                h.update(buf)
                size += len(buf)
                f.write(buf)
        return PutResult(key=key, path=str(p), size=size, sha256=h.hexdigest())

    def get_bytes(self, key: str) -> bytes:
        return self._p(key).read_bytes()

    def delete(self, key: str) -> None:
        p = self._p(key)
        if p.is_file():
            p.unlink()

    def stat(self, key: str) -> dict[str, Any]:
        p = self._p(key)
        if not p.is_file():
            raise StorageError("对象不存在")
        st = p.stat()
        return {"size": st.st_size, "mtime": int(st.st_mtime * 1000)}

    def test(self) -> dict[str, Any]:
        stamp = time.time()
        probe = self.root / ".probe"
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            probe.write_text("ok", encoding="utf-8")
            probe.read_text(encoding="utf-8")
            probe.unlink()
        except OSError as exc:
            raise StorageError(f"本地目录不可读写：{exc}") from exc
        return {"ok": True, "latency_ms": round((time.time() - stamp) * 1000, 1)}

    def display_path(self, key: str) -> str:
        return str((self.root / key).resolve())


class S3Provider(BaseProvider):
    """S3 兼容对象存储（OSS / COS / MinIO / S3 都能用，走 path-style 或 virtual-host）。

    只实现本产品要用的四个动作；签名按 AWS SigV4 手写。
    """

    type = "s3"

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
        prefix: str = "",
        path_style: bool = True,
        timeout: float = 20.0,
    ) -> None:
        if not endpoint or not bucket:
            raise StorageError("S3 需要 endpoint 与 bucket")
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.ak = access_key
        self.sk = secret_key
        self.region = region or "us-east-1"
        self.prefix = prefix.strip("/")
        self.path_style = path_style
        self.timeout = timeout

    # ---------- 签名 ----------
    def _host(self) -> str:
        host = urlparse(self.endpoint).netloc
        return host if self.path_style else f"{self.bucket}.{host}"

    def _url(self, key: str) -> str:
        if self.path_style:
            base = f"{self.endpoint}/{self.bucket}"
        else:
            p = urlparse(self.endpoint)
            base = f"{p.scheme}://{self.bucket}.{p.netloc}"
        return f"{base}/{quote(key, safe='/')}"

    def _sign(self, method: str, key: str, payload_hash: str) -> dict[str, str]:
        now = datetime.now(timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        host = self._host()
        canonical_uri = f"/{self.bucket}/{quote(key, safe='/')}" if self.path_style else f"/{quote(key, safe='/')}"
        canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join(
            [method, canonical_uri, "", canonical_headers, signed_headers, payload_hash]
        )
        scope = f"{date}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join(
            ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()]
        )

        def _hmac(k: bytes, msg: str) -> bytes:
            return hmac.new(k, msg.encode(), hashlib.sha256).digest()

        k_date = _hmac(("AWS4" + self.sk).encode(), date)
        k_region = _hmac(k_date, self.region)
        k_service = _hmac(k_region, "s3")
        k_signing = _hmac(k_service, "aws4_request")
        signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
        return {
            "Host": host,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
            "Authorization": (
                f"AWS4-HMAC-SHA256 Credential={self.ak}/{scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            ),
        }

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    # ---------- 动作 ----------
    def put_stream(self, key: str, stream: BinaryIO, *, content_type: str = "") -> PutResult:
        data = stream.read()
        full = self._key(key)
        digest = hashlib.sha256(data).hexdigest()
        headers = self._sign("PUT", full, digest)
        if content_type:
            headers["Content-Type"] = content_type
        try:
            r = httpx.put(self._url(full), content=data, headers=headers, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise StorageError(f"上传失败：{exc}") from exc
        if r.status_code >= 400:
            raise StorageError(f"上传失败：HTTP {r.status_code} {r.text[:200]}")
        return PutResult(key=full, path=self.display_path(full), size=len(data), sha256=digest)

    def get_bytes(self, key: str) -> bytes:
        full = self._key(key)
        headers = self._sign("GET", full, hashlib.sha256(b"").hexdigest())
        try:
            r = httpx.get(self._url(full), headers=headers, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise StorageError(f"下载失败：{exc}") from exc
        if r.status_code >= 400:
            raise StorageError(f"下载失败：HTTP {r.status_code}")
        return r.content

    def delete(self, key: str) -> None:
        full = self._key(key)
        headers = self._sign("DELETE", full, hashlib.sha256(b"").hexdigest())
        try:
            r = httpx.delete(self._url(full), headers=headers, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise StorageError(f"删除失败：{exc}") from exc
        if r.status_code >= 400 and r.status_code != 404:
            raise StorageError(f"删除失败：HTTP {r.status_code}")

    def stat(self, key: str) -> dict[str, Any]:
        full = self._key(key)
        headers = self._sign("HEAD", full, hashlib.sha256(b"").hexdigest())
        try:
            r = httpx.head(self._url(full), headers=headers, timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise StorageError(f"读取失败：{exc}") from exc
        if r.status_code >= 400:
            raise StorageError("对象不存在" if r.status_code == 404 else f"HTTP {r.status_code}")
        return {"size": int(r.headers.get("content-length") or 0)}

    def test(self) -> dict[str, Any]:
        stamp = time.time()
        probe_key = f".probe-{int(stamp)}"
        import io

        self.put_stream(probe_key, io.BytesIO(b"ok"), content_type="text/plain")
        got = self.get_bytes(probe_key)
        self.delete(probe_key)
        if got != b"ok":
            raise StorageError("写入后读回内容不一致")
        return {"ok": True, "latency_ms": round((time.time() - stamp) * 1000, 1)}

    def display_path(self, key: str) -> str:
        return f"{self.endpoint}/{self.bucket}/{key}"


def build_provider(cfg) -> BaseProvider:
    """按一条 StorageConfig 造 provider（密钥已解密好传进来）。"""
    params = cfg.params or {}
    if (cfg.type or "local") == "local":
        root = params.get("root") or ""
        if not root:
            raise StorageError("本地存储缺少 root 目录")
        return LocalProvider(root)
    if cfg.type == "s3":
        secrets = getattr(cfg, "_secrets", {}) or {}
        return S3Provider(
            endpoint=str(params.get("endpoint") or ""),
            bucket=str(params.get("bucket") or ""),
            access_key=str(secrets.get("access_key") or ""),
            secret_key=str(secrets.get("secret_key") or ""),
            region=str(params.get("region") or "us-east-1"),
            prefix=str(params.get("prefix") or ""),
            path_style=bool(params.get("path_style", True)),
        )
    raise StorageError(f"不支持的存储类型：{cfg.type}")


def object_key(sha256: str, name: str, *, category: str = "未分类") -> str:
    """内容寻址的对象键：同内容同键（天然去重），保留原名便于人工排查。"""
    year = datetime.now().strftime("%Y")
    safe = (name or "file").replace("/", "_").replace("\\", "_")[:120]
    prefix = f"{category}/{year}/" if category else f"{year}/"
    return f"{prefix}{sha256[:2]}/{sha256}/{safe}"


def copy_between(src: BaseProvider, dst: BaseProvider, key: str) -> None:
    """迁移用：把对象从旧后台搬到新后台（只搬原始件，元数据在库里）。"""
    import io

    dst.put_stream(key, io.BytesIO(src.get_bytes(key)))


def move_tree(src_root: Path, dst_root: Path) -> int:
    """本地→本地的快搬（迁移向导用），返回搬了多少文件。"""
    n = 0
    if not src_root.exists():
        return 0
    for p in src_root.rglob("*"):
        if p.is_file():
            rel = p.relative_to(src_root)
            target = dst_root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(target))
            n += 1
    return n
