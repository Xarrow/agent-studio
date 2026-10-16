"""会话隔离与文件目录隔离。

守的是一个很容易被忽略的事实：**目录就是权限边界**（权限 scope 里
"工作目录内直接放行"指的就是它）。所以"哪个会话在哪个目录"不是美观问题 ——

  · 两个会话同时写 ``result.md`` 不能互相覆盖；
  · 一次编排的所有节点必须在**同一棵**目录树下，否则编排者去读分派实例
    的产物就变成"越出工作目录"，无人值守的编排会卡在人工确认上；
  · 名字不许带路径分隔符 / ``..``（否则边界直接形同虚设）。
"""

from __future__ import annotations

import json

import pytest

from agent_studio.api.maintenance import scan_session_dirs
from agent_studio.config import settings
from agent_studio.runner.service import (
    resolve_work_dir,
    session_work_dir,
    workspace_isolation,
)
from agent_studio.schemas import AgentDefinition


def _defn(**kw) -> AgentDefinition:
    return AgentDefinition(runtime="agentscope", name="测试助手", system_prompt="干活的", **kw)


# --------------------------------------------------------------------------- #
# 目录解析
# --------------------------------------------------------------------------- #
def test_默认按会话隔离():
    assert workspace_isolation(_defn()) == "session"
    a = resolve_work_dir(_defn(), session_id="ses_aaa")
    b = resolve_work_dir(_defn(), session_id="ses_bbb")
    assert a != b
    assert a.name == "ses_aaa" and a.parent.name == "sessions"
    assert b.name == "ses_bbb"
    assert a.is_dir() and b.is_dir(), "用的时候要建出来"


def test_没有会话的三种情形各占一个目录():
    d = _defn()
    orc = resolve_work_dir(d, orchestration_id="orc_1")
    run = resolve_work_dir(d, run_id="run_1")
    assert orc == run.parent / "orc-orc_1"
    assert orc != run, "不同编排/不同单跑不许共用目录"
    # 同一次编排的所有节点必须同一棵树下（权限边界要求）
    assert resolve_work_dir(d, orchestration_id="orc_1") == orc


def test_会话里的多轮与分派共用同一棵树():
    lane_def = _defn(workspace="fanout-abc123-1")     # 分派出去的每一路：名字被改成自己的
    base = resolve_work_dir(_defn(), session_id="ses_aaa")
    lane = resolve_work_dir(lane_def, session_id="ses_aaa")
    assert lane.parent == base, "分派出去的那一路要在会话目录**里面**（否则编排者读不到）"
    other = resolve_work_dir(lane_def, session_id="ses_bbb")
    assert other.parent.parent.name == "sessions" and other.parent.name == "ses_bbb"


def test_助手自己的名字是会话目录下的子目录():
    d = _defn(workspace="proj")
    assert resolve_work_dir(d, session_id="ses_aaa") == session_work_dir("ses_aaa") / "proj"


def test_可以显式选回共用目录():
    d = _defn(workspace_isolation="shared", workspace="proj")
    assert workspace_isolation(d) == "shared"
    assert resolve_work_dir(d, session_id="ses_aaa") == (settings.work_dir / "proj").resolve()


def test_脏名字不会逃出沙箱():
    """绝对路径 / ``..`` / 分隔符 —— 一律忽略并回退上一层（边界不能有缝）。"""
    root = settings.work_dir.resolve()
    for bad in ["/etc", "../..", "a/b", "..", "./x"]:
        d = _defn(workspace=bad)
        got = resolve_work_dir(d, session_id="ses_aaa")
        assert root in got.parents, f"{bad!r} 逃出沙箱了：{got}"
        assert got == session_work_dir("ses_aaa"), f"{bad!r} 不该被当成目录名"
    # 会话号脏 → 退回共享目录，也不许拼出越界路径
    got = resolve_work_dir(_defn(), session_id="../../etc")
    assert got == root


def test_会话目录不代表会越权读别人(tmp_path):
    """两个会话的目录互不包含 —— 这是"看不见对方文件"的前提。"""
    a = resolve_work_dir(_defn(), session_id="ses_aaa")
    b = resolve_work_dir(_defn(), session_id="ses_bbb")
    assert a not in b.parents and b not in a.parents


# --------------------------------------------------------------------------- #
# 会话接口
# --------------------------------------------------------------------------- #
async def test_会话详情给出文件目录(client):
    agent = (
        await client.post(
            "/api/agents",
            json={"name": "隔离测试助手", "definition": {"runtime": "agentscope", "name": "隔离测试助手", "system_prompt": "x"}},
        )
    ).json()
    ses = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "会话A"})).json()
    assert ses["work_dir"].endswith(f"sessions/{ses['id']}"), ses["work_dir"]
    detail = (await client.get(f"/api/sessions/{ses['id']}")).json()
    assert detail["session"]["work_dir"] == ses["work_dir"]


async def test_会话文件列表只看自己那一个(client):
    agent = (
        await client.post(
            "/api/agents",
            json={"name": "隔离测试助手2", "definition": {"runtime": "agentscope", "name": "隔离测试助手2", "system_prompt": "x"}},
        )
    ).json()
    a = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "A"})).json()
    b = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "B"})).json()

    # 两个会话各写一个同名文件（模拟两轮对话各产出一份报告）
    da = session_work_dir(a["id"])
    db_ = session_work_dir(b["id"])
    (da / "reports").mkdir(parents=True, exist_ok=True)
    (da / "reports" / "result.md").write_text("A 的报告", encoding="utf-8")
    db_.mkdir(parents=True, exist_ok=True)
    (db_ / "result.md").write_text("B 的报告", encoding="utf-8")
    (db_ / ".hidden").write_text("不给看", encoding="utf-8")

    fa = (await client.get(f"/api/sessions/{a['id']}/files")).json()
    assert [f["path"] for f in fa["files"]] == ["reports/result.md"]
    assert fa["work_dir"] == str(da)
    assert fa["files"][0]["url"].startswith("/api/work/file/sessions/")

    fb = (await client.get(f"/api/sessions/{b['id']}/files")).json()
    assert [f["path"] for f in fb["files"]] == ["result.md"], "别会话的文件不许出现"
    assert ".hidden" not in json.dumps(fb)

    # 产物取回端点也能按会话路径取（图片/报告点得开）
    got = await client.get(fa["files"][0]["url"])
    assert got.status_code == 200 and got.text == "A 的报告"


async def test_删会话顺手删目录但只删自己那一个(client):
    agent = (
        await client.post(
            "/api/agents",
            json={"name": "隔离测试助手3", "definition": {"runtime": "agentscope", "name": "隔离测试助手3", "system_prompt": "x"}},
        )
    ).json()
    a = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "要删"})).json()
    b = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "留着"})).json()
    da, db_ = session_work_dir(a["id"]), session_work_dir(b["id"])
    for d, text in ((da, "a"), (db_, "b")):
        d.mkdir(parents=True, exist_ok=True)
        (d / "keep.txt").write_text(text, encoding="utf-8")

    r = await client.delete(f"/api/sessions/{a['id']}")
    assert r.status_code == 200
    assert r.json()["removed_dir"] == str(da)
    assert not da.exists(), "删掉的会话不该把文件留在盘上"
    assert db_.is_dir() and (db_ / "keep.txt").is_file(), "别人的目录一个字节都不许动"
    # 沙箱根与 sessions 根当然也不能被删
    assert (settings.work_dir).is_dir() and (settings.work_dir / "sessions").is_dir()


# --------------------------------------------------------------------------- #
# 会话目录体检 / 清理
# --------------------------------------------------------------------------- #
async def test_体检只把没主的标成可清(client):
    agent = (
        await client.post(
            "/api/agents",
            json={"name": "隔离测试助手4", "definition": {"runtime": "agentscope", "name": "隔离测试助手4", "system_prompt": "x"}},
        )
    ).json()
    live = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "活的"})).json()
    live_dir = session_work_dir(live["id"])
    live_dir.mkdir(parents=True, exist_ok=True)
    (live_dir / "a.txt").write_text("x", encoding="utf-8")
    orphan = session_work_dir("ses_手工删过库的残留")
    orphan.mkdir(parents=True, exist_ok=True)
    (orphan / "junk.txt").write_text("y", encoding="utf-8")

    info = (await client.get("/api/maintenance/session-dirs")).json()
    assert live["id"] not in [d["session_id"] for d in info["orphans"]]
    assert "ses_手工删过库的残留" in [d["session_id"] for d in info["orphans"]]

    cleaned = (await client.post("/api/maintenance/session-dirs/clean", json={})).json()
    assert "ses_手工删过库的残留" in cleaned["removed"]
    assert not orphan.exists()
    assert session_work_dir(live["id"]).is_dir(), "有主的目录不许被清"


async def test_点名也删不掉有主的目录(client):
    agent = (
        await client.post(
            "/api/agents",
            json={"name": "隔离测试助手5", "definition": {"runtime": "agentscope", "name": "隔离测试助手5", "system_prompt": "x"}},
        )
    ).json()
    live = (await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "活的"})).json()
    d = session_work_dir(live["id"])
    d.mkdir(parents=True, exist_ok=True)
    (d / "important.txt").write_text("别删", encoding="utf-8")

    got = (await client.post("/api/maintenance/session-dirs/clean", json={"session_ids": [live["id"]]})).json()
    assert got["removed"] == []
    assert (d / "important.txt").read_text(encoding="utf-8") == "别删"


def test_体检扫到的目录必须都是_sessions_下的(tmp_path):
    """护栏本体：扫描结果永远在 sessions/ 里（清理只可能删到这一层）。"""
    root = settings.work_dir.resolve() / "sessions"
    (root / "ses_x").mkdir(parents=True, exist_ok=True)
    # 只看自己造的这个目录（同一 session 里别的用例也会留下目录）
    mine = [d for d in scan_session_dirs({"ses_x"}) if d["session_id"] == "ses_x"]
    assert mine, "应当扫到 ses_x"
    for d in mine:
        assert d["path"].startswith(str(root))
        assert d["orphan"] is False
