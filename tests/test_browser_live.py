"""浏览器直播的两个"只有真跑才暴露"的坑。

① 帧事件不落库（seq<0）—— 流端点如果按 seq 去重，会把 browser_frame /
   browser_action 全丢掉（表现：画面永远不出现，但助手明明在操作浏览器）。
   这里不跑真 Chromium，直接验证流端点的判定：负 seq 的直播事件必须放行。

② 最后一帧存哪、什么时候存 —— 存成会话文件，用户刷新后还能看见"它停在哪"。
   存成 about:blank 的白屏帧等于没存，所以只有 http(s) 页面的帧才算数。
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path

import pytest

from agent_studio.runner.service import _last_frame_path


def test_last_frame_path_only_with_session():
    from agent_studio.runner.service import session_work_dir

    p = _last_frame_path("ses_x", "run_y")
    assert p == session_work_dir("ses_x") / "browser" / "run_y.jpg"
    # 单轮执行（没有会话）就没有地方放这张图 —— 返回 None，别往仓库根目录乱写
    assert _last_frame_path(None, "run_y") is None


async def test_close_all_saves_last_frame(tmp_path):
    from agent_studio import browser_session as bs

    class Fake:
        run_id = "run_t"
        _last_frame = base64.b64encode(b"\xff\xd8fakejpeg").decode()

        async def close(self):
            return None

    bs._SESSIONS["run_t"] = Fake()
    dest = tmp_path / "browser" / "run_t.jpg"
    await bs.close_all("run_t", dest)
    assert dest.exists() and dest.read_bytes() == b"\xff\xd8fakejpeg"


async def test_close_all_without_frame_writes_nothing(tmp_path):
    from agent_studio import browser_session as bs

    class Fake:
        run_id = "run_n"
        _last_frame = ""

        async def close(self):
            return None

    bs._SESSIONS["run_n"] = Fake()
    dest = tmp_path / "browser" / "run_n.jpg"
    await bs.close_all("run_n", dest)
    assert not dest.exists(), "没画面就别造空文件"


def test_live_events_bypass_seq_dedup():
    """流端点源码里对直播事件的放行条件 —— 改了就会被 seq 去重吃掉。"""
    import inspect

    from agent_studio.api import runs as runs_api

    src = inspect.getsource(runs_api.stream_run)
    assert "browser_frame" in src and "browser_action" in src, "直播事件必须放行（不落库、seq<0）"
