"""开局就把"能干活的两个角色"备好 —— 幂等、不覆盖用户改过的东西。

为什么要有它（用户原话）
----------------------
「一个任务分几路跑，应该由一个编排 agent 开始，所以在应用最开始应该默认初始化一个
  编排 agent 和通用 agent（干活的 agent）」

翻译成平台行为：新装的平台不该是空的、逼用户先想清楚"助手该怎么配"，而应该**打开就有
两个能用的助手**：
  · **编排者**（role=orchestrator）：分析任务 → 拆分 → 派下去 → 收齐结果做验证与总结。
    它同时挂着**分派**工具 —— 没有它，"一个任务分几路跑"这件事就没有起点。
  · **通用助手**（role=worker）：真正干活的那一个。被编排者分派出去的就是它（可多路并行）。

设计原则
--------
* **幂等**：按名字找，已存在就一个字都不动（用户可能改过提示词/模型/工具）。
* **只补缺**：缺哪个补哪个；另外只多做一件事 —— 编排者没挂「分派」工具就挂上，
  否则"由一个编排 agent 开始分几路"落不了地。
* **一建就能跑**：模型/凭据优先沿用平台里已有助手的配置（同一个 provider + 凭据引用）；
  平台里一个助手都没有（全新库）才留空，让用户去「LLM 配置」里选一次。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from .models import Agent, AgentTool, Tool, now_ms

logger = logging.getLogger(__name__)

#: 默认助手的名字 —— 用户能在 Agents 页改名，改名后这里不再干扰（按名字判存在）
ORCHESTRATOR_NAME = "编排者"
WORKER_NAME = "通用助手"

ORCHESTRATOR_PROMPT = """你是一条流程的**起点**，负责把用户的目标变成"能被干掉的活"：

1. 看清目标：这一步要产出什么、下游需要什么、判断标准是什么（目标含糊就先收敛成一条可执行的）。
2. 决定怎么跑：
   - 一次能干完的，直接交给人做，不要硬拆；
   - 是**一批同类子任务**（多份文档/多条线索/多个查询），用「分派」工具把它一次派出去并行处理；
     派活时**指定交给「通用助手」**（fork 工具的 agent 参数填「通用助手」）—— 你负责开局与收口，
     具体的活由它去干。
3. 收齐结果后**验证并总结**：哪些成了、哪些没成、结论是什么、下一步建议。
   不要只复述各项结果，要给出你自己的判断。
"""

WORKER_PROMPT = """你负责把交给你的**这一件事**做扎实、做完。

- 只处理交给你的内容，不要替别的项做决定、也不要替上游做总结（结果由编排者汇总）。
- **先判断能不能直接做完**：能就直接给结论、直接把产物做出来。
  不要为了"稳妥"去翻代码库、到处搜一遍 —— 分派给你的是**一项活**，
  无关的探索只是白花钱（实测：一句话的活翻出 18 轮工具调用，答案还跑偏了）。
- 只有**这一项本身需要动手**时才用工具：读写指定的文件、跑给定的命令、
  或需要查证你不可能知道的外部事实。
- 需要产出文件时**直接写到工作目录里**（文件名按分派要求），别只写在回复里。
- 产出要**可直接被下游使用**：结论在前，依据在后，不要写客套话。
"""

#: 编排者默认挂的工具（分派是核心，其余是"干活前先看一眼"的只读工具）
ORCHESTRATOR_TOOLS = ("fork", "read", "glob", "grep")
#: 通用助手默认挂的工具（干活的那套）。
#: **刻意不含 bash**：平台的权限引擎对"跑命令"一律要求人工点头（`accept_edits` 只自动放行
#: **工作目录内**的读写），默认挂上它 = 无人值守的第一步就卡在等确认。
#: 需要跑命令时自己在 Agents 页加上 —— 那时按平台规矩确认即可。
WORKER_TOOLS = ("read", "write", "edit", "glob", "grep")


async def ensure_default_agents(session: Any) -> dict[str, Any]:
    """确保「编排者」「通用助手」存在。返回 {created: [...], attached_fork: bool}。"""
    existing = {
        a.name: a for a in (await session.execute(select(Agent))).scalars()
    }
    tools = {t.name: t.id for t in (await session.execute(select(Tool))).scalars()}

    # ① 模型模板：沿用平台里**已有助手**的配置（同一个 provider + 凭据引用 → 一建就能跑）
    template_model: dict[str, Any] | None = None
    for a in (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars():
        m = (a.definition or {}).get("model") or {}
        if m.get("provider") and m.get("credential_ref"):
            template_model = {
                k: m[k] for k in ("provider", "name", "credential_ref", "base_url") if m.get(k)
            }
            break

    created: list[str] = []
    specs = [
        (
            ORCHESTRATOR_NAME,
            "orchestrator",
            ORCHESTRATOR_PROMPT,
            ORCHESTRATOR_TOOLS,
        ),
        (WORKER_NAME, "worker", WORKER_PROMPT, WORKER_TOOLS),
    ]
    for name, role, prompt, tool_names in specs:
        if name in existing:
            continue
        refs = [
            {"ref": tools[n], "name": n, "enabled": True}
            for n in tool_names
            if n in tools  # 工具没同步进来就跳过（不因为缺一个工具就不建助手）
        ]
        definition: dict[str, Any] = {
            "runtime": "agentscope",
            "name": name,
            "role": role,
            "system_prompt": prompt,
            "model": template_model or {"provider": "volcengine", "name": "deepseek-v4-flash"},
            "tools": refs,
            "skills": [],
            "limits": {"max_iters": 12, "timeout_s": 300},
        }
        from .api.agents import slugify

        row = Agent(
            slug=slugify(name) or f"default-{role}",
            name=name,
            version=1,
            definition=definition,
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(row)
        await session.flush()
        for ref in refs:
            session.add(AgentTool(agent_id=row.id, tool_id=ref["ref"]))
        created.append(name)
        existing[name] = row
        logger.info("默认助手已建：%s（%s）", name, role)

    # ② 编排者必须能"派" —— 没有分派工具就补上（只补这一个，不动别的）
    attached_fork = False
    orch = existing.get(ORCHESTRATOR_NAME)
    fork_id = tools.get("fork")
    if orch is not None and fork_id:
        has = (
            await session.execute(
                select(AgentTool).where(
                    AgentTool.agent_id == orch.id, AgentTool.tool_id == fork_id
                )
            )
        ).scalar_one_or_none()
        if has is None:
            session.add(AgentTool(agent_id=orch.id, tool_id=fork_id))
            attached_fork = True
            logger.info("已给「%s」挂上分派工具（一个任务分几路跑要有起点）", ORCHESTRATOR_NAME)

    await session.commit()
    return {"created": created, "attached_fork": attached_fork}
