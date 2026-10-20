"""后台进程（proc_* / /api/procs）的护栏。

口径（用户 2026-10：平台要能"跑得住比一轮对话更久的活"）：
  1. 起进程**立刻返回**，不等它跑完（这是"后台"的定义）
  2. 跑完了状态要自己落库（exited/failed + 退出码），不靠人轮询触发
  3. 归属是**会话**：A 会话看不到 B 会话的进程（与文件隔离同一个边界）
  4. 能停，且停整棵进程树（bash -c "a | b" 不能只杀 shell）
  5. 服务重启后不许留"正在运行"的幽灵（reconcile → unknown）
"""

from __future__ import annotations

import asyncio
import sys
import time

import pytest

from agent_studio import procs
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import BgProc


async def _wait_done(proc_id: str, session_id: str, timeout: float = 15.0) -> dict:
    """等它真的结束（结束是由 watcher 协程写库的，需要等一拍）。"""
    end = time.time() + timeout
    while time.time() < end:
        row = await procs.poll(proc_id, session_id=session_id)
        if row and row["status"] != "running":
            return row
        await asyncio.sleep(0.2)
    raise AssertionError(f"{proc_id} 在 {timeout}s 内没有结束")


async def test_起进程立刻返回_跑完自己落状态(tmp_path):
    await init_db()
    sid = "ses_proc_a"
    t0 = time.time()
    info = await procs.start(
        session_id=sid,
        command=f"{sys.executable} -c \"import time; print('hello'); time.sleep(0.3)\"",
        cwd=tmp_path,
        label="打个招呼",
    )
    # 立刻返回：起进程本身不许等它跑完
    assert time.time() - t0 < 5
    assert info["status"] == "running"

    row = await _wait_done(info["id"], sid)
    assert row["status"] == "exited", row
    assert row["exit_code"] == 0
    assert "hello" in row["tail"]
    assert row["label"] == "打个招呼"


async def test_失败退出码要记下来(tmp_path):
    await init_db()
    sid = "ses_proc_fail"
    info = await procs.start(
        session_id=sid,
        command=f"{sys.executable} -c \"import sys; print('boom'); sys.exit(3)\"",
        cwd=tmp_path,
    )
    row = await _wait_done(info["id"], sid)
    assert row["status"] == "failed"
    assert row["exit_code"] == 3
    assert "boom" in row["tail"]


async def test_会话之间看不到彼此的进程(tmp_path):
    await init_db()
    info = await procs.start(session_id="ses_owner", command="sleep 30", cwd=tmp_path)
    try:
        assert await procs.poll(info["id"], session_id="ses_other") is None
        assert await procs.list_for_session("ses_other") == []
        mine = await procs.list_for_session("ses_owner")
        assert any(r["id"] == info["id"] for r in mine)
        # 停也停不到别人的
        res = await procs.kill(info["id"], session_id="ses_other")
        assert not res.get("ok")
    finally:
        await procs.kill(info["id"], session_id="ses_owner")


async def test_能停_且整棵进程树一起停(tmp_path):
    await init_db()
    sid = "ses_proc_kill"
    info = await procs.start(
        session_id=sid,
        command="bash -c 'sleep 60 | cat'",
        cwd=tmp_path,
    )
    await asyncio.sleep(0.6)  # 让 shell 真的把子进程拉起来
    res = await procs.kill(info["id"], session_id=sid)
    assert res.get("ok"), res
    row = await procs.poll(info["id"], session_id=sid)
    assert row["status"] in ("killed", "exited", "failed")


async def test_重启后对账_不留幽灵运行中():
    await init_db()
    async with SessionLocal() as s:
        s.add(
            BgProc(
                id="bg_ghost_pid_1",
                session_id="ses_ghost",
                command="sleep 999",
                pid=999_999,  # 不可能存在的 pid
                status="running",
                started_at=int(time.time() * 1000),
            )
        )
        await s.commit()
    fixed = await procs.reconcile()
    assert fixed >= 1
    row = await procs.poll("bg_ghost_pid_1", session_id="ses_ghost")
    assert row["status"] == "unknown"


async def test_日志行数受限_但能读到尾部(tmp_path):
    await init_db()
    sid = "ses_proc_log"
    info = await procs.start(
        session_id=sid,
        command=f"{sys.executable} -c \"print('line-A'); print('line-B'); print('line-C')\"",
        cwd=tmp_path,
    )
    await _wait_done(info["id"], sid)
    text = await procs.log_text(info["id"], session_id=sid, lines=50)
    assert "line-A" in text and "line-C" in text
