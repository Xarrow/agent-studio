"""护栏：运行记录的分页与搜索。

原来是把 1000 条窗口全捞进内存再在 Python 里筛 —— 直接导致三件事：
  ① 超过窗口的老记录**翻不到**（不是慢，是看不见）
  ② 搜索只在这个窗口内匹配 → "我明明搜到过那条"变成玄学
  ③ 每次请求都把上千行记录的 input/output 全文读出来再扔掉
这几条各钉一个断言，避免以后有人"顺手改回内存筛"。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal
from agent_studio.models import ModelTest, Run, now_ms

from test_gate_and_retry import _mk_agent


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _seed(agent_id: str, n: int, *, base_at: int | None = None, same_ms: bool = False, text: str = "批量造的数据", status: str = "ok") -> list[str]:
    """直接塞记录（列表接口不执行任何东西，不需要真跑一遍）。"""
    now = base_at or (now_ms() - 10 * 60 * 1000)
    ids: list[str] = []
    async with SessionLocal() as s:
        for i in range(n):
            rows = Run(
                agent_id=agent_id,
                agent_version=1,
                runtime="agentscope",
                status=status,
                input={"text": text},
                output={"content": "产出"},
                definition_snapshot={"model": {"name": "deepseek-v4-flash"}},
                usage={"tokens_in": 10, "tokens_out": 5},
                # same_ms=True：全部落在同一毫秒 —— 专测游标的 tiebreak
                started_at=now if same_ms else now - i * 1000,
                ended_at=(now - i * 1000) + 500,
                origin="preview",
            )
            s.add(rows)
            await s.flush()
            ids.append(rows.id)
        await s.commit()
    return ids


async def test_timeline_pages_with_cursor(client):
    aid = await _mk_agent(client, "agentscope", uniq("分页"))
    await _seed(aid, 60)

    r = await client.get("/api/runs/timeline", params={"agent_id": aid, "limit": 50})
    body = r.json()
    assert len(body["items"]) == 50, "第一页应当是 50 条"
    assert body["has_more"] is True
    assert body["total"] == 60, f"total 要能告诉用户一共多少条，实际 {body['total']}"

    last = body["items"][-1]
    r2 = await client.get(
        "/api/runs/timeline",
        params={"agent_id": aid, "limit": 50, "before": last["at"], "before_id": last["id"]},
    )
    body2 = r2.json()
    assert len(body2["items"]) == 10, "第二页应当是剩下的 10 条"
    assert body2["has_more"] is False

    ids1 = {i["id"] for i in body["items"]}
    ids2 = {i["id"] for i in body2["items"]}
    assert not (ids1 & ids2), "两页出现了重复记录（游标没起作用）"


async def test_timeline_cursor_handles_same_millisecond(client):
    """同一毫秒内的多条记录：靠 id tiebreak，翻页既不漏也不重。

    这是最容易做错的地方 —— 只用 `started_at <` 做游标时，
    同毫秒的剩下几条会**永远翻不到**（或者被重复返回）。
    """
    aid = await _mk_agent(client, "agentscope", uniq("同毫秒"))
    seeded = set(await _seed(aid, 5, same_ms=True))

    seen: set[str] = set()
    cursor: dict = {"agent_id": aid, "limit": 2}
    for _ in range(5):
        body = (await client.get("/api/runs/timeline", params=cursor)).json()
        got = [i["id"] for i in body["items"]]
        assert not (set(got) & seen), "同毫秒记录被重复返回"
        seen.update(got)
        if not body["has_more"]:
            break
        cursor = {**cursor, "before": body["items"][-1]["at"], "before_id": body["items"][-1]["id"]}
    assert seen == seeded, f"翻页漏了记录：{seeded - seen}"


async def test_timeline_search_reaches_beyond_first_page(client):
    """搜索必须在**全库**里匹配，而不是只搜当前这一页的 50 条。

    这正是原来最坑的地方：老记录明明存在，搜不到，用户会以为数据丢了。
    """
    aid = await _mk_agent(client, "agentscope", uniq("搜索"))
    marker = uniq("藏在最旧那条里")
    await _seed(aid, 55, text="普通数据")
    oldest = 60 * 1000 * 60 * 24  # 25 小时前 —— 稳稳落在第一页之后
    await _seed(aid, 1, base_at=now_ms() - oldest, text=marker)

    body = (await client.get("/api/runs/timeline", params={"agent_id": aid, "limit": 50})).json()
    assert marker not in str(body["items"]), "前提：那条不在第一页（否则这个测试没意义）"

    hit = (await client.get("/api/runs/timeline", params={"agent_id": aid, "q": marker})).json()
    assert len(hit["items"]) == 1, "搜索应当能翻到第一页之外的老记录"
    assert marker in (hit["items"][0]["summary"] or "")
    assert hit["total"] == 1


async def test_timeline_filters_are_pushed_into_sql(client):
    aid = await _mk_agent(client, "agentscope", uniq("筛选"))
    await _seed(aid, 3, status="ok", text="成功的一批")
    await _seed(aid, 2, status="error", text="失败的一批")

    ok = (await client.get("/api/runs/timeline", params={"agent_id": aid, "status": "ok"})).json()
    bad = (await client.get("/api/runs/timeline", params={"agent_id": aid, "status": "error"})).json()
    assert ok["total"] == 3 and len(ok["items"]) == 3
    assert bad["total"] == 2 and all(i["status"] == "error" for i in bad["items"])


async def test_timeline_kind_filter_excludes_bare_model_tests(client):
    """只看助手执行时，裸模型调用（llm_test）不该混进来 —— 反过来也一样。"""
    aid = await _mk_agent(client, "agentscope", uniq("类型"))
    await _seed(aid, 2)
    async with SessionLocal() as s:
        s.add(
            ModelTest(
                provider="deepseek",
                model="deepseek-v4-flash",
                credential_name="测试",
                status="ok",
                messages=[{"role": "user", "content": "裸调用"}],
                reply="好",
                started_at=now_ms(),
                duration_ms=100,
            )
        )
        await s.commit()

    only_runs = (await client.get("/api/runs/timeline", params={"agent_id": aid, "kind": "preview"})).json()
    assert all(i["kind"] == "preview" for i in only_runs["items"])
    only_tests = (await client.get("/api/runs/timeline", params={"kind": "llm_test"})).json()
    assert only_tests["items"] and all(i["kind"] == "llm_test" for i in only_tests["items"])
    assert "llm_test" in only_tests["counts"]
