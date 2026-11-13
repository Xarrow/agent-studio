"""会话路由 —— 多轮对话的容器管理。

会话是"短期记忆"的载体：Run 记录单次执行，Session 把多次执行串成一段对话。
两者是一对多（``run.session_id``），删除会话会级联清掉其消息，
但**不删 Run** —— Run 是观测资产，会话是对话组织方式。

**文件隔离**：会话同时也是文件目录的边界（``<work_dir>/sessions/<会话号>/``，
见 ``runner.service.resolve_work_dir``）。因此这一层还要负责：

- 会话列表/详情里告诉用户"文件在哪"（``work_dir`` 字段）
- ``GET /api/sessions/{id}/files`` 列这个会话的产物（别的会话的文件看不到）
- 删除会话时把它的目录一并清掉 —— 但**只准删 ``sessions/<会话号>``**，
  路径没对准就跳过（宁可不删，也不能误删沙箱根或别人的目录）
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Optional

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..context import clear_context
from ..db import get_session
from .. import deliverables as dlv
from ..models import Agent, Run, Session as ChatSession, SessionMessage, ToolCall, new_id, now_ms
from ..supervisor import ROUTER_SESSION_TITLE, WORKER_PREFIX
from ..runner.service import SESSION_DIR_NAME, session_work_dir
from ..schemas import (
    SessionClearContextRequest,
    SessionCreate,
    SessionDetail,
    SessionMessageRead,
    SessionRead,
    SessionUpdate,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


async def _sources_counts(session: AsyncSession, run_ids: list[str]) -> dict[str, int]:
    """每个 run 读过多少网页（只查搜索/抓取这几种工具的行，别的工具不参与）。"""
    from .. import sources as source_scan

    if not run_ids:
        return {}
    rows = (
        await session.execute(
            select(ToolCall.run_id, ToolCall.tool_name, ToolCall.args, ToolCall.result_preview)
            .where(ToolCall.run_id.in_(run_ids))
            .where(ToolCall.tool_name.in_(tuple(source_scan.SEARCH_TOOLS | source_scan.FETCH_TOOLS | source_scan.BROWSE_TOOLS)))
            .order_by(ToolCall.id)
        )
    ).all()
    by_run: dict[str, list[dict]] = {}
    for run_id, name, args, result in rows:
        by_run.setdefault(run_id, []).append(
            {"tool_name": name, "args": args, "result_preview": result}
        )
    return {rid: source_scan.collect(items)["count"] for rid, items in by_run.items()}


async def _agent_names(session: AsyncSession, agent_ids: list[str]) -> dict[str, str]:
    if not agent_ids:
        return {}
    rows = (
        await session.execute(select(Agent.id, Agent.name).where(Agent.id.in_(set(agent_ids))))
    ).all()
    return {r[0]: r[1] for r in rows}


def _published_roots() -> list[Path]:
    """可能发布到的位置（和交付时同一套优先级，只取本机存在的）。"""
    roots: list[Path] = []
    if settings.publish_dir:
        roots.append(Path(settings.publish_dir).expanduser())
    else:
        www = Path("/srv/www")
        if www.is_dir():
            roots.append(www)
        roots.append(Path(settings.work_dir) / "published")
    return roots


def _remove_published(session_id: str) -> list[str]:
    """删会话时顺便收掉它的发布副本（名字来自同一个 slug 规则）。"""
    import shutil

    gone: list[str] = []
    slug = dlv.slug_for(session_id)
    for root in _published_roots():
        target = root / slug
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
            gone.append(str(target))
    return gone


def _remove_session_dir(session_id: str) -> str | None:
    """删掉会话的工作目录。

    **护栏**：只准删 ``<work_dir>/sessions/<会话号>`` 这一层 —— 会话号要像自家
    生成的、解析后必须**严格在** ``sessions/`` 之下（不是会话根、不是沙箱根、
    不是别的目录）。对不上就返回 None 不动手：宁可不删，也不能误删别人的文件。
    """
    import shutil
    from pathlib import Path

    root = Path(settings.work_dir).resolve() / SESSION_DIR_NAME
    target = session_work_dir(session_id)
    try:
        resolved = target.resolve()
    except OSError:
        return None
    if resolved.parent != root or resolved == root or not resolved.is_dir():
        return None
    shutil.rmtree(resolved, ignore_errors=True)
    return str(resolved)


def _kind_of(title: str) -> str:
    """这个会话是什么：Router 常驻 / 派出去的一件活 / 普通对话。"""
    t = title or ""
    if t == ROUTER_SESSION_TITLE:
        return "router"
    if t.startswith(WORKER_PREFIX):
        return "worker"
    return "chat"


def _to_read(row: ChatSession, turn_count: int = 0, agent_name: str | None = None) -> SessionRead:
    return SessionRead(
        id=row.id,
        workspace_id=row.workspace_id,
        agent_id=row.agent_id,
        title=row.title or "",
        status=row.status,
        summary=row.summary,
        summarized_upto=row.summarized_upto or 0,
        message_count=row.message_count or 0,
        usage=row.usage or {},
        created_at=row.created_at,
        last_active_at=row.last_active_at,
        turn_count=turn_count,
        agent_name=agent_name,
        work_dir=str(session_work_dir(row.id)),
        kind=_kind_of(row.title or ""),
    )


@router.post("", response_model=SessionRead, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate, session: AsyncSession = Depends(get_session)
) -> SessionRead:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {payload.agent_id}")

    row = ChatSession(
        id=new_id("ses_"),
        agent_id=agent.id,
        title=(payload.title or "").strip()[:200],
        status="active",
        created_at=now_ms(),
        last_active_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_read(row, 0, agent.name)


@router.get("", response_model=list[SessionRead])
async def list_sessions(
    agent_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> list[SessionRead]:
    # limit 负数是 SQLite 的"不限量"（-5 直接把整库端出去），offset 以前压根没接，
    # 传了也被 FastAPI 静默丢掉 —— 分页看起来能用，其实一直返回第一页。
    stmt = (
        select(ChatSession)
        .order_by(ChatSession.last_active_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if agent_id:
        stmt = stmt.where(ChatSession.agent_id == agent_id)
    if status_filter:
        stmt = stmt.where(ChatSession.status == status_filter)
    rows = list((await session.execute(stmt)).scalars().all())

    names = await _agent_names(session, [r.agent_id for r in rows])

    # worker 会话 → 票（票上记着这件活的标题与任务）
    from agent_studio.models import Ticket

    tmap: dict[str, tuple[str, str, str | None]] = {}
    # 票号短名（tk_ 后 8 位）→ 票：worker 会话标题就是 worker-<短名>
    by_short: dict[str, tuple[str, str]] = {}
    for tk in (await session.execute(select(Ticket))).scalars().all():
        by_short[tk.id[3:11]] = (tk.id, tk.title or "")
        facts = tk.facts or {}
        sid = ((facts.get("assignment") or {}) or {}).get("session_id")
        if sid:
            # thread_id 形如 ses:<派活的那个会话>，侧栏据此把 worker 挂回父会话
            parent = (tk.thread_id or "")[len("ses:") :] if (tk.thread_id or "").startswith("ses:") else None
            tmap[str(sid)] = (tk.id, tk.title or "", parent)

    out: list[SessionRead] = []
    for r in rows:
        turns = (
            await session.execute(
                select(func.count(func.distinct(SessionMessage.turn_index))).where(
                    SessionMessage.session_id == r.id
                )
            )
        ).scalar_one()
        read = _to_read(r, int(turns or 0), names.get(r.agent_id))
        read.kind = _kind_of(r.title or "")
        if read.kind == "worker":
            hit = tmap.get(r.id)
            if not hit:
                # 老票上没记 session_id：worker 会话标题就是 worker-<票号短名>，按短号兜底
                hit0 = by_short.get((r.title or "")[len(WORKER_PREFIX):])
                hit = (hit0[0], hit0[1], None) if hit0 else None
            if hit:
                read.ticket_id, read.ticket_title, read.parent_session_id = hit
        out.append(read)
    return out


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session_detail(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> SessionDetail:
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    rows = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id)
            .order_by(SessionMessage.turn_index, SessionMessage.id)
        )
    ).scalars().all()
    names = await _agent_names(session, [row.agent_id])
    turns = len({r.turn_index for r in rows})
    head = _to_read(row, turns, names.get(row.agent_id))
    if head.kind == "worker":
        # worker-<票号短名> → 票，身份条上要写清"这是哪一件活"
        from agent_studio.models import Ticket

        short = (row.title or "")[len(WORKER_PREFIX):]
        tk = (
            await session.execute(select(Ticket).where(Ticket.id.like(f"tk_{short}%")).limit(1))
        ).scalar_one_or_none()
        if tk is not None:
            head.ticket_id, head.ticket_title = tk.id, tk.title or ""
            th = tk.thread_id or ""
            head.parent_session_id = th[len("ses:") :] if th.startswith("ses:") else None
    # 「引用」标识要能一进来就看见，所以计数在详情里一次算完（一条 SQL），
    # 而不是让前端对每条消息各拉一次来源清单 —— 五十条的会话就是五十个请求。
    counts = await _sources_counts(session, [r.run_id for r in rows if r.run_id])
    return SessionDetail(
        session=head,
        messages=[
            SessionMessageRead(
                id=r.id, turn_index=r.turn_index, role=r.role,
                content=r.content, run_id=r.run_id, ts=r.ts,
                sources_count=counts.get(r.run_id or "", 0),
            )
            for r in rows
        ],
    )


#: 这些目录里的东西不进文件清单（不是产物，是工程残留；列出来只会淹没真产物）
MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 单文件上限

_NOISE_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".next", ".nuxt", ".cache", ".venv", "venv",
}


def _resolve_in_session(root: Path, raw: str) -> tuple[Path, str]:
    """把"相对会话目录"的路径解析成真实文件；不合规矩一律 400。

    会话目录就是权限边界：含 `..`、绝对路径、指向目录外面，全部拒。
    """
    rel = (raw or "").strip().lstrip("/")
    if not rel:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "路径不能为空")
    parts = Path(rel).parts
    if ".." in parts or Path(rel).is_absolute():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "路径不合法")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只能删本会话目录里的文件")
    return target, str(Path(rel))


def _prune_empty(root: Path, parent: Path) -> None:
    """删完顺手收掉变空的子目录（只收到会话根为止，会话根自己留着）。"""
    while parent != root and root in parent.parents:
        try:
            parent.rmdir()  # 非空会抛 OSError，正好停下
        except OSError:
            break
        parent = parent.parent


@router.delete("/{session_id}/files")
async def delete_session_file(
    session_id: str,
    path: str = Query(..., min_length=1, max_length=500),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删掉本会话工作目录里的**一个文件**。

    为什么只能在这个目录里：会话目录就是权限边界（sessions/<会话号>/）。
    路径一律当成"相对会话目录"，含 `..`、绝对路径、想跳到会话外的一律拒 ——
    删文件是不可撤销的操作，边界宁可严一点。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    root = session_work_dir(session_id).resolve()
    target, rel = _resolve_in_session(root, path)
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在（可能已经被删了）")
    if not target.is_file():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只能删文件，不能删目录")
    target.unlink()
    _prune_empty(root, target.parent)
    return {"deleted": rel, "session_id": session_id}


#: 单次批量删除的上限 —— 再多就是"清空目录"，那该走删会话，不该是误点一下
_BATCH_DELETE_MAX = 200


class DeleteFilesIn(BaseModel):
    """批量删：只收相对会话目录的路径，一个都不合规矩就整体拒（不做"删一半"）。"""

    paths: list[str] = []


@router.post("/{session_id}/files/delete")
async def delete_session_files(
    session_id: str,
    payload: DeleteFilesIn,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """一次删多个文件（文件区「管理 → 删除选中」用的）。

    为什么先全部校验再动手：半截失败最讨厌 —— 用户不知道删掉了哪几个。
    所以要么全删成，要么一个不删并说清是哪个路径不合规矩。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    if not payload.paths:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有要删的文件")
    if len(payload.paths) > _BATCH_DELETE_MAX:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"一次最多删 {_BATCH_DELETE_MAX} 个")
    root = session_work_dir(session_id).resolve()

    targets: list[tuple[Path, str]] = []
    for raw in payload.paths:
        try:
            targets.append((*_resolve_in_session(root, raw),))
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else "路径不合法"
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{raw}：{detail}") from None
    for target, rel in targets:
        if not target.is_file():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{rel}：不是文件")

    deleted: list[str] = []
    for target, rel in targets:
        if target.exists():
            target.unlink()
            deleted.append(rel)
    for _, rel in targets:
        _prune_empty(root, (root / rel).parent)
    return {"deleted": deleted, "count": len(deleted), "session_id": session_id}


@router.get("/{session_id}/todos")
async def get_session_todos(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """这个会话的任务清单（助手自己列的，跨轮保留）。

    只回最小结构（id/标题/状态）—— 具体的块依赖、owner 这些是运行时的事，
    界面不该跟着某个框架的数据结构走。
    """
    from .. import todos as todo_store

    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    plan = await todo_store.load(session_id)
    tasks = todo_store.summarise(plan)
    done = sum(1 for t in tasks if t["state"] == "completed")
    return {"tasks": tasks, "total": len(tasks), "done": done}


@router.post("/{session_id}/files")
async def upload_session_files(
    session_id: str,
    files: list[UploadFile] = File(...),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """把用户选的文件放进**这个会话自己的工作目录**。

    为什么不复用 ``/api/uploads``：那个是"发消息时的附件暂存区"，落点在别处，
    传进来的东西不会出现在会话文件清单里 —— 用户在右栏点上传，结果看不见，
    比没有这个按钮更糟。

    安全：只认文件名（丢掉客户端给的任何目录部分），同名不覆盖（加后缀），
    单个 200MB 上限 —— 会话目录是用户可见的东西，不能让它变成任意写入口。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    root = session_work_dir(session_id)
    root.mkdir(parents=True, exist_ok=True)

    saved: list[dict] = []
    for up in files:
        raw = Path(up.filename or "file").name  # 只留文件名，别让 ../ 逃出去
        name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", raw).strip() or "file"
        target = root / name
        stem, suffix = target.stem, target.suffix
        n = 1
        while target.exists():
            target = root / f"{stem}-{n}{suffix}"
            n += 1
        size = 0
        try:
            with target.open("wb") as out:
                while chunk := await up.read(1 << 20):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            f"{name} 太大（上限 {MAX_UPLOAD_BYTES // (1 << 20)}MB）",
                        )
                    out.write(chunk)
        except HTTPException:
            target.unlink(missing_ok=True)
            raise
        saved.append(
            {
                "path": str(target.relative_to(root)),
                "size": size,
                "url": f"/api/work/file/{SESSION_DIR_NAME}/{session_id}/{target.relative_to(root)}",
            }
        )
    return {"session_id": session_id, "saved": saved, "count": len(saved)}


@router.get("/{session_id}/files")
async def list_session_files(
    session_id: str, limit: int = Query(200, ge=1, le=1000), session: AsyncSession = Depends(get_session)
) -> dict:
    """这个会话的工作目录里有什么（**别会话的文件不在这里**）。

    前端「这个会话的文件」用它：会话隔离之后，产物按会话分目录，
    再拿一张全局的清单就等于把隔离又漏回去了。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    root = session_work_dir(session_id)
    # 「本回合 / 全部」要能分组，就得知道每个文件是哪一轮写出来的。
    # 判据不用额外记账：文件的 mtime 落在哪次执行的 [started_at, ended_at] 里，
    # 就是哪一轮；落在窗口外就归给「之前结束的最近那一轮」。
    windows: list[tuple[int, int, str, int | None]] = []
    try:
        rows = (
            await session.execute(
                select(Run.id, Run.started_at, Run.ended_at, Run.turn_index)
                .where(Run.session_id == session_id)
                .order_by(Run.started_at)
            )
        ).all()
        for rid, st, en, ti in rows:
            if st:
                windows.append((int(st), int(en or st), str(rid), ti))
    except Exception:  # noqa: BLE001 —— 分组拿不到就当没有，列表照常返回
        windows = []

    def _turn_of(mtime_s: int) -> tuple[str | None, int | None]:
        """这个文件属于哪一轮 = 开始时间不晚于它的**最近**那一次执行。

        为什么不用「落在窗口内」：产物常常在 run 结束后才被整理/移动一次，
        mtime 会漂到窗口外，那时归给「最近一次已开始的执行」比归给「没有」有用。
        """
        ts = mtime_s * 1000
        for st, _en, rid, ti in reversed(windows):
            if ts >= st:
                return rid, ti
        return (None, None)

    out: list[dict] = []
    if root.is_dir():
        for p in sorted(root.rglob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            # 浏览器过程目录里的 _index.json 是元数据（时间线索引），不是产物
            if p.name == "_index.json":
                continue
            # 细节目录是**真产物**（archify 把架构图放在 .archify/ 下），必须能看能删；
            # 要挡的只是工程噪音（.git / node_modules 这类一进去几百个文件，把清单淹了）。
            if any(part in _NOISE_DIRS for part in rel.parts[:-1]):
                continue
            try:
                stat = p.stat()
            except OSError:
                continue
            run_id, turn_index = _turn_of(int(stat.st_mtime))
            out.append(
                {
                    "path": str(rel),
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                    # 取回走既有的产物端点（它本来就只放行沙箱内的路径）
                    "url": f"/api/work/file/{SESSION_DIR_NAME}/{session_id}/{rel}",
                    # 属于哪一轮（前端按它分「本回合 / 全部」）
                    "run_id": run_id,
                    "turn_index": turn_index,
                }
            )
            if len(out) >= limit:
                break
    return {"session_id": session_id, "work_dir": str(root), "count": len(out), "files": out}


# --------------------------------------------------------------------------- #
# 会话目录（outline）—— 「这个会话里问过什么」
#
# 为什么单独一个轻接口：打开一个几十轮的会话时，前端最想先拿到的是**结构**
# （问过哪些问题、哪些跑完了），而不是几十 KB 的消息正文。目录只带摘要与计数，
# 一个 500 轮的会话压缩后也就十几 KB，所以能做到「打开即可见、点击即达」。
# --------------------------------------------------------------------------- #
_DIGEST_MAX = 40


def _digest_of(text: str) -> str:
    """把一条提问压成一句能被扫到的摘要。规则与服务端自动标题一致：
    取首行、URL 压成域名、折叠空白、截断 40 字。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    first = raw.splitlines()[0].strip()
    # URL → 域名（长链接会把整行吃满，摘要就失去信息量）
    def _short_url(m: Any) -> str:
        u = str(m.group(0))
        try:
            from urllib.parse import urlparse

            host = urlparse(u).netloc or u
            return host[4:] if host.startswith("www.") else host
        except Exception:  # noqa: BLE001
            return u

    first = re.sub(r"https?://\S+", _short_url, first)
    first = re.sub(r"\s+", " ", first).strip()
    return first if len(first) <= _DIGEST_MAX else first[: _DIGEST_MAX - 1] + "…"


@router.get("/{session_id}/outline")
async def session_outline(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """当前会话的问题目录：一轮一条，带摘要 / 状态 / 步数 / 文件数。

    摘要规则与服务端一致（首行 + URL 域名化 + 40 字截断）；这里不调模型 ——
    目录必须毫秒级返回，模型摘要作为增强另行推送。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    msgs = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id, SessionMessage.role == "user")
            .order_by(SessionMessage.turn_index, SessionMessage.id)
        )
    ).scalars().all()

    runs = (
        await session.execute(
            select(Run.id, Run.turn_index, Run.status, Run.started_at, Run.ended_at)
            .where(Run.session_id == session_id)
            .order_by(Run.started_at)
        )
    ).all()
    by_turn: dict[int, tuple[str, str, int, Optional[int]]] = {}
    for rid, ti, st, _sa, _ea in runs:
        if ti is None:
            continue
        by_turn[int(ti)] = (str(rid), str(st), int(_sa or 0), _ea)

    # 步数与文件数：按 run 聚合（两条 group by，别在循环里查库）
    step_counts: dict[str, int] = {}
    if by_turn:
        run_ids = [v[0] for v in by_turn.values()]
        rows = (
            await session.execute(
                select(ToolCall.run_id, func.count()).where(ToolCall.run_id.in_(run_ids)).group_by(ToolCall.run_id)
            )
        ).all()
        step_counts = {str(r[0]): int(r[1]) for r in rows}

    file_counts: dict[str, int] = {}
    try:
        root = session_work_dir(session_id)
        windows = sorted(
            [(int(v[2]), v[0]) for v in by_turn.values() if v[2]], key=lambda x: x[0]
        )
        if root.is_dir() and windows:
            for f in root.rglob("*"):
                if not f.is_file():
                    continue
                ts = int(f.stat().st_mtime) * 1000
                rid = None
                for st, r in windows:
                    if ts >= st:
                        rid = r
                if rid:
                    file_counts[rid] = file_counts.get(rid, 0) + 1
    except Exception:  # noqa: BLE001
        file_counts = {}

    items: list[dict] = []
    for m in msgs:
        ti = int(m.turn_index or 0)
        rid, st, _started, _ended = by_turn.get(ti, ("", "", 0, None))
        status = "done"
        if st in ("running", "pending"):
            status = "running"
        elif st == "waiting_hitl":
            status = "waiting"
        elif st in ("error", "aborted"):
            status = "error"
        items.append(
            {
                "turn_id": f"t{ti}",
                "seq": ti,
                "digest": _digest_of(m.content or ""),
                "status": status,
                "created_at": int(m.ts or 0),
                "step_count": step_counts.get(rid, 0),
                "artifact_count": file_counts.get(rid, 0),
                "run_id": rid or None,
            }
        )
    return {"session_id": session_id, "count": len(items), "items": items}


@router.get("/{session_id}/open")
async def open_session(
    session_id: str,
    turns: int = Query(20, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """首屏聚合：会话元信息 + 目录 + 最近 N 轮的消息，一次往返拿全。

    为什么合一个接口：打开会话是最高频动作，两个往返叠加在弱网下很不划算。
    目录和消息在同一个响应里返回，但前端仍可按字段分批渲染（目录先画）。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    outline = (await session_outline(session_id, session))["items"]
    total_turns = outline[-1]["seq"] if outline else 0
    start_turn = max(1, total_turns - turns + 1) if total_turns else 1

    msgs = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id, SessionMessage.turn_index >= start_turn)
            .order_by(SessionMessage.turn_index, SessionMessage.id)
        )
    ).scalars().all()

    runs = (
        await session.execute(
            select(Run.status).where(Run.session_id == session_id).order_by(Run.started_at.desc()).limit(1)
        )
    ).scalars().all()
    run_state = "running" if runs and runs[0] in ("running", "pending", "waiting_hitl") else "idle"

    return {
        "session": {
            "id": row.id,
            "agent_id": row.agent_id,
            "title": row.title,
            "status": row.status,
            "message_count": row.message_count,
            "last_active_at": row.last_active_at,
        },
        "outline": outline,
        "turns_loaded": turns,
        "before_turn": start_turn - 1,
        "messages": [
            {
                "id": m.id,
                "turn_index": m.turn_index,
                "role": m.role,
                "content": m.content,
                "run_id": m.run_id,
                "created_at": m.ts,
            }
            for m in msgs
        ],
        "run_state": run_state,
    }


@router.get("/{session_id}/browser")
async def list_browser_runs(session_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """这个会话跑过几次浏览器（每次 = 一个 run 的过程目录）。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    from ..browser_trace import list_runs

    root = session_work_dir(session_id)
    return {"session_id": session_id, "runs": list_runs(root)}


@router.get("/{session_id}/browser/{run_id}")
async def browser_steps(session_id: str, run_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """一次浏览器执行的过程：每步的动作 + 那张画面（没存图的步 file 为空）。

    前端用它画时间线：点一步看当时看到的页面 —— 复盘"它在哪一步走错了"靠的就是这个。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    # run 号是单段目录名 —— 不允许分隔符/上跳，别让路径从这里逃出会话目录
    if not re.fullmatch(r"[\w.\-]+", run_id or "") or ".." in run_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "run 号不合法")
    from ..browser_trace import read_index

    root = session_work_dir(session_id)
    steps = read_index(root, run_id)
    for it in steps:
        it["url_file"] = (
            f"/api/work/file/sessions/{session_id}/browser/{run_id}/{it['file']}" if it.get("file") else ""
        )
    return {"session_id": session_id, "run_id": run_id, "steps": steps, "count": len(steps)}


@router.patch("/{session_id}", response_model=SessionRead)
async def update_session(
    session_id: str, payload: SessionUpdate, session: AsyncSession = Depends(get_session)
) -> SessionRead:
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    if payload.title is not None:
        row.title = payload.title.strip()[:200]
    if payload.status is not None:
        row.status = payload.status
    row.last_active_at = now_ms()
    await session.commit()
    await session.refresh(row)
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, 0, names.get(row.agent_id))


@router.delete("/{session_id}")
async def delete_session(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """删除会话（消息级联清理；Run 记录保留）。

    Run 的会话归属**不清空**：以前这里是 ``run.session_id = None``，后果是删完会话
    那几轮记录掉进"无会话"，类型从对话降级成"助手试跑"，列表里一场对话散成好几行
    （每行顶着一个助手名）。记录页要的是"一次会话一项"，所以归属留着，会话行没了
    就在前端标「会话已删除」。
    """
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    await session.delete(row)
    await session.commit()
    removed = _remove_session_dir(session_id)
    # 发布出去的产物也要收走：会话没了、链接还活着，等于留了一份没人认领的公开副本
    published = _remove_published(session_id)
    return {
        "deleted": 1,
        "unbound_runs": 0,
        "removed_dir": removed,
        "removed_published": published,
    }


@router.patch("/{session_id}/messages/{message_id}", response_model=SessionMessageRead)
async def update_message(
    session_id: str, message_id: int, payload: dict, session: AsyncSession = Depends(get_session)
) -> SessionMessageRead:
    """编辑一条消息的正文。

    只改**平台侧历史**（下一轮注入模型的上下文用它）——已有 Run 的记录不动
    （那是观测资产，历史的回答改了会与当时的执行过程对不上）。
    常见场景：用户消息里打错了字/敏感信息，改完不用开新会话。
    """
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "消息内容不能为空")
    row = await session.get(SessionMessage, message_id)
    if row is None or row.session_id != session_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"消息不存在: {message_id}")
    row.content = content
    await session.commit()
    return SessionMessageRead(
        id=row.id, turn_index=row.turn_index, role=row.role,
        content=row.content, run_id=row.run_id, ts=row.ts,
    )


class RewindIn(BaseModel):
    """从这里重来：``turn_index`` 是那轮用户消息的轮次号。"""

    turn_index: int = Field(..., ge=1)


@router.post("/{session_id}/rewind")
async def rewind_session(
    session_id: str, body: RewindIn, session: AsyncSession = Depends(get_session)
) -> dict:
    """回到某一轮之前：**删掉**这一轮及之后的所有消息。

    为什么是删而不是标记作废：会话历史会原样喂给模型，留着"废弃轮次"它照样看得见，
    等于没回滚（还会被当成已经发生的事实去引用）。
    Run 记录不删 —— 那是观测资产，「执行」页照样能翻到当时发生了什么。
    """
    chat = await session.get(ChatSession, session_id)
    if chat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    doomed = list(
        (
            await session.execute(
                select(SessionMessage)
                .where(
                    SessionMessage.session_id == session_id,
                    SessionMessage.turn_index >= body.turn_index,
                )
                .order_by(SessionMessage.turn_index)
            )
        ).scalars()
    )
    if not doomed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有第 {body.turn_index} 轮")
    # 被点名的这一轮必须是从用户开始的（防止把半轮删成"助手自说自话"）
    if not any(m.role == "user" and m.turn_index == body.turn_index for m in doomed):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "只能从「用户消息」那一轮回滚，别指向助手的回复",
        )

    for m in doomed:
        await session.delete(m)
    left = int(
        (
            await session.execute(
                select(func.count())
                .select_from(SessionMessage)
                .where(SessionMessage.session_id == session_id)
            )
        ).scalar_one()
        or 0
    )
    # delete 还没 flush，先 flush 再数
    await session.flush()
    left = int(
        (
            await session.execute(
                select(func.count())
                .select_from(SessionMessage)
                .where(SessionMessage.session_id == session_id)
            )
        ).scalar_one()
        or 0
    )
    chat.message_count = left
    # 摘要覆盖范围跟着退：摘要里若还写着"被删掉的轮次"，下一轮就会带着幽灵上下文
    chat.summarized_upto = min(int(chat.summarized_upto or 0), max(0, body.turn_index - 1))
    if chat.summarized_upto == 0:
        chat.summary = None
    await session.commit()
    return {"deleted": len(doomed), "remaining": left, "turn_index": body.turn_index}


@router.post("/{session_id}/branch", response_model=SessionRead, status_code=status.HTTP_201_CREATED)
async def branch_session(
    session_id: str, body: RewindIn, session: AsyncSession = Depends(get_session)
) -> SessionRead:
    """从某一轮之前**另起一个会话**（原会话一个字都不动）。

    和回滚的分工：回滚 = 我错了，擦掉重写；分支 = 想试试另一条路，但原来的答案还要留着。
    """
    chat = await session.get(ChatSession, session_id)
    if chat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    new = ChatSession(
        id=new_id("ses_"),
        workspace_id=chat.workspace_id,
        agent_id=chat.agent_id,
        title=(chat.title or "新对话") + " · 分支",
        status="active",
        summary=None,
        summarized_upto=0,
        message_count=0,
        usage={},
        created_at=now_ms(),
    )
    session.add(new)
    copied = list(
        (
            await session.execute(
                select(SessionMessage)
                .where(
                    SessionMessage.session_id == session_id,
                    SessionMessage.turn_index < body.turn_index,
                )
                .order_by(SessionMessage.turn_index, SessionMessage.id)
            )
        ).scalars()
    )
    for m in copied:
        session.add(
            SessionMessage(
                session_id=new.id,
                turn_index=m.turn_index,
                role=m.role,
                content=m.content,
                run_id=None,  # 副本不指向别人的 run（点进"执行过程"会看到另一条对话的现场）
                ts=m.ts,
            )
        )
    new.message_count = len(copied)
    await session.commit()
    await session.refresh(new)
    return SessionRead.model_validate(new, from_attributes=True)


@router.post("/{session_id}/clear-context")
async def clear_session_context(
    session_id: str,
    payload: SessionClearContextRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """清空上下文（保留会话）—— "重新开始聊，但别新建会话"。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    removed = await clear_context(
        session, session_id, keep_summary=bool(payload and payload.keep_summary)
    )
    return {"removed_messages": removed}


# --------------------------------------------------------------------------- #
# 产物（deliverable）
#
# 会话的「交付物」= 工作目录下的 ``product/``。它和上面「会话文件」不是一回事：
# 文件是过程（脚本、日志、中间结果），产物是**这一轮要给人的东西**。
# 分开的理由是可操作：产物能预览、能打包、能发布成链接；过程文件不能。
# --------------------------------------------------------------------------- #
@router.get("/{session_id}/deliverable")
async def get_session_deliverable(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """这个会话交付了什么（没有就是 exists=false，不报错）。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    data = dlv.scan(session_work_dir(session_id)).to_dict()
    data["session_id"] = session_id
    if data.get("entry"):
        rel = f"{dlv.PRODUCT_DIR}/{data['entry']}"
        # 取文件走既有产物端点（它自带白名单/越界防护/HEAD）
        data["entry_url"] = f"/api/work/file/{SESSION_DIR_NAME}/{session_id}/{rel}"
    return data


@router.post("/{session_id}/files/zip")
async def zip_selected_files(
    session_id: str, payload: dict, session: AsyncSession = Depends(get_session)
):
    """把用户勾选的文件打成一个 zip（多选批量下载）。

    路径一律按「会话工作目录内的相对路径」处理并逐条校验：任何一条越界就整包拒绝 ——
    宁可让用户重选，也不要把会话目录外的东西打进包里。
    """
    import io
    import zipfile

    from fastapi.responses import StreamingResponse

    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    paths = [str(x) for x in (payload.get("paths") or []) if str(x).strip()]
    if not paths:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选择文件")
    if len(paths) > 300:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "一次最多打包 300 个文件")

    root = session_work_dir(session_id).resolve()
    picked: list[tuple[Path, str]] = []
    for rel in paths:
        target = (root / rel).resolve()
        if not str(target).startswith(str(root)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"路径越界: {rel}")
        if not target.is_file():
            continue
        picked.append((target, rel))
    if not picked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "选中的文件都不在了")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for target, rel in picked:
            try:
                zf.write(target, arcname=rel)
            except OSError:
                continue
    buf.seek(0)
    name = f"{session_id}-files.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/{session_id}/deliverable/zip")
async def download_session_deliverable(
    session_id: str, session: AsyncSession = Depends(get_session)
):
    """把产物打成 zip 下载（过程文件不进包）。"""
    import io
    import zipfile

    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    root = dlv.product_path(session_work_dir(session_id))
    info = dlv.scan(session_work_dir(session_id))
    if not info.exists:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这个会话还没有产物")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in info.files:
            p = root / f["path"]
            try:
                zf.write(p, f["path"])
            except OSError:
                continue
    buf.seek(0)
    name = f"{dlv.slug_for(session_id)}.zip"
    from fastapi.responses import Response

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


class PublishIn(BaseModel):
    """留空就用默认发布位置（本机 /srv/www，其它机器落到工作目录下）。"""

    dir: str = ""


@router.post("/{session_id}/deliverable/publish")
async def publish_session_deliverable(
    session_id: str,
    payload: PublishIn | None = None,
    request: Request = None,  # type: ignore[assignment]
    session: AsyncSession = Depends(get_session),
) -> dict:
    """把产物发到一个能直接打开/分享的地址。

    发布位置按顺序取：请求里的 ``dir`` > ``STUDIO_PUBLISH_DIR`` > 本机 ``/srv/www``
    （用户的静态站点根，:8081 直接对外）> 工作目录下的 ``published/``。
    同一个会话反复发布 = 覆盖同一个 slug，链接不会遍地都是。
    """
    import os

    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    want = (payload.dir if payload else "").strip()
    if want:
        root = Path(want).expanduser()
    elif settings.publish_dir:
        root = Path(settings.publish_dir).expanduser()
    elif Path("/srv/www").is_dir() and os.access("/srv/www", os.W_OK):
        root = Path("/srv/www")
    else:
        root = Path(settings.work_dir) / "published"

    try:
        # 发布是纯 IO（拷贝几十个文件），别占事件循环
        info = await asyncio.to_thread(dlv.publish, session_work_dir(session_id), root, session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"发布失败：{exc}（目录可能没有写权限）"
        ) from exc

    slug, entry = info["slug"], info.get("entry") or ""
    # 链接怎么拼：优先显式配置的对外基址；否则看发布目录是不是静态站根
    base = (settings.public_base or "").strip().rstrip("/")
    if base:
        url = f"{base}/{slug}/{entry}" if entry else f"{base}/{slug}/"
    elif root == Path("/srv/www"):
        host = (request.url.hostname if request else "") or "127.0.0.1"
        url = f"http://{host}:8081/{slug}/{entry}" if entry else f"http://{host}:8081/{slug}/"
    else:
        # 没有静态站托管，就走平台自己的文件端点（同源、免登录）
        rel = f"{root.name}/{slug}/{entry}" if root.name == "published" else f"{slug}/{entry}"
        url = f"/api/work/file/{rel}" if entry else ""
    return {
        "slug": slug,
        "dir": str(root),
        "entry": entry,
        "file_count": info["file_count"],
        "size": info["size"],
        "published_at": info["published_at"],
        "url": url,
    }
