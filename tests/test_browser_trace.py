"""浏览器执行过程留档：每步一张图 + 一份索引。

为什么值得单独测：这套东西**只在真跑浏览器时才写**，平时跑单元测试永远覆盖不到，
一旦写坏（路径拼错、截图空、索引写坏）只有用户回看时才会发现"过程是空的"。

三条不变量：
① 存进**会话目录**（删会话一起清，不留孤儿）；
② 只写前 40 步的图，索引本身不封顶（时间线要完整）；
③ 记录失败绝不能影响浏览器动作本身（留档是锦上添花）。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from agent_studio import browser_trace
from agent_studio.browser_trace import MAX_STEPS, list_runs, read_index, record_step


def _jpeg(tag: str = "fake") -> str:
    return base64.b64encode(f"\xff\xd8{tag}".encode()).decode()


def test_record_step_writes_image_and_index(tmp_path):
    item = record_step(
        Path(tmp_path),
        "run_a",
        1,
        "navigate",
        "打开 example.com",
        url="https://example.com/",
        title="Example Domain",
        frame_b64=_jpeg(),
    )
    assert item and item["file"].endswith(".jpg")
    d = Path(tmp_path) / "browser" / "run_a"
    assert (d / item["file"]).exists()
    # 文件名带人话摘要：用户在文件清单里认得出这是哪一步
    assert "打开-example.com" in item["file"]

    record_step(Path(tmp_path), "run_a", 2, "click", "点击 a", url="https://example.com/a", frame_b64=_jpeg())
    steps = read_index(Path(tmp_path), "run_a")
    assert [s["n"] for s in steps] == [1, 2]
    assert steps[1]["summary"] == "点击 a"


def test_index_stays_complete_but_images_capped(tmp_path):
    for n in range(1, MAX_STEPS + 3):
        record_step(Path(tmp_path), "run_b", n, "click", f"点击 {n}", frame_b64=_jpeg())
    steps = read_index(Path(tmp_path), "run_b")
    assert len(steps) == MAX_STEPS + 2, "索引不封顶（时间线要完整）"
    assert sum(1 for s in steps if s["file"]) == MAX_STEPS, "图只留前 40 步"
    assert steps[-1]["file"] == "", "超出的步只记索引"


def test_no_frame_still_records_step(tmp_path):
    """截图失败（页面在跳转/崩溃）时不能丢步骤 —— 时间线还是要完整。"""
    item = record_step(Path(tmp_path), "run_c", 1, "read", "读页面内容", frame_b64=None)
    assert item and item["file"] == ""
    assert read_index(Path(tmp_path), "run_c")[0]["summary"] == "读页面内容"


def test_bad_base64_does_not_raise(tmp_path):
    item = record_step(Path(tmp_path), "run_d", 1, "navigate", "打开 x", frame_b64="!!!notbase64")
    assert item is not None and item["file"] == ""


def test_list_runs_recent_first(tmp_path):
    record_step(Path(tmp_path), "run_old", 1, "navigate", "打开 a", frame_b64=_jpeg())
    steps = read_index(Path(tmp_path), "run_old")
    # 手动把时间调旧
    steps[0]["ts"] = 1
    (Path(tmp_path) / "browser" / "run_old" / "_index.json").write_text(json.dumps(steps), encoding="utf-8")
    record_step(Path(tmp_path), "run_new", 1, "navigate", "打开 b", frame_b64=_jpeg())

    runs = list_runs(Path(tmp_path))
    assert [r["run_id"] for r in runs] == ["run_new", "run_old"]
    assert runs[0]["steps"] == 1


def test_slug_kills_path_chars():
    s = browser_trace._slug('打开 ../../etc/passwd')
    assert "/" not in s and ".." not in s and " " not in s
