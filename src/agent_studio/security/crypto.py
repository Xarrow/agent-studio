"""密钥加密。

主密钥来自 ``STUDIO_MASTER_KEY`` 环境变量（未设置时用开发默认值，
生产必须显式设置）。数据库里只存密文，明文永不落库。
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

_DEV_KEY = "agent-studio-dev-master-key"


def _fernet() -> Fernet:
    raw = os.environ.get("STUDIO_MASTER_KEY") or _DEV_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
    return Fernet(key)


def encrypt(plain: str) -> bytes:
    return _fernet().encrypt(plain.encode("utf-8"))


def decrypt(token: bytes) -> str:
    try:
        return _fernet().decrypt(token).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover
        raise ValueError("密钥解密失败（主密钥是否变更？）") from exc


def mask(plain: str | None) -> str:
    """日志脱敏：只留头尾。"""
    if not plain:
        return ""
    if len(plain) <= 8:
        return "*" * len(plain)
    return f"{plain[:4]}...{plain[-4:]}"
