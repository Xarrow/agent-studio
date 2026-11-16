"""知识中心的数据模型：原始文档、解析分块、存储配置。

三个层次（与产品口径一致，别混）：
* **知识** = 原始文件 + 解析出的文本（这里的两张表）
* **Skill** = 给 Agent 的流程说明（models.Skill，不在这里）
* **记忆** = 长期偏好（models.Memory，不在这里）

原始件放存储后台（本地 / S3 兼容），**元数据与解析文本始终在应用库**：
这样换存储不影响检索，存储挂了也还能看目录与正文。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..models import Base, LongText, new_id, now_ms


class Doc(Base):
    """一份原始文档。"""

    __tablename__ = "doc"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("doc_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(300), default="")
    #: 扩展名归一的类型：pdf/docx/xlsx/pptx/md/txt/html/image
    kind: Mapped[str] = mapped_column(String(16), default="", index=True)
    mime: Mapped[str] = mapped_column(String(120), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    #: 内容寻址：同 sha256 = 同一份内容（去重与"新版本"判断都靠它）
    sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    #: upload | url
    source: Mapped[str] = mapped_column(String(12), default="upload", index=True)
    source_url: Mapped[str] = mapped_column(String(1000), default="")

    #: 存在哪个存储配置、对象键是什么（详情页要显示"完整路径"）
    storage_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    storage_key: Mapped[str] = mapped_column(String(600), default="")
    storage_path: Mapped[str] = mapped_column(String(1000), default="")

    #: 分类与标签（阶段 3 接分类树；这里先存 id / 扁平标签名）
    category_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    sub_category: Mapped[str] = mapped_column(String(120), default="")
    tags: Mapped[list[Any]] = mapped_column(JSON, default=list)

    #: uploading | parsing | ready | failed
    status: Mapped[str] = mapped_column(String(12), default="uploading", index=True)
    error: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: 解析摘要：{textLength, pages, sheets, parserVersion, ms}
    parsed: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: 同名更新时 +1；历史版本留在 doc_version 表（阶段 2 只做标记）
    version: Mapped[int] = mapped_column(Integer, default=1)
    #: 0~1，越小越靠前（占位，阶段 3 接"敏感/置顶"）
    rank: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class DocChunk(Base):
    """解析文本的分块（检索与"读某一段"都从这里取，不整篇塞进上下文）。"""

    __tablename__ = "doc_chunk"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("chk_"))
    doc_id: Mapped[str] = mapped_column(String(32), index=True)
    doc_version: Mapped[int] = mapped_column(Integer, default=1)
    ord: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(LongText, default="")
    #: 页码（PDF/PPT）或工作表名（XLSX）
    page: Mapped[int | None] = mapped_column(Integer, default=None)
    sheet: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class StorageConfig(Base):
    """一个存储后台（本地磁盘 / S3 兼容）。密钥只存在密文列里。"""

    __tablename__ = "storage_config"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sto_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    #: local | s3
    type: Mapped[str] = mapped_column(String(12), default="local")
    #: 非敏感参数：本地 root；S3 的 endpoint/bucket/region/prefix
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: 敏感参数（AK/SK）密文
    secret_enc: Mapped[bytes | None] = mapped_column(Text, default=None)
    #: 路径模板，如 {category}/{year}/{name}
    path_template: Mapped[str] = mapped_column(String(200), default="{category}/{year}/{name}")
    is_default: Mapped[bool] = mapped_column(Integer, default=0)
    last_test_ok: Mapped[bool | None] = mapped_column(Integer, default=None)
    last_test_at: Mapped[int | None] = mapped_column(Integer, default=None)
    last_test_error: Mapped[str] = mapped_column(LongText, default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class Category(Base):
    """分类树（最多 3 层）。origin=agent 的建议要等人确认才算数。"""

    __tablename__ = "doc_category"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("cat_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    parent_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    depth: Mapped[int] = mapped_column(Integer, default=1)
    #: user | agent
    origin: Mapped[str] = mapped_column(String(8), default="user")
    #: 用户改过的分类加锁，Agent 不再覆盖
    locked: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class DocTag(Base):
    """扁平标签（多值）。同一张表同时记"谁提的"与"是否已确认"。"""

    __tablename__ = "doc_tag"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("tag_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(80), default="", index=True)
    origin: Mapped[str] = mapped_column(String(8), default="user")
    locked: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
