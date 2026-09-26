"""主密钥收口：没设 STUDIO_MASTER_KEY 就不再"假装加密"。

背景（这是一条**安全红线**，不是洁癖）
--------------------------------------
``crypto.py`` 原来在 ``STUDIO_MASTER_KEY`` 未设置时回落到写死的常量
``agent-studio-dev-master-key``。而部署里只注入了 ``STUDIO_ACCESS_TOKEN``
（实测）—— 也就是说库里的 LLM key 是用一把**公开的默认钥匙**加密的：
拿到 ``data/studio.db`` 的人可以解开全部密钥。加密做得再对，钥匙在源码里就等于没加。

改成什么
--------
* **加密**（写新密钥）时，如果用的是默认钥匙 → **直接拒绝**并要求设置主密钥
  （``RuntimeError``，界面/日志都能看懂"该做什么"）。
* **解密**保持宽容：历史数据是用旧钥匙加的，读得出来才谈得上迁移
  （钥匙换了以后自然解不开，会给出"主密钥是否变更"的提示）。
* 应急出口：``STUDIO_ALLOW_DEV_KEY=1``（比如本地跑测试、临时实例）。

配套：``scripts/rotate_master_key.py`` 负责把已有密文从旧钥匙迁到新钥匙 ——
换钥匙不该意味着"密钥全部失效、重新填一遍"。
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

_DEV_KEY = "agent-studio-dev-master-key"


def master_key() -> str:
    return (os.environ.get("STUDIO_MASTER_KEY") or "").strip()


def using_dev_key() -> bool:
    """现在是不是靠默认钥匙撑着（= 没配主密钥）。"""
    return not master_key()


def allow_dev_key() -> bool:
    return (os.environ.get("STUDIO_ALLOW_DEV_KEY") or "").strip() not in ("", "0", "false")


def _fernet() -> Fernet:
    raw = master_key() or _DEV_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
    return Fernet(key)


def encrypt(plain: str) -> bytes:
    if using_dev_key() and not allow_dev_key():
        raise RuntimeError(
            "拒绝用开发默认主密钥加密：请先设置环境变量 STUDIO_MASTER_KEY"
            "（一把长随机串即可），否则密钥等于没有加密。"
            "已有密文的迁移见 scripts/rotate_master_key.py；"
            "仅本地测试时可用 STUDIO_ALLOW_DEV_KEY=1 临时放行。"
        )
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
