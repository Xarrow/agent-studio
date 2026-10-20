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

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..context import clear_context
from ..db import get_session
from ..models import Agent, Run, Session as ChatSession, SessionMessage, new_id, now_ms
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


async def _agent_names(session: AsyncSession, agent_ids: list[str]) -> dict[str, str]:
    if not agent_ids:
        return {}
    rows = (
        await session.execute(select(Agent.id, Agent.name).where(Agent.id.in_(set(agent_ids))))
    ).all()
    return {r[0]: r[1] for r in rows}


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
    limit: int = Query(default=50, le=200),
    session: AsyncSession = Depends(get_session),
) -> list[SessionRead]:
    stmt = select(ChatSession).order_by(ChatSession.last_active_at.desc()).limit(limit)
    if agent_id:
        stmt = stmt.where(ChatSession.agent_id == agent_id)
    if status_filter:
        stmt = stmt.where(ChatSession.status == status_filter)
    rows = list((await session.execute(stmt)).scalars().all())

    names = await _agent_names(session, [r.agent_id for r in rows])
    out: list[SessionRead] = []
    for r in rows:
        turns = (
            await session.execute(
                select(func.count(func.distinct(SessionMessage.turn_index))).where(
                    SessionMessage.session_id == r.id
                )
            )
        ).scalar_one()
        out.append(_to_read(r, int(turns or 0), names.get(r.agent_id)))
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
    return SessionDetail(
        session=_to_read(row, turns, names.get(row.agent_id)),
        messages=[
            SessionMessageRead(
                id=r.id, turn_index=r.turn_index, role=r.role,
                content=r.content, run_id=r.run_id, ts=r.ts,
            )
            for r in rows
        ],
    )


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
    rel = path.strip().lstrip("/")
    if not rel:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "路径不能为空")
    parts = Path(rel).parts
    if ".." in parts or Path(rel).is_absolute():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "路径不合法")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只能删本会话目录里的文件")
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在（可能已经被删了）")
    if not target.is_file():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只能删文件，不能删目录")
    target.unlink()
    # 顺手清掉因此变空的子目录（只清到会话根为止，会话根自己留着）
    parent = target.parent
    while parent != root and root in parent.parents:
        try:
            parent.rmdir()  # 非空会抛 OSError，正好停下
        except OSError:
            break
        parent = parent.parent
    return {"deleted": str(Path(rel)), "session_id": session_id}


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
    out: list[dict] = []
    if root.is_dir():
        for p in sorted(root.rglob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            if any(part.startswith(".") for part in rel.parts):
                continue
            try:
                stat = p.stat()
            except OSError:
                continue
            out.append(
                {
                    "path": str(rel),
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                    # 取回走既有的产物端点（它本来就只放行沙箱内的路径）
                    "url": f"/api/work/file/{SESSION_DIR_NAME}/{session_id}/{rel}",
                }
            )
            if len(out) >= limit:
                break
    return {"session_id": session_id, "work_dir": str(root), "count": len(out), "files": out}


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
    """删除会话（消息级联清理；**不影响** Run 记录）。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    # 解绑 Run 的会话归属，避免留下悬空引用（Run 本身保留）
    runs = (
        await session.execute(select(Run).where(Run.session_id == session_id))
    ).scalars().all()
    for run in runs:
        run.session_id = None
    await session.delete(row)
    await session.commit()
    removed = _remove_session_dir(session_id)
    return {"deleted": 1, "unbound_runs": len(runs), "removed_dir": removed}


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
