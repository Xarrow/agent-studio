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

from sqlalchemy import JSON, BigInteger, Float, Integer, String, Text
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
    #: 同名更新时 +1；历史版本留在 doc_version 表
    version: Mapped[int] = mapped_column(Integer, default=1)
    #: 链接入库时另存的 HTML 快照对象键（显式字段，不再靠 "key.snapshot.html" 约定猜）
    snapshot_key: Mapped[str] = mapped_column(String(600), default="")
    #: 软删时间（毫秒）。有值即在回收站，检索与列表默认排除
    deleted_at: Mapped[int | None] = mapped_column(Integer, default=None, index=True)
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

class OrganizeJob(Base):
    """一次整理：谁、整理了哪些文档、结果如何。"""

    __tablename__ = "organize_job"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("job_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    agent_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    doc_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    #: 本次要产出的草稿种类：category / tags / summary
    kinds: Mapped[list[str]] = mapped_column(JSON, default=list)
    #: queued | running | done | failed
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    made: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    prompt_version: Mapped[str] = mapped_column(String(16), default="org-1")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    finished_at: Mapped[int | None] = mapped_column(Integer, default=None)


class OrganizeDraft(Base):
    """一条待确认的建议。**不采纳就永远不影响 doc 表**。"""

    __tablename__ = "organize_draft"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("drf_"))
    job_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    doc_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    #: category | tags | summary | skill
    kind: Mapped[str] = mapped_column(String(16), default="category", index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: pending | accepted | rejected
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    decided_at: Mapped[int | None] = mapped_column(Integer, default=None)


class StorageMigration(Base):
    """把已有文档从一个存储搬到另一个。搬的是**原件**，记录随搬随改。

    为什么要有这张表：搬几百份文档是长活，页面得知道"搬到哪了、错在哪一份"，
    不能一个请求挂在那儿等；断了也要能看清上次搬到什么程度。
    """

    __tablename__ = "storage_migration"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("mig"))
    from_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    to_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|done|failed
    total: Mapped[int] = mapped_column(Integer, default=0)
    moved: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    bytes_moved: Mapped[int] = mapped_column(BigInteger, default=0)
    keep_source: Mapped[int] = mapped_column(Integer, default=1)
    error: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    finished_at: Mapped[int] = mapped_column(BigInteger, default=0)


class DocumentVersion(Base):
    """文档的历史版本（更新=新版本，不覆盖）。

    为什么单独一张表：用户改文档后要能回滚，也要能回答「这份文件三个月前长什么样」。
    正文分块也按 ``doc_version`` 存（DocChunk 已有该列），所以回滚=把
    ``doc.version`` 指回去 + 重新灌索引，不需要搬文件。
    """

    __tablename__ = "doc_version"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("dver_"))
    doc_id: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    storage_key: Mapped[str] = mapped_column(String(600), default="")
    storage_id: Mapped[str] = mapped_column(String(32), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class DocumentTag(Base):
    """文档 ↔ 标签（多对多）。

    与 ``doc.tags``（扁平的字符串数组）并存的原因：那个只够「显示成几个胶囊」，
    这个要记**来源**（模型提的还是用户加的）、**置信度**、**是否已被采纳**。
    检索过滤、图谱、召回率统计都读这张表。
    """

    __tablename__ = "document_tag"

    doc_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    tag_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    #: model | user
    source: Mapped[str] = mapped_column(String(8), default="user")
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    #: candidate（模型提的，等人确认）| accepted
    status: Mapped[str] = mapped_column(String(12), default="accepted", index=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class SkillDraft(Base):
    """由文档/标签生成、等人工发布的 SKILL.md 草稿。

    发布才落 ``Skill``（ns=workspace）并写磁盘；草稿阶段随便改、丢了也不心疼。
    """

    __tablename__ = "skill_draft"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("skd_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(String(400), default="")
    body: Mapped[str] = mapped_column(LongText, default="")
    #: 来源：标签 id 与文档 id 列表（发布后写进 Skill.source_doc_ids / source_tag_ids）
    tag_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    doc_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    model: Mapped[str] = mapped_column(String(120), default="")
    #: draft | published | discarded
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)
    error: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class RecallLog(Base):
    """一次检索的埋点 —— 召回率面板的唯一数据来源。

    只记指标，不记正文：query 存哈希前缀 + 长度，避免把用户问句里的敏感内容落库成明文日志。
    """

    __tablename__ = "recall_log"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("rl_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    #: search（页面搜索）| agent（助手调工具）
    surface: Mapped[str] = mapped_column(String(12), default="search", index=True)
    query: Mapped[str] = mapped_column(String(300), default="")
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    top_doc_id: Mapped[str] = mapped_column(String(32), default="")
    #: name | body | tag | none
    matched_path: Mapped[str] = mapped_column(String(12), default="")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    agent_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms, index=True)
