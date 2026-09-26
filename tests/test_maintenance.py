"""护栏：事件分层归档 + /metrics。

归档这件事最怕两件：**误伤**（动了近期的、正在跑的、还要排障的记录）和**不幂等**
（反复整理把数据越弄越乱）。各钉一条断言。
/metrics 则钉"数字与库里一致"—— 监控数字错了比没有监控更坏。
"""

from __future__ import annotations

import uuid

from agent_studio import maintenance
from agent_studio.db import SessionLocal
from agent_studio.models import Run, RunEvent, now_ms

from test_gate_and_retry import _mk_agent

DAY = 24 * 3600 * 1000


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _seed_run(agent_id: str, *, age_ms: int, status: str = "ok", with_events: int = 0, big: bool = False) -> str:
    """造一条带事件的执行记录。age_ms 决定它"多老"。"""
    async with SessionLocal() as s:
        run = Run(
            agent_id=agent_id,
            agent_version=1,
            runtime="agentscope",
            status=status,
            input={"text": "x"},
            output={"content": "最终产出"},
            definition_snapshot={"model": {"name": "deepseek-v4-flash"}},
            usage={"tokens_in": 3, "tokens_out": 2},
            started_at=now_ms() - age_ms - 1000,
            # 在途的执行没有 ended_at —— 归档必须靠它把我们排除掉
            ended_at=None if status not in ("ok", "error", "aborted") else now_ms() - age_ms,
        )
        s.add(run)
        await s.flush()
        seq = 0
        s.add(RunEvent(run_id=run.id, seq=seq, type="run_start", ts=now_ms() - age_ms, payload={}))
        for i in range(with_events):
            seq += 1
            s.add(
                RunEvent(
                    run_id=run.id,
                    seq=seq,
                    type="text_delta",
                    ts=now_ms() - age_ms + i,
                    payload={"content": "逐字片段" * (40 if big else 1)},
                )
            )
        seq += 1
        s.add(
            RunEvent(
                run_id=run.id,
                seq=seq,
                type="tool_exec_end",
                ts=now_ms() - age_ms,
                payload={"result": "R" * (20000 if big else 20)},
            )
        )
        await s.commit()
        return run.id


async def _payload_bytes(run_id: str) -> int:
    import json as _json

    async with SessionLocal() as s:
        rows = (await s.execute(RunEvent.__table__.select().where(RunEvent.run_id == run_id))).all()
    return sum(len(_json.dumps(dict(r._mapping["payload"]), ensure_ascii=False)) for r in rows)


async def test_compact_collapses_stream_deltas_for_old_runs_only(client):
    aid = await _mk_agent(client, "agentscope", uniq("归档"))
    old = await _seed_run(aid, age_ms=40 * DAY, with_events=30, big=True)
    fresh = await _seed_run(aid, age_ms=1 * DAY, with_events=30)
    running = await _seed_run(aid, age_ms=40 * DAY, status="running", with_events=10)

    before_old = await _payload_bytes(old)
    async with SessionLocal() as s:
        stats = await maintenance.compact_events(s, keep_days=7, preview_bytes=1024)

    assert stats["runs_archived"] == 1, "只该动那条 40 天前的（7 天内 / 在途的都不能碰）"
    assert stats["rows_removed"] == 30
    assert stats["bytes_after"] < stats["bytes_before"], "归档后 payload 必须变小"
    assert await _payload_bytes(old) < before_old

    async with SessionLocal() as s:
        types = [
            r[0]
            for r in (
                await s.execute(
                    RunEvent.__table__.select().with_only_columns(RunEvent.type).where(RunEvent.run_id == old)
                )
            ).all()
        ]
        fresh_types = [
            r[0]
            for r in (
                await s.execute(
                    RunEvent.__table__.select().with_only_columns(RunEvent.type).where(RunEvent.run_id == fresh)
                )
            ).all()
        ]
        running_rows = (
            await s.execute(
                RunEvent.__table__.select().with_only_columns(RunEvent.type).where(RunEvent.run_id == running)
            )
        ).all()
    assert types.count("text_delta") == 0 and "archived" in types, "老执行的逐字片段该被折叠成一条归档行"
    assert "run_start" in types and "tool_exec_end" in types, "骨架（时间线）必须保留"
    assert fresh_types.count("text_delta") == 30, "近 7 天的执行一行都不该动"
    assert len(running_rows) == 10 + 2, "**在途执行绝不能碰**（它还在写事件）: 1 起 + 10 片段 + 1 工具"


async def test_compact_truncates_huge_payloads_with_marker(client):
    aid = await _mk_agent(client, "agentscope", uniq("截断"))
    rid = await _seed_run(aid, age_ms=40 * DAY, with_events=0, big=True)
    async with SessionLocal() as s:
        await maintenance.compact_events(s, keep_days=7, preview_bytes=1024)
        row = (
            await s.execute(
                RunEvent.__table__.select().where(RunEvent.run_id == rid, RunEvent.type == "tool_exec_end")
            )
        ).first()
    payload = dict(row._mapping["payload"])
    assert payload.get("_truncated") is True, "超大 payload 该被截断并留标记"
    assert payload.get("_bytes", 0) > 10000, "要记下原始大小（否则看不出这里被截过）"


async def test_compact_is_idempotent(client):
    aid = await _mk_agent(client, "agentscope", uniq("幂等"))
    await _seed_run(aid, age_ms=40 * DAY, with_events=12)
    async with SessionLocal() as s:
        first = await maintenance.compact_events(s, keep_days=7)
    async with SessionLocal() as s:
        second = await maintenance.compact_events(s, keep_days=7)
    assert first["runs_archived"] == 1
    assert second["runs_archived"] == 0, "整理过的不该再被整理一遍（已打 events_archived_at 标记）"


async def test_storage_and_compact_endpoints(client):
    aid = await _mk_agent(client, "agentscope", uniq("接口"))
    await _seed_run(aid, age_ms=40 * DAY, with_events=10)

    body = (await client.get("/api/maintenance/storage")).json()
    assert body["event_rows"] > 0 and body["keep_days"] == 7
    assert body["stream_rows"] > 0, "体检要能看出流式片段占了多少行"

    res = (await client.post("/api/maintenance/compact")).json()
    assert res["ok"] is True and res["runs_archived"] >= 1

    after = (await client.get("/api/maintenance/storage")).json()
    assert after["runs_archived"] >= 1
    assert after["last_auto_run_at"], "整理完要记下时间（界面显示上次整理）"


async def test_metrics_endpoint_numbers_match_db(client):
    aid = await _mk_agent(client, "agentscope", uniq("指标"))
    await _seed_run(aid, age_ms=1000, with_events=3)

    r = await client.get("/metrics")
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    text = r.text
    for name in (
        "agent_studio_runs_total",
        "agent_studio_queue_pending",
        "agent_studio_tokens_total",
        "agent_studio_cost_total",
        "agent_studio_event_rows",
        "agent_studio_gate_slots",
    ):
        assert f"# TYPE {name} " in text, f"缺少指标 {name}"
    async with SessionLocal() as s:
        runs = len((await s.execute(Run.__table__.select())).all())
    line = next(l for l in text.splitlines() if l.startswith("agent_studio_runs_total{"))
    assert int(line.split()[-1]) >= 1
    assert f"# HELP agent_studio_runs_total" in text
    assert runs >= 1

    # 没填单价时金额不能假装是 0 —— 界面的口径（pricing）在这里也必须一致
    assert "agent_studio_unpriced_runs_total" in text
