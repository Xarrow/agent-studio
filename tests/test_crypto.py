"""护栏：没配主密钥就**不许加密**（这条是安全红线，不是洁癖）。

背景：原来未设置 ``STUDIO_MASTER_KEY`` 时会回落到写死的常量
``agent-studio-dev-master-key``，而部署里确实没设 —— 等于库里的 LLM 密钥
是用一把**公开的钥匙**加密的，拿到 studio.db 就能全解开。
这里把它钉死：默认钥匙只允许**解密**（迁移历史数据要用），不允许**加密**。
"""

from __future__ import annotations

import pytest

from agent_studio.security import crypto


def test_encrypt_refuses_dev_key(monkeypatch):
    monkeypatch.delenv("STUDIO_MASTER_KEY", raising=False)
    monkeypatch.delenv("STUDIO_ALLOW_DEV_KEY", raising=False)
    assert crypto.using_dev_key() is True
    with pytest.raises(RuntimeError) as ei:
        crypto.encrypt("sk-should-not-be-stored-with-a-public-key")
    msg = str(ei.value)
    assert "STUDIO_MASTER_KEY" in msg, "错误信息必须告诉人该做什么"
    assert "rotate_master_key" in msg, "并指出迁移已有密文的方法"


def test_encrypt_allowed_with_real_key(monkeypatch):
    monkeypatch.setenv("STUDIO_MASTER_KEY", "a-real-secret-master-key")
    monkeypatch.delenv("STUDIO_ALLOW_DEV_KEY", raising=False)
    assert crypto.using_dev_key() is False
    blob = crypto.encrypt("sk-abc123456789")
    assert blob != b"sk-abc123456789" and b"abc123" not in blob, "绝不能是明文"
    assert crypto.decrypt(blob) == "sk-abc123456789", "自己加的自己要能解开"


def test_decrypt_still_reads_legacy_dev_key_data(monkeypatch):
    """历史数据是默认钥匙加的 —— **读取必须宽容**，否则没法迁移。"""
    monkeypatch.delenv("STUDIO_MASTER_KEY", raising=False)
    monkeypatch.setenv("STUDIO_ALLOW_DEV_KEY", "1")   # 仅在需要写时放行
    blob = crypto.encrypt("legacy-key")
    monkeypatch.delenv("STUDIO_ALLOW_DEV_KEY", raising=False)
    assert crypto.decrypt(blob) == "legacy-key", "没配主密钥也要能读旧数据"


def test_wrong_key_cannot_decrypt(monkeypatch):
    monkeypatch.setenv("STUDIO_MASTER_KEY", "key-one")
    blob = crypto.encrypt("sk-x")
    monkeypatch.setenv("STUDIO_MASTER_KEY", "key-two")
    with pytest.raises(ValueError) as ei:
        crypto.decrypt(blob)
    assert "主密钥" in str(ei.value), "要提示是主密钥变了，而不是一句 NotImplementedError"


def test_mask_never_leaks_middle():
    assert crypto.mask("sk-1234567890abcdef") == "sk-1...cdef"
    assert crypto.mask("short") == "*****"
    assert crypto.mask(None) == ""
