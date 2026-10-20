"""浏览器执行过程留档 —— 每一步一张图 + 一份索引。

为什么需要：直播帧不落库（seq<0），刷新即失；用户要复盘"它当时看到了什么、
在哪一步走错了"，只有最后一帧不够。

存法（全部在会话目录里，删会话一起清）：

    sessions/<会话号>/browser/<run>/01-打开-example.com.jpg
    sessions/<会话号>/browser/<run>/02-点击-a.jpg
    sessions/<会话号>/browser/<run>/_index.json     ← 动作/网址/时间，前端据此做时间线

取舍：
* 只留前 MAX_STEPS 步的图（再多就是几百 MB，而复盘前 40 步足够看出问题）；
  超出的步只写索引、不存图（时间线仍然完整）。
* 文件名带人话摘要，用户在会话文件清单里也能认出哪张是哪步。
* 记录失败一律吞掉 —— 留档是锦上添花，绝不能因为它让浏览器动作失败。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

#: 最多存多少张图（索引本身不设上限，只是超过这个数就不再截图）
MAX_STEPS = 40


def _slug(text: str, limit: int = 28) -> str:
    """文件名里那截人话：去路径符号、留中文，太长截断。"""
    s = re.sub(r"[\\/:*?\"<>|\s]+", "-", (text or "").strip())
    s = re.sub(r"-{2,}", "-", s)
    # 连续点收敛掉：文件名里的 ".." 是路径符号，留着只会让以后的人提心吊胆
    s = re.sub(r"\.{2,}", ".", s).strip("-.")
    return (s[:limit] or "step")


def run_dir(session_work_dir: Path, run_id: str) -> Path:
    return Path(session_work_dir) / "browser" / run_id


def record_step(
    work_dir: Path,
    run_id: str,
    n: int,
    action: str,
    summary: str,
    url: str = "",
    title: str = "",
    frame_b64: str | None = None,
) -> dict | None:
    """记一步：能截图就存图，索引一定写。返回这一步的索引项。"""
    try:
        d = run_dir(work_dir, run_id)
        d.mkdir(parents=True, exist_ok=True)
        item = {
            "n": n,
            "action": action,
            "summary": summary,
            "url": url,
            "title": title,
            "ts": int(time.time()),
            "file": "",
        }
        if frame_b64 and n <= MAX_STEPS:
            name = f"{n:02d}-{_slug(summary)}.jpg"
            try:
                (d / name).write_bytes(base64.b64decode(frame_b64))
                item["file"] = name
            except Exception:  # pragma: no cover
                logger.debug("写步骤截图失败", exc_info=True)
        idx = d / "_index.json"
        steps: list[dict] = []
        if idx.exists():
            try:
                steps = json.loads(idx.read_text(encoding="utf-8"))
            except Exception:
                steps = []
        steps.append(item)
        idx.write_text(json.dumps(steps, ensure_ascii=False, indent=1), encoding="utf-8")
        return item
    except Exception:  # pragma: no cover
        logger.debug("记录浏览器步骤失败", exc_info=True)
        return None


def read_index(work_dir: Path, run_id: str) -> list[dict]:
    idx = run_dir(work_dir, run_id) / "_index.json"
    if not idx.exists():
        return []
    try:
        data = json.loads(idx.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def list_runs(work_dir: Path) -> list[dict]:
    """这个会话里跑过几次浏览器（最近在前）—— 面板上"历史回看"用。"""
    base = Path(work_dir) / "browser"
    if not base.is_dir():
        return []
    out: list[dict] = []
    for d in base.iterdir():
        if not d.is_dir():
            continue
        idx = read_index(work_dir, d.name)
        if not idx:
            continue
        out.append(
            {
                "run_id": d.name,
                "steps": len(idx),
                "first_url": idx[0].get("url", ""),
                "last_url": idx[-1].get("url", ""),
                "started_at": idx[0].get("ts", 0),
            }
        )
    return sorted(out, key=lambda x: x["started_at"], reverse=True)
