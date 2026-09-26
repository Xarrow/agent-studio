"""编排器 —— 多助手协作的执行大脑。

职责边界（很重要）
------------------
编排器**只做三件事**：

1. 决定谁先跑、谁和谁同时跑（模式）
2. 在步骤之间传递数据（上一步的产出怎么进下一步）
3. 汇总出最终结果

**单步执行完全交给 ``runner.run_service``** —— 编排器不碰 runtime、不碰
AgentScope、不碰事件流。所以：

- 每个子步骤都是一条普通的 ``run`` 记录 → 日志、耗时、TTFT、分色执行过程、
  断线回放**全部白送**（前端复用同一套 RunTimeline）
- 换运行时（agentscope → pi → …）**编排代码一行都不用改**

四种模式
--------
| 模式 | 怎么跑 | 最终结果 |
|---|---|---|
| ``single`` | 一个助手跑一次 | 它的产出 |
| ``serial`` | 按槽位顺序，**每步由用户决定是否接收上一步产出** | 最后一步的产出 |
| ``parallel`` | 所有助手同时跑，各自拿同一份任务 | 各步产出的汇总（供对比） |
| ``master_worker`` | 主控拆任务 → 干活的分头做 → **主控汇总** | **主控的汇总结论** |
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
import json
import logging
import re
from typing import Any

from ..db import SessionLocal
from ..models import Agent, Orchestration, Run, now_ms
from ..schemas import AgentDefinition

logger = logging.getLogger(__name__)

#: **编排者（Orchestrator）的固定交代** —— 用户给的四项能力。
#:
#: 什么时候用：把某个助手的分类设成 orchestrator（Agent 定义里的 role），
#: 它适合放在流程的**首节点**（先把目标分析清楚、管好上下文再交下去）
#: 或**末节点**（收齐各步产出，做验证与归纳总结）。
#:
#: 为什么在这里拼：``_start_step`` 是所有执行模式（single / serial / parallel / dag / 主从）
#: 唯一的汇合点 —— 在这里注入一次，所有模式都一致，且会写进 run 的
#: ``definition_snapshot``（所以"到底给它什么交代"是可追溯、可复查的 ✓）。
ORCHESTRATOR_BRIEF = """你是这条流程的**编排者**，对整条流程的结果负责（而不是只做完手里这一小步）：

1) **分析任务** —— 先把用户的目标拆清楚：这一步要产出什么、下游需要什么、判断标准是什么；
   目标含糊就把它收敛成可执行的一条，不要笼统复述。
2) **管理上下文** —— 只保留与目标相关的事实，把上游与自己的产出整理成**结构化**的上下文；
   无关信息丢掉，冲突的信息明确指出。
3) **验证结果** —— 对拿到的产出做核验：有没有缺项、有没有自相矛盾、有没有声称做了但其实没做的；
   验证结论要写出来（通过/不通过 + 依据）。
4) **归纳总结** —— 给出结论性交付：先给结论，再给依据与关键证据；最后明确列出
   **待确认项 / 风险 / 建议的下一步**。

输出要求：条理清晰、可直接交付；不确定的地方明确标注"不确定"，不要编造。"""


#: 单个子步骤最长等多久（秒）。够跑完一次带工具的多轮推理。
STEP_TIMEOUT_S = 900

#: 一次编排最多允许的步骤数（防手滑拖进来几十个把账单打爆）
MAX_STEPS = 12


class OrchestratorError(Exception):
    """编排层面的错误（参数不对、Agent 缺失等）。"""


# --------------------------------------------------------------------------- #
# 提示词（主从模式用）
# --------------------------------------------------------------------------- #
_PLAN_PROMPT = """你是一个任务协调者。用户交给整个团队的任务是：

{task}

团队里有 {n} 位助手。请你把任务拆成 {n} 个子任务，每位助手负责一个。

要求：
1. 每个子任务要**具体、可独立完成**，写清楚要产出什么
2. 子任务之间**不要重复**
3. **只输出一个 JSON 数组**，不要任何解释、不要 markdown 代码块，格式严格如下：
["第一个子任务", "第二个子任务", ...]
"""

_SUMMARY_PROMPT = """你是一个任务协调者。用户交给整个团队的任务是：

{task}

各位助手已经完成了各自的部分，产出如下：

{parts}

请你**综合**以上所有结果，直接给出对用户任务的最终答复。
要求：不要罗列"某某助手说了什么"，而是把内容整合成一份完整、连贯的答复。
"""


#: 这次编排是**谁发起的**（playground / schedule / webhook）→ 写进 run.origin，
#: 运行记录里才分得清"我点的"和"它自己跑的 / 别的系统调起来的"。
#:
#: 为什么用 contextvar 而不是实例属性：``_start_step`` 拿不到 spec，
#: 而 Orchestrator 是**共享单例** —— 挂实例属性会被并发执行的另一次编排覆盖。
#: contextvar 按 asyncio task 隔离，天然正确。
_RUN_ORIGIN: ContextVar[str] = ContextVar("orchestration_origin", default="playground")


def _not_fork_tool(ref: Any) -> bool:
    """定义快照里的 tool ref 不是"分派"工具（子实例不允许再分派 —— 深度 1）。"""
    if isinstance(ref, dict):
        return str(ref.get("name") or ref.get("ref") or "") != "fork"
    return str(ref or "") != "fork"


def _fanout_of(step: dict[str, Any]) -> dict[str, Any] | None:
    """把节点上的「分派」配置整理成内核要的形状；没配 = None（按单实例跑）。

    语义：``fanout="list"`` = 把**上游产出的清单**每项交给这个助手的一个实例并行处理。
    等待上限沿用节点上那个「最长等多久」（同一件事：这一步最多等多久）。
    """
    mode = str((step or {}).get("fanout") or "").strip()
    agent = (step or {}).get("fanout_agent")
    # 「派给谁」**与分派模式无关**：即使这一步不是"按清单容器"，只要助手自己能调「分派」工具
    # （典型：编排者开局后自己决定分几路），节点上配的这个对象就是它的**默认派发对象** ——
    # 人定死的默认不该由模型的记性决定。
    if mode != "list" and not agent:
        return None
    return {
        "mode": mode,
        "max": (step or {}).get("fanout_max"),
        "agent": agent,
        "wait_s": (step or {}).get("wait_timeout_s"),
        "budget": (step or {}).get("fanout_budget"),
        "workspace": (step or {}).get("fanout_workspace"),
    }


class Orchestrator:
    """编排执行器。无状态（所有状态都在库里），可以随处实例化。"""

    # ------------------------------------------------------------------ #
    # 入口
    # ------------------------------------------------------------------ #
    async def run(self, orc_id: str, spec: dict[str, Any]) -> None:
        """执行一次编排（通常作为后台任务被调用）。"""
        mode = spec.get("mode", "single")
        handlers = {
            "single": self._single,
            "serial": self._serial,
            "parallel": self._parallel,
            "master_worker": self._master_worker,
            # 画布上摆出来的任意 DAG（分叉再汇合）
            "dag": self._dag,
        }
        handler = handlers.get(mode)
        if handler is None:
            await self._finish(orc_id, "error", error=f"未知编排模式: {mode}")
            return

        # 谁发起的这次编排（画布 / 定时 / 外部调用）—— 后续 _start_step 建的每条 run 都带上它
        _RUN_ORIGIN.set(spec.get("origin") or "playground")
        try:
            await self._patch(orc_id, status="running")
            await handler(orc_id, spec)
        except asyncio.CancelledError:
            await self._finish(orc_id, "aborted", error="编排被中止")
            raise
        except Exception as exc:  # noqa: BLE001 —— 兜底，任何异常都要落库
            logger.exception("编排 %s 执行失败", orc_id)
            await self._finish(orc_id, "error", error=f"{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------ #
    # 四种模式
    # ------------------------------------------------------------------ #
    async def _single(self, orc_id: str, spec: dict[str, Any]) -> None:
        """单个助手：跑一次就完事。"""
        steps = self._steps(spec)
        task = self._task(spec)

        run = await self._start_step(orc_id, steps[0]["agent_id"], "worker", 0, task, node_id=steps[0].get("nid"), fanout=_fanout_of(steps[0]))
        done = await self._await(run.id, (steps[0] or {}).get("wait_timeout_s"))

        await self._finish(
            orc_id,
            status=self._status_of([done]),
            output={"content": self._text(done)},
            runs=[done],
        )

    async def _serial(self, orc_id: str, spec: dict[str, Any]) -> None:
        """串行：按槽位顺序跑，每步是否接收上一步产出由用户逐项决定。

        某步失败**不中断**编排 —— 后面的步骤可能还能补救（比如"翻译失败但
        校对可以基于原文直接干"）。失败的步骤计数进 partial。
        """
        steps = self._steps(spec)
        task = self._task(spec)

        prev_text: str | None = None
        done: list[Run] = []

        for i, step in enumerate(steps):
            carry = bool(step.get("carry_prev"))
            payload = self._compose(task, prev_text if carry else None, i)
            run = await self._start_step(orc_id, step["agent_id"], "worker", i, payload, node_id=step.get("nid"), fanout=_fanout_of(step))
            r = await self._await(run.id, step.get("wait_timeout_s"))
            done.append(r)
            # 只有成功且有内容才更新"上一步产出"，失败的输出传下去没意义
            if r.status == "ok" and (t := self._text(r)):
                prev_text = t

        await self._finish(
            orc_id,
            status=self._status_of(done),
            output={"content": prev_text or ""},
            runs=done,
        )

    async def _parallel(self, orc_id: str, spec: dict[str, Any]) -> None:
        """并行：所有助手同时开跑，各自拿同一份任务，互不干扰。"""
        steps = self._steps(spec)
        task = self._task(spec)

        # 先把所有 Run 建好并启动，让它们真正并发
        runs = [
            await self._start_step(orc_id, step["agent_id"], "worker", i, task, node_id=step.get("nid"), fanout=_fanout_of(step))
            for i, step in enumerate(steps)
        ]
        # return_exceptions=True：一个挂了不能拖垮其余
        results = await asyncio.gather(
            *(self._await(r.id, step.get("wait_timeout_s")) for r, step in zip(runs, steps)),
            return_exceptions=True,
        )

        done: list[Run] = []
        for r, res in zip(runs, results):
            if isinstance(res, BaseException):
                logger.warning("并行分支 %s 异常: %s", r.id, res)
                # 异常分支不阻塞汇总：把它当作"这一步没产出"
                continue
            done.append(res)

        # 汇总成可对比的分段文本
        parts = [
            f"【{self._agent_name_of(r)}】\n{self._text(r)}" for r in done
        ]
        await self._finish(
            orc_id,
            status=self._status_of(done),
            output={"content": _last or "\n\n".join(parts)},
            runs=done,
        )

    async def _dag(self, orc_id: str, spec: dict[str, Any]) -> None:
        """画布模式：按拓扑**分层**跑，层内并发；**每条连线带自己的关系**。

        与 serial 的区别（也是它存在的理由）：serial 假定"上一步"只有一个，
        而画布允许分叉再汇合 —— 一个节点的输入是它所有上游按**各自关系**交来的东西。

        连线有**两个维度**（正交，可任意组合 —— 原来做成"四选一"是建模错误）：
          时序：serial 等它跑完交结论 | parallel 同时开始、不构成依赖
          共享：share_context 产出进同一个上下文池，组内谁先跑完都互相看得见
                share_memory  产出沉淀成记忆，而且**双方**都能想起来

        某一路失败**不中断**：其它分支照跑，失败的进 partial —— 与 serial 的取舍一致
        （拿到大部分结果，比一个错误提示有用）。
        """
        from .graph import back_edges, is_dependency, shares_context, shares_memory, topo_layers

        task = self._task(spec)
        nodes: list[dict[str, Any]] = list(spec.get("nodes") or [])
        edges: list[dict[str, Any]] = list(spec.get("edges") or [])
        if not nodes:
            await self._finish(orc_id, "error", error="这份编排里一个助手都没有")
            return

        by_nid = {n["nid"]: n for n in nodes}
        outputs: dict[str, str] = {}   # 每个节点跑出来的结论
        inputs: dict[str, str] = {}    # 每个节点当时**领到**的任务（context 关系要用它）
        run_of: dict[str, Run] = {}
        done: list[Run] = []
        order = 0

        for layer in topo_layers(nodes, edges):
            async def run_one(nid: str, idx: int) -> Run:
                chunks: list[str] = []
                # ① 上游依赖（串行线）：把结论交过来
                for e in [x for x in edges if x["to"] == nid and is_dependency(x)]:
                    text = outputs.get(e["from"], "")
                    if not text:
                        continue
                    if shares_context(e):
                        # 上下文共享：连它当时领到什么都一起交过去 ——
                        # 下游拿到的是一段"经过"，而不是一句结论
                        src_in = inputs.get(e["from"], "")
                        chunks.append(
                            f"【{self._agent_name_of(run_of[e['from']])} 的上下文】\n"
                            f"它领到的任务：{src_in}\n它的产出：{text}"
                        )
                    else:
                        chunks.append(text)
                # ② 共享伙伴（串行并行都算）：谁已经跑完了，就把它的上下文带上 ——
                #    并行伙伴通常还没跑完，池子里就没有它，这符合"同时开始"；
                #    而这一组**下游**的节点因此能同时看到组内所有人的产出。
                partners = [
                    x["from"] if x["to"] == nid else x["to"]
                    for x in edges
                    if shares_context(x) and nid in (x["from"], x["to"])
                ]
                for pid in dict.fromkeys(partners):
                    if pid == nid or pid not in outputs:
                        continue
                    if any(x["to"] == nid and x["from"] == pid and is_dependency(x) for x in edges):
                        continue  # ① 已经交过了，别重复
                    chunks.append(
                        f"【共享上下文 · {self._agent_name_of(run_of[pid])}】\n"
                        f"它领到的任务：{inputs.get(pid, '')}\n它的产出：{outputs[pid]}"
                    )
                prev = "\n\n".join(chunks) or None
                payload = self._compose(task, prev, idx)
                inputs[nid] = payload
                node = by_nid[nid]
                run = await self._start_step(orc_id, node["agent_id"], "worker", idx, payload, node_id=node.get("nid") or nid, fanout=_fanout_of(node))
                # 这一跳最多等多久：用节点上设的（画布上给"等上游"的那个节点设）——
                # 用户："Orchestrator 需要等待其他 agent 执行完再验证总结，但需要设置超时时间"
                return await self._await(run.id, node.get("wait_timeout_s"))

            results = await asyncio.gather(
                *(run_one(nid, order + i) for i, nid in enumerate(layer)),
                return_exceptions=True,
            )
            for nid, res in zip(layer, results):
                if isinstance(res, BaseException):
                    logger.warning("DAG 分支 %s 异常: %s", nid, res)
                    continue
                done.append(res)
                run_of[nid] = res
                if res.status == "ok" and (t := self._text(res)):
                    outputs[nid] = t
                    # 「共享记忆」：产出沉淀成记忆，并且**双方都能想起来** ——
                    # 只给下游存一条那叫"传递"，不叫共享。
                    for e in edges:
                        if not shares_memory(e) or nid not in (e["from"], e["to"]):
                            continue
                        for other in (e["from"], e["to"]):
                            if other == nid or other not in by_nid:
                                continue
                            await self._deposit_memory(res, by_nid[other]["agent_id"], t)
            order += len(layer)

        # ── 收口：把结果交回**最初的编排者**再跑一次 ────────────────────────
        # 用户："应该是把结果返回给最初的 Orchestrator 验证总结，而不是新的 Orchestrator"。
        # 画布上画成 编排者 → 各 worker → 回到同一个编排者（一个环）；分层时回边已被忽略，
        # 所以编排者**已经先跑过一次**（分析任务 + 分派），这里让它拿着**所有 worker 的产出**
        # 再跑一次收口（验证结果 + 归纳总结）——这一次的产出就是整个编排的最终结果 ✓
        _last: str | None = None
        _backs = back_edges(nodes, edges)
        if _backs:
            _by_target: dict[str, list[str]] = {}
            for e in _backs:
                _by_target.setdefault(e["to"], []).append(e["from"])
            for _t, _srcs in _by_target.items():
                if _t not in by_nid:
                    continue
                _chunks = [
                    f"【{self._agent_name_of(run_of[s])}】\n{outputs[s]}"
                    for s in _srcs
                    if s in outputs and s in run_of
                ]
                _payload = (
                    f"{task}\n\n---\n"
                    f"以下是这条流程里各位助手的产出（请按你的职责验证并归纳总结）：\n"
                    + ("\n\n".join(_chunks) or "（各位助手都没有产出）")
                )
                _node = by_nid[_t]
                _run = await self._start_step(orc_id, _node["agent_id"], "worker", order, _payload, node_id=_node.get("nid") or _t, fanout=_fanout_of(_node))
                _done = await self._await(_run.id, _node.get("wait_timeout_s"))
                done.append(_done)
                run_of[_t] = _done
                if _done.status == "ok" and (t2 := self._text(_done)):
                    outputs[_t] = t2
                    _last = t2
            order += 1

        # 最终结果 = **汇点**（没有下游的那些）的产出，按助手名分段
        # 汇点也要**排除回边** —— 编排者在图上还有出边（指向 worker），
        # 不排除它就被当成"中间节点"，收口那次的结论反而进不了最终产出 ✗（实测过）
        outs = {
            e["from"]
            for e in edges
            if is_dependency(e) and (e["from"], e["to"]) not in {(b["from"], b["to"]) for b in _backs}
        }
        sinks = [n for n in nodes if n["nid"] not in outs]
        parts = [
            f"【{self._agent_name_of(run_of[n['nid']])}】\n{outputs[n['nid']]}"
            for n in sinks
            if outputs.get(n["nid"]) and n["nid"] in run_of
        ]
        await self._finish(
            orc_id,
            status=self._status_of(done),
            output={"content": "\n\n".join(parts)},
            runs=done,
        )

    async def _deposit_memory(self, run: Run, to_agent_id: str, content: str) -> None:
        """把一条产出沉淀成**下游助手**的记忆。

        绑下游而不是上游：这条关系的用途是"让下一个能想起来"，
        所以记忆要挂在**将来要召回它的那个助手**名下。
        """
        from ..models import Memory

        text = (content or "").strip()
        if not text:
            return
        ts = now_ms()
        async with SessionLocal() as session:
            session.add(
                Memory(
                    agent_id=to_agent_id,
                    scope="agent",
                    kind="summary",
                    content=text[:4000],
                    source="auto",
                    source_run_id=run.id,
                    # 自动产生的先进候选态，用户确认后才生效 —— 与自动沉淀同一套闸门
                    status="candidate",
                    importance=0.5,
                    created_at=ts,
                    updated_at=ts,
                )
            )
            await session.commit()

    async def _master_worker(self, orc_id: str, spec: dict[str, Any]) -> None:
        """主从：主控拆任务 → 干活的做 → **主控汇总出最终结果**。

        拆解失败会**降级为「每个 worker 都拿原任务」**而不是直接报错 ——
        对用户来说，拿到一份"各干各的"的结果，也远比一个错误提示有用。
        """
        task = self._task(spec)
        master_id = spec.get("master_agent_id")
        steps = self._steps(spec)
        worker_mode = spec.get("worker_mode") or "parallel"
        n = len(steps)

        if not master_id:
            raise OrchestratorError("主从模式必须指定一个主控助手")
        if n == 0:
            raise OrchestratorError("主从模式至少需要一位干活的助手")

        done: list[Run] = []

        # ── 第一步：主控拆任务 ────────────────────────────────────────
        plan_payload = _PLAN_PROMPT.format(task=task, n=n)
        plan_run = await self._start_step(orc_id, master_id, "master", 0, plan_payload, node_id=spec.get("master_nid"))
        plan_done = await self._await(plan_run.id, spec.get("master_wait_timeout_s"))
        done.append(plan_done)

        subtasks = self._parse_plan(self._text(plan_done), n)
        if subtasks is None:
            logger.info("编排 %s：主控没给出可解析的任务清单，降级为各拿原任务", orc_id)
            subtasks = [task] * n
        # 数量对不上时（模型有时多给或少给）按位补齐/截断
        subtasks = (subtasks + [task] * n)[:n]

        # ── 第二步：干活的做 ──────────────────────────────────────────
        worker_runs: list[Run] = []
        if worker_mode == "serial":
            prev: str | None = None
            for i, step in enumerate(steps):
                payload = self._compose_worker(subtasks[i], prev, i)
                r = await self._start_step(orc_id, step["agent_id"], "worker", i + 1, payload, node_id=step.get("nid"), fanout=_fanout_of(step))
                d = await self._await(r.id, step.get("wait_timeout_s"))
                worker_runs.append(d)
                if d.status == "ok" and (t := self._text(d)):
                    prev = t
        else:
            runs = [
                await self._start_step(
                    orc_id, step["agent_id"], "worker", i + 1, subtasks[i], node_id=step.get("nid"), fanout=_fanout_of(step)
                )
                for i, step in enumerate(steps)
            ]
            results = await asyncio.gather(
                *(self._await(r.id, step.get("wait_timeout_s")) for r, step in zip(runs, steps)),
                return_exceptions=True,
            )
            for r, res in zip(runs, results):
                if isinstance(res, BaseException):
                    logger.warning("主从分支 %s 异常: %s", r.id, res)
                    continue
                worker_runs.append(res)

        done.extend(worker_runs)

        # ── 第三步：主控汇总（这一步的产出就是整个编排的最终结果）─────
        parts = "\n\n".join(
            f"【{self._agent_name_of(r)}】\n{self._text(r) or '（无产出）'}"
            for r in worker_runs
        )
        summary_payload = _SUMMARY_PROMPT.format(task=task, parts=parts or "（各位助手都没有产出）")
        sum_run = await self._start_step(
            orc_id, master_id, "master", n + 1, summary_payload, node_id=spec.get("master_nid")
        )
        sum_done = await self._await(sum_run.id, spec.get("master_wait_timeout_s"))
        done.append(sum_done)

        await self._finish(
            orc_id,
            status=self._status_of(done),
            output={"content": self._text(sum_done)},
            runs=done,
        )

    # ------------------------------------------------------------------ #
    # 步骤：建 Run + 启动（复用运行时的全套能力）
    # ------------------------------------------------------------------ #
    async def _start_step(
        self,
        orc_id: str,
        agent_id: str,
        role: str,
        order: int,
        payload: str,
        node_id: str | None = None,
        fanout: dict[str, Any] | None = None,
    ) -> Run:
        """建一条 run 记录并启动它。

        刻意**不**经过 ``POST /api/runs`` 那层 HTTP —— 直接走库 + run_service，
        少一次自打自的请求。但 Agent 定义解析、快照冻结、启动方式与那边一致。
        """
        from ..runner import run_service

        async with SessionLocal() as session:
            agent = await session.get(Agent, agent_id)
            if agent is None:
                raise OrchestratorError(f"助手不存在: {agent_id}")

            definition = AgentDefinition.model_validate(agent.definition)
            # 编排者：把四项职责（分析任务/管理上下文/验证结果/归纳总结）作为交代注入。
            # 放在 system_prompt 最前面 —— 它是"身份"，不是"任务补充"。
            if definition.role == "orchestrator":
                # 用这份助手自己的职责定义（在 Agents 页可改）；没写就用平台内置那份
                brief = (definition.orchestrator_brief or "").strip() or ORCHESTRATOR_BRIEF
                definition.system_prompt = f"{brief}\n\n---\n\n{definition.system_prompt}"
            # ⚠️ **分派容器不能建成 `pending`**：分发器有一路是"扫库里所有 pending 的执行"
            # （重启续跑走那条），于是容器会被当成一条待跑执行**被真跑一遍**，
            # 把"合并产出"覆盖成模型的回答（间歇性，取决于哪次 tick 撞上）。
            # 容器的语义是"正在分派/等结果"，所以直接建成 running。
            _as_fanout = bool(fanout) and str((fanout or {}).get("mode") or "").strip() == "list"
            # 这一步会不会"等子执行"：容器（按清单分派）或模型可能自己调分派工具（配了派给谁）
            _can_dispatch = _as_fanout or bool((fanout or {}).get("agent"))
            run = Run(
                agent_id=agent.id,
                agent_version=agent.version,
                runtime=definition.runtime,
                status="running" if _as_fanout else "pending",
                # 节点上配的「派给谁」随 input 一起带着 —— 模型调「分派」工具时若没指定
                # agent，就以它作为默认（人定死的默认不该被模型的记性决定）
                input={
                    "text": payload,
                    **({"fanout_agent": fanout.get("agent")} if (fanout or {}).get("agent") else {}),
                    # 这一步要「派出去并等结果」→ 顺带把「最多等多久」带上：
                    # 执行层据此把等待时间算进执行超时（不然节点上那句「最长等多久」是假的）
                    **(
                        {"fanout_wait_s": (fanout or {}).get("wait_s")}
                        if _can_dispatch and (fanout or {}).get("wait_s") is not None
                        else {}
                    ),
                },
                # 冻结定义快照：与 /api/runs 一致，保证这次执行可复现
                definition_snapshot=definition.model_dump(
                    mode="json", exclude={"model": {"api_key"}}
                ),
                started_at=now_ms(),
                orchestration_id=orc_id,
                orch_role=role,
                order_index=order,
                # 画布节点 id（界面按它精确匹配；无则回退到旧启发式）
                node_id=node_id,
                # 谁发起的这次执行：画布点运行 = playground；定时 = schedule；
                # 外部调用 = webhook（运行记录据此标出"它自己跑的"）
                origin=_RUN_ORIGIN.get(),
            )
            session.add(run)
            await session.commit()
            await session.refresh(run)

        # ── 这一步配了「分派」：把上游清单每项交给这个助手的**一个实例**并行处理 ──
        # 这里**不执行这个助手本身**，而是拿这条 run 当"分派容器"：
        #   解析清单 → 建 N 条子执行（挂在同一个节点下）→ 等齐 → 把 N 份产出合并成
        #   这一步的产出交下游（下游如果是编排者，就是它来验证总结 ✓ 与既定语义一致）。
        if fanout and str(fanout.get("mode") or "").strip() == "list":
            await self._run_fanout(run, fanout, payload)
            return run

        # 常规路径：启动这一跳（分派那条路自己会起 N 个子执行，不走这里）
        await run_service.start(run.id, definition, payload)
        return run

    async def _run_fanout(self, run: Run, fanout: dict[str, Any], payload: str) -> None:
        """把这一步按「上游清单」分派出去；解析不出清单就如实退化成单实例。"""
        from ..fanout import dispatch, parse_items

        items = parse_items(payload)
        if not items:
            # 退化成普通单实例：不清空、不报错，跑就对了；但要留下原因
            logger.info("编排 %s：节点 %s 配了分派，但上游不是清单 → 按单实例执行", run.orchestration_id, run.node_id)
            from ..runner import run_service
            from ..schemas import AgentDefinition

            definition = AgentDefinition.model_validate(run.definition_snapshot or {})
            await run_service.start(run.id, definition, payload)
            return

        # 派给**别的助手**时，子实例要跑的是那个助手 → 定义快照也得换成它的。
        # （原来这里固定用本节点的快照 = 拿错提示词/模型/工具；"派给谁"这个能力会因此失真）
        target_id = str(fanout.get("agent") or run.agent_id)
        child_snapshot = dict(run.definition_snapshot or {})
        if target_id != run.agent_id:
            async with SessionLocal() as _s:
                from ..models import Agent as _Agent

                _t = await _s.get(_Agent, target_id)
                if _t is not None:
                    child_snapshot = dict(_t.definition or {})
                else:
                    logger.warning("分派目标助手不存在：%s → 退回本节点的助手", target_id)
                    target_id = run.agent_id
        child_snapshot["tools"] = [
            t for t in (child_snapshot.get("tools") or []) if _not_fork_tool(t)
        ]

        async with SessionLocal() as session:
            fresh = await session.get(Run, run.id)
            if fresh is None:  # pragma: no cover
                return
            result = await dispatch(
                parent_run=fresh,
                agent_id=target_id,
                definition_snapshot=child_snapshot,
                isolate_workspace=str(fanout.get("workspace") or "").strip() == "isolate",
                items=items,
                max_items=fanout.get("max"),
                wait_s=fanout.get("wait_s"),
                budget_tokens=fanout.get("budget"),
            )
            # 合并产出：把 N 份产出按项拼成可读清单交下游（下游多是编排者，由它验证总结）
            merged = "\n\n".join(
                f"## {it['label']}\n{it['summary']}" for it in result.get("items") or []
            )
            # 有路在等人工确认 → 这一步标「等你确认」（画布/记录上直接看得见要人做什么），
            # 而不是假装跑完了，也不是硬等到超时。确认完再重跑这一步即可收拢（幂等）。
            if result.get("waiting"):
                fresh.status = "waiting_hitl"
            else:
                fresh.status = "ok" if result.get("succeeded") else "error"
            fresh.output = {"content": merged}
            fresh.usage = {
                **(fresh.usage or {}),
                "fanout": {
                    "total": result.get("total"),
                    "succeeded": result.get("succeeded"),
                    "failed": [x.get("index") for x in (result.get("failed") or [])],
                    "truncated": result.get("truncated"),
                    "timed_out": result.get("timed_out"),
                    "waiting": [x.get("index") for x in (result.get("waiting") or [])],
                    # 各路合计（展示用）：花在哪一路、这一步一共烧了多少，一眼看得见
                    "tokens_in": (result.get("usage") or {}).get("tokens_in"),
                    "tokens_out": (result.get("usage") or {}).get("tokens_out"),
                    "llm_calls": (result.get("usage") or {}).get("llm_calls"),
                },
            }
            fresh.ended_at = now_ms()
            if not result.get("succeeded") and not result.get("waiting"):
                fresh.error = "分派出来的每一路都失败了"
            elif result.get("waiting"):
                who = "、".join(f"第 {x['index'] + 1} 项" for x in result["waiting"])
                fresh.error = f"{who} 在等你确认（去「管理」确认后那一路会自己跑完）"
            await session.commit()

    async def _await(self, run_id: str, wait_s: int | None = None) -> Run:
        """等这一步跑完 —— ``wait_s`` = **这一跳的等待上限**（None=平台默认，-1=一直等）。

        用户："Orchestrator 需要等待其他 agent 执行完再验证总结，但需要设置超时时间"。
        """
        """等一个子 Run 结束（超时即当失败，不拖住整个编排）。"""
        from ..runner import run_service

        # -1 = 不限：给一个足够大的上限（别让一次编排永久挂住）
        t = STEP_TIMEOUT_S if wait_s is None else (365 * 24 * 3600 if wait_s < 0 else wait_s)
        try:
            return await run_service.wait(run_id, timeout=t)
        except TimeoutError:
            logger.warning("子 Run %s 等待超时", run_id)
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                if run is not None:
                    run.status = "error"
                    run.error = f"等待超时（>{t}s）"
                    await session.commit()
                    return run
            raise

    # ------------------------------------------------------------------ #
    # 输入拼装
    # ------------------------------------------------------------------ #
    def _compose(self, task: str, prev_text: str | None, index: int) -> str:
        """串行模式下给某一步拼输入。

        用户在编排界面上逐个勾选"是否带上一步结果"，所以这里只在
        ``carry_prev`` 为真时拼接；拼接时明确标注来源，模型才不会误当成
        自己的任务。
        """
        if index == 0 or not prev_text:
            return task
        return (
            f"{task}\n\n"
            f"---\n"
            f"上一步的产出（供你参考，不必照抄）：\n{prev_text}\n"
            f"---\n"
            f"现在请完成你这一步。"
        )

    def _compose_worker(self, subtask: str, prev_text: str | None, index: int) -> str:
        """主从模式（worker 串行）下给某一个 worker 拼输入。"""
        if index == 0 or not prev_text:
            return subtask
        return (
            f"{subtask}\n\n"
            f"---\n"
            f"上一位助手已经完成的部分（供参考）：\n{prev_text}\n"
            f"---\n"
            f"请完成你负责的部分。"
        )

    # ------------------------------------------------------------------ #
    # 主控的任务清单解析
    # ------------------------------------------------------------------ #
    @staticmethod
    def _parse_plan(text: str, expected: int) -> list[str] | None:
        """从主控的输出里抠出子任务清单。

        模型很爱加 ```json 围栏或前后废话，所以先剥围栏、再找第一个 JSON 数组。
        实在解析不出来返回 None（调用方降级处理）。
        """
        if not text:
            return None
        cleaned = text.strip()
        # 剥掉 markdown 代码围栏
        fence = re.search(r"```(?:json)?\s*(.+?)```", cleaned, re.S)
        if fence:
            cleaned = fence.group(1).strip()
        # 找第一个 [...] 数组
        start, end = cleaned.find("["), cleaned.rfind("]")
        if start >= 0 and end > start:
            candidate = cleaned[start : end + 1]
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, list) and parsed:
                    return [str(x).strip() for x in parsed if str(x).strip()]
            except json.JSONDecodeError:
                pass
        # 退一步：按行/编号切分（"1. xxx" / "- xxx"）
        lines = [
            re.sub(r"^\s*(?:[-*•]|\d+[.、)])\s*", "", ln).strip()
            for ln in cleaned.splitlines()
        ]
        picked = [ln for ln in lines if len(ln) > 4]
        if picked:
            return picked[:expected] if len(picked) >= expected else None
        return None

    # ------------------------------------------------------------------ #
    # 收尾与状态
    # ------------------------------------------------------------------ #
    @staticmethod
    def _status_of(runs: list[Run]) -> str:
        """由各子步骤的状态推出整次编排的状态。"""
        if not runs:
            return "error"
        oks = sum(1 for r in runs if r.status == "ok")
        if oks == len(runs):
            return "ok"
        if oks == 0:
            return "error"
        return "partial"

    async def _finish(
        self,
        orc_id: str,
        status: str,
        *,
        output: dict[str, Any] | None = None,
        error: str | None = None,
        runs: list[Run] | None = None,
    ) -> None:
        """落终态：状态、最终结果、错误、汇总用量。"""
        usage = self._merge_usage(runs or [])
        async with SessionLocal() as session:
            orc = await session.get(Orchestration, orc_id)
            if orc is None:  # pragma: no cover
                return
            orc.status = status
            if output is not None:
                orc.output = output
            if error:
                orc.error = error
            orc.usage = usage
            orc.ended_at = now_ms()
            await session.commit()

    async def _patch(self, orc_id: str, **fields: Any) -> None:
        async with SessionLocal() as session:
            orc = await session.get(Orchestration, orc_id)
            if orc is None:  # pragma: no cover
                return
            for k, v in fields.items():
                setattr(orc, k, v)
            await session.commit()

    @staticmethod
    def _merge_usage(runs: list[Run]) -> dict[str, Any]:
        """把各子 Run 的用量加起来（用户最关心"这一趟花了多少"）。"""
        total: dict[str, Any] = {
            "llm_calls": 0,
            "tool_calls": 0,
            "tokens_in": 0,
            "tokens_out": 0,
            "llm_ms": 0,
            "tool_ms": 0,
            "steps": len(runs),
        }
        for r in runs:
            u = r.usage or {}
            for k in ("llm_calls", "tool_calls", "tokens_in", "tokens_out", "llm_ms", "tool_ms"):
                v = u.get(k)
                if isinstance(v, (int, float)):
                    total[k] += int(v)
        return total

    # ------------------------------------------------------------------ #
    # 小工具
    # ------------------------------------------------------------------ #
    @staticmethod
    def _task(spec: dict[str, Any]) -> str:
        return str(spec.get("task") or "").strip()

    @staticmethod
    def _steps(spec: dict[str, Any]) -> list[dict[str, Any]]:
        steps = spec.get("steps") or []
        if not isinstance(steps, list) or not steps:
            raise OrchestratorError("编排至少要有一个助手")
        if len(steps) > MAX_STEPS:
            raise OrchestratorError(f"一次编排最多 {MAX_STEPS} 个助手")
        return steps

    @staticmethod
    def _text(run: Run | None) -> str:
        """取一次执行的最终文本。"""
        if run is None or not run.output:
            return ""
        out = run.output
        if isinstance(out, dict):
            return str(out.get("content") or "").strip()
        return str(out).strip()

    @staticmethod
    def _agent_name_of(run: Run) -> str:
        snap = run.definition_snapshot or {}
        return str(snap.get("name") or run.agent_id)


#: 全局单例
orchestrator = Orchestrator()
