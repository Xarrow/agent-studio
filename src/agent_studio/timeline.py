"""执行时间线：把一条 run 的事件流压成「一次交互 = 一条」

为什么在服务端做
----------------
事件流是**唯一完整**的真相（续跑、HITL 恢复都只是往后追加事件），但一条长
run 有上万个 ``thinking_delta`` / ``text_delta``，全丢给浏览器就是几 MB 的
JSON。这里把它们压成固定几十条，正文只留预览；要看全文再单条拉。

口径（与界面一致）
------------------
一次「交互」是四类里的一条：
    llm    一次请求 + 响应（一轮）
    think  这一轮里的思考（父 = 该轮）
    tool   一次工具执行（父 = 该轮）
    hitl   等你点确认的那一段时间（父 = 该轮）

它同时替代了三块老界面：轮次/工具表（时间）、模型请求表（内容）、
"想了什么"步骤流（叙述）—— 三者本来就是同一件事的三种投影。
"""

from __future__ import annotations

from typing import Any, Iterable

#: 预览取多少字。够判断"这是不是我要看的那次"，又不至于把列表撑爆
PREVIEW = 300
#: 思考预览短一点：思考常常几千字，列表里只要头一句
THINK_PREVIEW = 160


def _preview(value: Any, n: int = PREVIEW) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    text = text.strip()
    return text if len(text) <= n else text[:n] + "…"


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in payload and payload[k] not in (None, ""):
            return payload[k]
    return None


def _hitl_tool(payload: dict[str, Any]) -> str:
    """HITL 事件里的工具名：AgentScope 把工具放在 ``tool_calls[]`` 里，
    顶层没有 tool_name —— 直接读顶层会得到「操作」这种没信息量的词。"""
    direct = _first(payload, "tool_name", "name", "tool")
    if isinstance(direct, str) and direct:
        return direct
    calls = payload.get("tool_calls")
    if isinstance(calls, list) and calls and isinstance(calls[0], dict):
        name = calls[0].get("name")
        if isinstance(name, str) and name:
            return name
    return "操作"


#: 派活类工具：这些调用「派给谁」决定了它在时间线上该是什么颜色
DISPATCH_TOOLS = {"dispatch", "fork_agent", "fork", "worker_steer", "worker_status", "worker_stop", "call_agent"}


def _target_agent(name: str, args: Any) -> str | None:
    """从参数里认出「这次派给了谁」。

    编排者分派多个助手时，界面上如果所有 dispatch 一个颜色，用户根本分不清
    哪一段是谁在跑——颜色必须跟着**被派的那个助手**走。
    """
    if not isinstance(args, dict):
        return None
    for key in ("agent", "agent_name", "target", "target_agent", "worker", "worker_name", "remote_agent"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _tool_key(payload: dict[str, Any]) -> str:
    key = _first(payload, "tool_call_id", "call_id", "tool_call")
    if isinstance(key, dict):
        key = key.get("id")
    return str(key) if key else ""


class _Builder:
    def __init__(
        self, run: Any, llm_calls: list[Any], tool_calls: list[Any], children: list[Any] | None = None
    ) -> None:
        self.children = list(children or [])
        self.run = run
        self.llm_calls = list(llm_calls)
        self.tool_calls = list(tool_calls)
        self.items: list[dict[str, Any]] = []
        self._llm: dict[str, Any] | None = None
        #: 最近一轮（工具/等待在它结束后才出现，但仍属于那一轮 —— 缩进要跟着轮次走）
        self._last_turn: dict[str, Any] | None = None
        self._think: dict[str, Any] | None = None
        self._tools: dict[str, dict[str, Any]] = {}
        self._hitl: dict[str, Any] | None = None
        self._iteration = 0
        self._think_chars = 0
        self._think_head = ""
        self._used_calls: set[int] = set()

    # -- 基础 ---------------------------------------------------------- #
    def _add(self, kind: str, name: str, ts: int, parent: str | None, **attrs: Any) -> dict[str, Any]:
        item = {
            "id": f"t{len(self.items)}",
            "kind": kind,
            "name": name,
            "started_at": ts,
            "ended_at": None,
            "parent_id": parent,
            "attributes": dict(attrs),
        }
        self.items.append(item)
        return item

    @staticmethod
    def _close(item: dict[str, Any] | None, ts: int, **attrs: Any) -> None:
        if item is None or item["ended_at"] is not None:
            return
        item["ended_at"] = ts
        item["attributes"].update({k: v for k, v in attrs.items() if v is not None})

    def _match_llm_call(self, ts: int) -> Any:
        """事件与 llm_call 行配对：取起始时间最近且没用过的那条。"""
        best_i, best_d = None, None
        for i, call in enumerate(self.llm_calls):
            if i in self._used_calls:
                continue
            d = abs(int(getattr(call, "started_at", 0) or 0) - ts)
            if best_d is None or d < best_d:
                best_i, best_d = i, d
        if best_i is None or (best_d is not None and best_d > 5000):
            return None
        self._used_calls.add(best_i)
        return self.llm_calls[best_i]

    # -- 事件 ---------------------------------------------------------- #
    def on(self, ev: Any) -> None:
        t, ts = ev.type, int(ev.ts)
        p = ev.payload or {}
        handler = getattr(self, f"_on_{t}", None)
        if handler is not None:
            handler(ts, p)

    def _on_llm_call_start(self, ts: int, p: dict[str, Any]) -> None:
        self._close_think(ts)
        self._close(self._llm, ts)
        self._iteration += 1
        call = self._match_llm_call(ts)
        model = _first(p, "model", "model_name") or (getattr(call, "model", None) if call else None)
        provider = _first(p, "provider") or (getattr(call, "provider", None) if call else None)
        self._llm = self._add(
            "llm",
            str(model or "模型请求"),
            ts,
            None,
            iteration=self._iteration,
            model=model,
            provider=provider,
            llm_call_id=getattr(call, "id", None) if call else None,
            tokens_in=getattr(call, "tokens_in", None) if call else None,
            tokens_out=getattr(call, "tokens_out", None) if call else None,
            cache_read=getattr(call, "tokens_cache_read", None) if call else None,
            ttft_ms=getattr(call, "ttft_ms", None) if call else None,
            status=getattr(call, "status", None) if call else None,
        )
        self._last_turn = self._llm
        self._think_chars, self._think_head = 0, ""

    def _on_llm_call_end(self, ts: int, p: dict[str, Any]) -> None:
        self._close_think(ts)
        usage = p.get("usage") if isinstance(p.get("usage"), dict) else {}
        attrs: dict[str, Any] = {"status": "error" if _first(p, "error") else "ok"}
        cur: dict[str, Any] = (self._llm or {}).get("attributes", {}) if self._llm else {}
        for src, dst in (("input_tokens", "tokens_in"), ("prompt_tokens", "tokens_in"),
                         ("output_tokens", "tokens_out"), ("completion_tokens", "tokens_out")):
            if usage.get(src) and not cur.get(dst):
                attrs[dst] = int(usage[src])
        self._close(self._llm, ts, **attrs)
        self._llm = None

    def _on_thinking_delta(self, ts: int, p: dict[str, Any]) -> None:
        chunk = _first(p, "delta", "text", "thinking", "content")
        text = chunk if isinstance(chunk, str) else ""
        self._think_chars += len(text)
        if not self._think_head and text.strip():
            self._think_head = _preview(text, THINK_PREVIEW)
        if self._think is None:
            self._think = self._add(
                "think", "思考", ts, self._llm["id"] if self._llm else None, chars=0
            )
            self._think["_seq_from"] = getattr(p, "_seq", None)

    def _on_text_delta(self, ts: int, p: dict[str, Any]) -> None:
        # 思考结束于第一段正文 —— 模型是先想后说
        if self._think is not None:
            self._close_think(ts)

    def _close_think(self, ts: int) -> None:
        if self._think is None:
            return
        self._close(self._think, ts, chars=self._think_chars, preview=self._think_head)
        self._think = None

    def _turn_id(self) -> str | None:
        turn = self._llm or self._last_turn
        return turn["id"] if turn else None

    def _on_tool_exec_start(self, ts: int, p: dict[str, Any]) -> None:
        key = _tool_key(p) or f"#{len(self._tools)}"
        name = _first(p, "tool_name", "tool_call_name", "name") or "工具"
        rec = next((t for t in self.tool_calls if (t.call_id or "") == key), None)
        args = getattr(rec, "args", None) if rec else None
        target = _target_agent(str(name), args) if str(name).lower() in DISPATCH_TOOLS else None
        item = self._add(
            "tool", str(name), ts, self._turn_id(),
            call_id=key,
            tool_call_id=getattr(rec, "id", None) if rec else None,
            args_preview=_preview(args),
            status=getattr(rec, "status", None) if rec else None,
            # 派给谁 —— 前端按它给这条上色（同一个 helper 的多次派活同色）
            agent=target,
        )
        item["_seq_from"] = None
        self._tools[key] = item

    def _on_tool_exec_end(self, ts: int, p: dict[str, Any]) -> None:
        key = _tool_key(p)
        item = self._tools.pop(key, None)
        if item is None:
            return
        rec = next((t for t in self.tool_calls if (t.call_id or "") == key), None)
        status = _first(p, "status", "state")
        if isinstance(status, str) and status.lower() in ("success", "ok", "completed", "done"):
            status = "ok"   # AgentScope 用 state=success，界面只认 ok/error
        if _first(p, "error"):
            status = "error"
        self._close(
            item, ts,
            status=str(status) if status else (getattr(rec, "status", None) if rec else "ok"),
            result_preview=_preview(getattr(rec, "result_preview", None) if rec else None),
            result_size=getattr(rec, "result_size", None) if rec else None,
        )

    def _on_hitl_request(self, ts: int, p: dict[str, Any]) -> None:
        tool = _hitl_tool(p)
        self._hitl = self._add(
            "hitl",
            f"等你确认 · {tool}",
            ts,
            self._turn_id(),
            tool=str(tool),
        )

    def _on_hitl_decided(self, ts: int, p: dict[str, Any]) -> None:
        self._close(
            self._hitl, ts,
            decision="允许" if p.get("confirm", True) else "拒绝",
            waited_ms=int(p.get("waited_ms") or 0) or None,
        )
        self._hitl = None

    def _on_error(self, ts: int, p: dict[str, Any]) -> None:
        msg = _preview(_first(p, "error", "message"), 200)
        self._close_think(ts)
        self._close(self._llm, ts, status="error", error=msg)
        self._llm = None
        for item in self._tools.values():
            self._close(item, ts, status="error", error=msg)
        self._tools.clear()
        self._close(self._hitl, ts, decision="未答复")
        self._hitl = None

    def _on_run_end(self, ts: int, p: dict[str, Any]) -> None:
        self.finish(ts)

    # -- 收尾 ---------------------------------------------------------- #
    def finish(self, ts: int) -> None:
        self._close_think(ts)
        self._close(self._llm, ts)
        self._llm = None
        for item in self._tools.values():
            self._close(item, ts)
        self._tools.clear()
        self._close(self._hitl, ts, decision="未答复")
        self._hitl = None

    def add_worker_runs(self) -> None:
        """把派出去的子执行也画成条。

        只有 ``dispatch`` 那一行 33ms 是看不出"派出去之后谁在跑、跑多久"的 ——
        编排者真正的耗时都在子执行里。子执行按**助手**上色，几路并行时
        颜色叠在一起就是"谁和谁同时在跑"。
        """
        for child in self.children:
            started = int(getattr(child, "started_at", 0) or 0)
            if not started:
                continue
            agent = str(getattr(child, "agent_name", "") or getattr(child, "agent_id", "") or "子执行")
            # 挂到它开始时的那一轮下面（找不到就挂在最近的一轮）
            parent = None
            for it in self.items:
                if it["kind"] == "llm" and it["started_at"] <= started:
                    parent = it["id"]
            item = {
                "id": f"w{getattr(child, 'id', len(self.items))}",
                "kind": "worker",
                "name": agent,
                "started_at": started,
                "ended_at": getattr(child, "ended_at", None),
                "parent_id": parent,
                "attributes": {
                    "agent": agent,
                    "run_id": getattr(child, "id", None),
                    "status": getattr(child, "status", None),
                    "tokens_in": (getattr(child, "usage", None) or {}).get("tokens_in"),
                    "tokens_out": (getattr(child, "usage", None) or {}).get("tokens_out"),
                },
            }
            self.items.append(item)

    def result(self, *, end_ts: int | None = None) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = list(self.items)
        if end_ts:
            self.finish(end_ts)
        # 没闭合的（崩了/被杀）用最后一条时间戳兜底，否则瀑布上出现"永不结束"的条
        last = max([i["started_at"] for i in items] + [int(getattr(self.run, "started_at", 0) or 0)])
        for it in items:
            if it["ended_at"] is None:
                it["ended_at"] = max(last, int(getattr(self.run, "ended_at", 0) or 0))
            it["duration_ms"] = max(0, it["ended_at"] - it["started_at"])
            it.pop("_seq_from", None)
        items.sort(key=lambda i: (i["started_at"], 0 if i["kind"] == "llm" else 1))
        return items


def build_timeline(
    *,
    run: Any,
    events: Iterable[Any],
    llm_calls: list[Any] | None = None,
    tool_calls: list[Any] | None = None,
    children: list[Any] | None = None,
) -> dict[str, Any]:
    """事件流 → 时间线条目（含总时长与最慢项）。"""
    builder = _Builder(run, llm_calls or [], tool_calls or [], children or [])
    for ev in events:
        builder.on(ev)
    builder.add_worker_runs()
    items = builder.result(end_ts=int(getattr(run, "ended_at", 0) or 0) or None)

    starts: list[int] = [int(i["started_at"]) for i in items]
    ends: list[int] = [int(i["ended_at"] or i["started_at"]) for i in items]
    if not starts:
        started = int(getattr(run, "started_at", 0) or 0)
        return {"items": [], "started_at": started, "ended_at": started, "total_ms": 0, "slowest": None}

    started, ended = min(starts), max(ends)
    # 总计以 run 自身为准（首尾事件之间可能少了启动/收尾的空档）
    run_start = int(getattr(run, "started_at", 0) or 0)
    run_end = int(getattr(run, "ended_at", 0) or 0)
    if run_start:
        started = min(started, run_start)
    if run_end:
        ended = max(ended, run_end)

    slowest: dict[str, Any] | None = None
    for it in items:
        if it["kind"] in ("llm", "tool", "hitl"):
            if slowest is None or int(it["duration_ms"]) > int(slowest["duration_ms"]):
                slowest = it
    return {
        "items": items,
        "started_at": started,
        "ended_at": ended,
        "total_ms": max(0, ended - started),
        "slowest": slowest,
    }
