"""会话文件的查询与删除。

两条都是"用户会真的按下去"的操作，所以边界要守住：

* 查询：只列 / 只过滤**本会话目录**里的文件，别的会话的文件看不见。
* 删除：会话目录就是权限边界。`..`、绝对路径、指向目录外——一律 400；
  一次删多个时**先全部校验再动手**（半截失败最讨厌：用户不知道删掉了哪几个）。

这两条也各自有一个容易被"优化"掉的细节：搜索是在前端过滤（文件数不大，不必多一次往返），
批量删除的条数上限（200）挡住"手滑清空整个会话"。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_studio.config import settings


def _run(coro):
    return asyncio.run(coro)


def _session_files_dir(session_id: str) -> Path:
    from agent_studio.runner.service import session_work_dir

    return Path(session_work_dir(session_id))


async def _make_session(client, title: str = "文件测试") -> str:
    """临时库是空的 —— 自己种一个 Agent 再开会话（跟 test_session_rewind 一个套路）。"""
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import Agent, now_ms

    await init_db()
    async with SessionLocal() as db:
        if await db.get(Agent, "ag_files") is None:
            db.add(
                Agent(
                    id="ag_files",
                    slug="files-test",
                    name="文件测试助手",
                    runtime="agentscope",
                    version=1,
                    definition={},
                    created_at=now_ms(),
                    updated_at=now_ms(),
                )
            )
            await db.commit()

    r = await client.post("/api/sessions", json={"agent_id": "ag_files", "title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_list_only_this_session(client):
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "a.md").write_text("a", encoding="utf-8")
    (d / "sub").mkdir(exist_ok=True)
    (d / "sub" / "b.csv").write_text("x,y\n1,2\n", encoding="utf-8")

    got = (await client.get(f"/api/sessions/{sid}/files")).json()
    names = sorted(f["path"] for f in got["files"])
    assert names == ["a.md", "sub/b.csv"]
    assert got["count"] == 2


async def test_batch_delete_removes_only_listed(client):
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    for n in ("a.md", "b.csv", "keep.txt"):
        (d / n).write_text("x", encoding="utf-8")

    r = await client.post(f"/api/sessions/{sid}/files/delete", json={"paths": ["a.md", "b.csv"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(body["deleted"]) == ["a.md", "b.csv"] and body["count"] == 2
    assert (d / "keep.txt").exists() and not (d / "a.md").exists()


async def test_batch_delete_is_all_or_nothing(client):
    """一个路径越界 → 整个请求 400，并且**一个都不删**（不做删一半）。"""
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "ok.txt").write_text("x", encoding="utf-8")

    r = await client.post(f"/api/sessions/{sid}/files/delete", json={"paths": ["ok.txt", "../escape.txt"]})
    assert r.status_code == 400
    assert (d / "ok.txt").exists(), "校验失败时不许先删掉合规的那个"


async def test_batch_delete_rejects_empty_and_huge(client):
    sid = await _make_session(client)
    assert (await client.post(f"/api/sessions/{sid}/files/delete", json={"paths": []})).status_code == 400
    too_many = [f"f{i}.txt" for i in range(201)]
    assert (await client.post(f"/api/sessions/{sid}/files/delete", json={"paths": too_many})).status_code == 400


async def test_batch_delete_prunes_empty_subdirs(client):
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    (d / "deep" / "er").mkdir(parents=True, exist_ok=True)
    (d / "deep" / "er" / "x.txt").write_text("x", encoding="utf-8")

    r = await client.post(f"/api/sessions/{sid}/files/delete", json={"paths": ["deep/er/x.txt"]})
    assert r.status_code == 200
    assert not (d / "deep").exists(), "删完变空的子目录要收掉"
    assert d.exists(), "会话目录本身要留着"


async def test_single_delete_still_works(client):
    """单删是弹层里那个按钮的老路径，不能被批量改动带坏。"""
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "solo.txt").write_text("x", encoding="utf-8")

    r = await client.delete(f"/api/sessions/{sid}/files", params={"path": "solo.txt"})
    assert r.status_code == 200 and r.json()["deleted"] == "solo.txt"
    assert not (d / "solo.txt").exists()
    # 删不存在的是 404，不是 500
    assert (await client.delete(f"/api/sessions/{sid}/files", params={"path": "solo.txt"})).status_code == 404
    # 删目录不许
    (d / "adir").mkdir(exist_ok=True)
    assert (await client.delete(f"/api/sessions/{sid}/files", params={"path": "adir"})).status_code == 400


async def test_hidden_product_dirs_are_listed(client):
    """助手把产物放隐藏目录（archify 的 `.archify/`）也要能看见、能删 ——
    这不是"隐藏文件"，是它的输出。要挡的只有 .git / node_modules 这类工程噪音。"""
    sid = await _make_session(client)
    d = _session_files_dir(sid)
    (d / ".archify" / "run-1").mkdir(parents=True, exist_ok=True)
    (d / ".archify" / "run-1" / "diagram.html").write_text("<h1>x</h1>", encoding="utf-8")
    (d / ".git").mkdir(exist_ok=True)
    (d / ".git" / "config").write_text("[core]", encoding="utf-8")
    (d / "node_modules" / "pkg").mkdir(parents=True, exist_ok=True)
    (d / "node_modules" / "pkg" / "index.js").write_text("1", encoding="utf-8")

    got = (await client.get(f"/api/sessions/{sid}/files")).json()
    paths = [f["path"] for f in got["files"]]
    assert ".archify/run-1/diagram.html" in paths, paths
    assert not any(p.startswith(".git/") for p in paths), paths
    assert not any(p.startswith("node_modules/") for p in paths), paths

    # 也能删（管理里勾选后走批量删除）
    r = await client.post(
        f"/api/sessions/{sid}/files/delete", json={"paths": [".archify/run-1/diagram.html"]}
    )
    assert r.status_code == 200, r.text
    assert not (d / ".archify").exists(), "删完变空的 .archify 也要收掉"
