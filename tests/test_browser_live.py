"""浏览器直播的两个"只有真跑才暴露"的坑。

① 帧事件不落库（seq<0）—— 流端点如果按 seq 去重，会把 browser_frame /
   browser_action 全丢掉（表现：画面永远不出现，但助手明明在操作浏览器）。
② 截图的返回形状：CDP 的 Page.captureScreenshot 把 base64 放在 result.data 里，
   读错层级就永远是空图（过程留档会全变成"没图"）。
"""

from __future__ import annotations

import inspect

from agent_studio.browser_session import BrowserSession


def test_live_events_bypass_seq_dedup():
    """流端点源码里对直播事件的放行条件 —— 改了就会被 seq 去重吃掉。"""
    from agent_studio.api import runs as runs_api

    src = inspect.getsource(runs_api.stream_run)
    assert "browser_frame" in src and "browser_action" in src, "直播事件必须放行（不落库、seq<0）"


def test_snapshot_reads_cdp_result_data():
    src = inspect.getsource(BrowserSession.snapshot)
    assert "Page.captureScreenshot" in src
    assert "result" in src and "data" in src, "CDP 的图在 result.data 里，读错层级永远是空"
    assert "jpeg" in src, "要 JPEG（PNG 太大，40 步就上百 MB）"
