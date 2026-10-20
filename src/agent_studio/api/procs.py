"""后台进程的 HTTP 接口 —— 给界面看"谁在跑、跑完了没、输出是什么"。

和工具层（proc_*）共用同一份实现（``agent_studio.procs``），所以界面上看到的
和助手自己看到的**永远一致**：不会出现"界面说在跑、工具说没有"。

安全口径
--------
* 列表/日志/停止都按 ``session_id`` 过滤 —— 会话之间不互看（与文件隔离一致）。
* **不提供**"通过接口起任意进程"的入口：起进程只能由助手在会话里做。
  平台自己的公网入口已经要 token，但多一条任意命令的 API 就是多一个洞。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import procs

router = APIRouter(prefix="/api/procs", tags=["procs"])


@router.get("")
async def list_procs(session_id: str = Query(..., description="会话 id")) -> dict:
    items = await procs.list_for_session(session_id)
    return {"items": items, "running": sum(1 for i in items if i["status"] == "running")}


@router.get("/{proc_id}")
async def get_proc(proc_id: str, session_id: str = Query(...)) -> dict:
    row = await procs.poll(proc_id, session_id=session_id)
    if row is None:
        raise HTTPException(404, "没有这个后台进程")
    return row


@router.get("/{proc_id}/log")
async def get_log(
    proc_id: str,
    session_id: str = Query(...),
    lines: int = Query(200, ge=1, le=2000),
) -> dict:
    text = await procs.log_text(proc_id, session_id=session_id, lines=lines)
    return {"id": proc_id, "text": text}


@router.post("/{proc_id}/kill")
async def kill_proc(proc_id: str, session_id: str = Query(...)) -> dict:
    res = await procs.kill(proc_id, session_id=session_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "停止失败")
    return res
