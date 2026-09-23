"""编排图的两个共用算法：**执行方式推导** 与 **拓扑分层**。

为什么单独一个模块
------------------
界面上显示的「执行方式」和真正跑起来的顺序，必须是**同一套判据**推出来的。
如果各写各的，迟早出现「界面写着串行、实际按并行跑」——用户看到的与实际不符，
是产品里最伤信任的那类 bug。所以两者都从这里取。
"""

from __future__ import annotations

from typing import Any

Graph = dict[str, Any]

#: 连线上能选的关系 —— 这是**两个助手之间**的语义，不是全局设置
#:
#: serial   串行接力：等上游跑完，把结论交给下游（默认，也是老行为）
#: parallel 并行：两个同时开始、互不等待 —— 这条线不构成依赖
#: context  上下文共享：不只给结论，把上游"看到的 + 说过的"一起交给下游
#: memory   记忆：上游产出沉淀成下游的一条记忆（同时照常传递结论）
REL_SERIAL = "serial"
REL_PARALLEL = "parallel"
REL_CONTEXT = "context"
REL_MEMORY = "memory"
RELS = (REL_SERIAL, REL_PARALLEL, REL_CONTEXT, REL_MEMORY)

REL_LABEL_CN: dict[str, str] = {
    REL_SERIAL: "串行接力",
    REL_PARALLEL: "并行",
    REL_CONTEXT: "上下文共享",
    REL_MEMORY: "记忆",
}
REL_HINT_CN: dict[str, str] = {
    REL_SERIAL: "等它跑完，把结论交给下一个",
    REL_PARALLEL: "两个同时开始，互不等待",
    REL_CONTEXT: "把它看到的和说过的，一起交给下一个",
    REL_MEMORY: "产出存成下游的记忆，以后能想起来",
}


# ── 连线的**两个维度** ────────────────────────────────────────────────────────
#
# 原来我把它做成"四选一"（串行/并行/上下文/记忆），这是**建模错误**：
#   顺序 与 共享 是两件独立的事 —— 并行的时候一样可以共享记忆或上下文，串行也可以。
# 所以拆成两条正交的轴：
#
#   ① 时序（二选一）：serial 等它跑完 | parallel 同时开始
#   ② 共享（可任意组合）：share_context 共享上下文 | share_memory 共享记忆
#
# 下面这些函数是**唯一入口**：界面上怎么判断、执行时怎么跑，都从这里取。
# 同时兼容旧的 rel 单一枚举（老图不用迁移）。

ORDER_SERIAL = "serial"
ORDER_PARALLEL = "parallel"


def edge_order(e: dict[str, Any]) -> str:
    """时序：默认串行。旧数据里 rel=parallel 等价于 order=parallel。"""
    if e.get("order") == ORDER_PARALLEL:
        return ORDER_PARALLEL
    if e.get("rel") == REL_PARALLEL:
        return ORDER_PARALLEL
    return ORDER_SERIAL


def shares_context(e: dict[str, Any]) -> bool:
    """这条线要不要进"上下文池"（旧数据 rel=context 等价）。"""
    return bool(e.get("share_context")) or e.get("rel") == REL_CONTEXT


def shares_memory(e: dict[str, Any]) -> bool:
    """这条线要不要把产出沉淀成记忆、双方共享（旧数据 rel=memory 等价）。"""
    return bool(e.get("share_memory")) or e.get("rel") == REL_MEMORY


def is_dependency(e: dict[str, Any]) -> bool:
    """这条线算不算"依赖" —— 只有依赖才决定先后。

    **并行线不算**：它表达的是"这两个同时跑"，不是"后一个等前一个"。
    """
    return edge_order(e) != ORDER_PARALLEL


def dep_edges(edges: list[dict[str, str]]) -> list[dict[str, str]]:
    return [e for e in edges if is_dependency(e)]


def normalise(graph: Graph | None) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """把图清洗成统一形状。

    丢掉：指向不存在节点的连线、自连、重复连线、缺字段的节点。
    宁可在入口处安静地丢掉，也不要让脏数据进到执行层才炸。
    """
    raw_nodes = list((graph or {}).get("nodes") or [])
    raw_edges = list((graph or {}).get("edges") or [])

    nodes: list[dict[str, str]] = []
    seen: set[str] = set()
    for n in raw_nodes:
        nid = str((n or {}).get("nid") or "").strip()
        aid = str((n or {}).get("agent_id") or "").strip()
        if not nid or not aid or nid in seen:
            continue
        seen.add(nid)
        nodes.append({"nid": nid, "agent_id": aid})

    ids = {n["nid"] for n in nodes}
    edges: list[dict[str, Any]] = []
    eseen: set[tuple[str, str]] = set()
    for e in raw_edges:
        a = str((e or {}).get("from") or "").strip()
        b = str((e or {}).get("to") or "").strip()
        if a not in ids or b not in ids or a == b or (a, b) in eseen:
            continue
        eseen.add((a, b))
        # 统一归一到**两维**形状；旧的 rel 单枚举在这里被翻译掉，老图不用迁移
        edges.append(
            {
                "from": a,
                "to": b,
                "order": edge_order(e),
                "share_context": shares_context(e),
                "share_memory": shares_memory(e),
            }
        )

    return nodes, edges


def topo_layers(nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> list[list[str]]:
    """按**最长路径**分层：第 N 层 = 必须等第 N-1 层都跑完的那些节点。

    用最长路径而不是最短：A→B 和 A→C→B 同时存在时，B 必须等 C 也跑完，
    否则它拿不到完整的输入。层内节点彼此无依赖，可以并发。
    """
    layer = {n["nid"]: 0 for n in nodes}
    deps = dep_edges(edges)  # 并行线不参与排序，否则"并行"会被排成"等它"
    for _ in range(len(nodes) + 2):  # 有环时收敛不了，用次数兜底
        changed = False
        for e in deps:
            cand = layer.get(e["from"], 0) + 1
            if layer.get(e["to"], 0) < cand:
                layer[e["to"]] = cand
                changed = True
        if not changed:
            break
    buckets: dict[int, list[str]] = {}
    for nid, lv in layer.items():
        buckets.setdefault(lv, []).append(nid)
    return [buckets[k] for k in sorted(buckets)]


def detect_master(nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> str | None:
    """主从里的「主」：**扇出**的那个源头（它把任务拆给多个）。

    这是自动判断；用户可以在节点上覆盖（``graph["master_nid"]``）。
    """
    if not nodes:
        return None
    outdeg = {n["nid"]: 0 for n in nodes}
    indeg = {n["nid"]: 0 for n in nodes}
    for e in dep_edges(edges):
        outdeg[e["from"]] += 1
        indeg[e["to"]] += 1
    fan = [n["nid"] for n in nodes if outdeg[n["nid"]] > 1]
    if fan:
        for n in nodes:  # 有多个扇出点时，取最上游的那个
            if indeg[n["nid"]] == 0 and n["nid"] in fan:
                return n["nid"]
        return fan[0]
    # 没有明显扇出：取唯一的源头（主从退化成"一个主 + 若干从"）
    roots = [n["nid"] for n in nodes if indeg[n["nid"]] == 0]
    return roots[0] if roots else nodes[0]["nid"]


def master_of(graph: Graph | None) -> str | None:
    """主控节点 id：用户覆盖优先，否则自动判断。"""
    nodes, edges = normalise(graph)
    override = str((graph or {}).get("master_nid") or "").strip()
    if override and any(n["nid"] == override for n in nodes):
        return override
    return detect_master(nodes, edges)


def derive_mode(graph: Graph | None) -> str:
    """由「图」推导执行方式。

    single         0～1 个节点（= 跟一个助手聊）
    parallel       各点之间没有连线，各跑各的
    serial         一条直链：单根单汇、无分叉无汇合
    master_worker  一个源头扇出到多个（能拆任务 + 汇总），且不汇合
    dag            其余（分叉后汇合、长短不一的并行链……）
    """
    nodes, edges = normalise(graph)
    n = len(nodes)
    if n <= 1:
        return "single"

    # 有"上下文共享 / 记忆"这类关系时，只有通用分层执行器认得它们 ——
    # 老的四种模式（serial/parallel/master_worker）表达不了，所以直接走 dag。
    # 带"共享"的图必须走 dag：老四种模式没有地方表达"共享上下文 / 共享记忆"
    if any(shares_context(e) or shares_memory(e) for e in edges):
        return "dag"

    edges = dep_edges(edges)  # 并行线不计入结构判断：两个节点画一条并行线 = 并行
    e = len(edges)
    if e == 0:
        return "parallel"

    indeg = {x["nid"]: 0 for x in nodes}
    outdeg = {x["nid"]: 0 for x in nodes}
    for x in edges:
        outdeg[x["from"]] += 1
        indeg[x["to"]] += 1

    roots = sum(1 for x in nodes if indeg[x["nid"]] == 0)
    sinks = sum(1 for x in nodes if outdeg[x["nid"]] == 0)
    fan = any(outdeg[x["nid"]] > 1 for x in nodes)
    conv = any(indeg[x["nid"]] > 1 for x in nodes)

    if roots == 1 and sinks == 1 and not fan and not conv and e == n - 1:
        return "serial"
    if fan and not conv:
        return "master_worker"
    return "dag"


#: 界面上显示的说明（与模式一一对应，避免前端各写一套文案）
MODE_HINT: dict[str, str] = {
    "single": "跟一个助手聊 —— 摆第二个就会变成编排",
    "serial": "一条链，上一步产出喂下一步",
    "parallel": "没有连线，各跑各的",
    "master_worker": "一个助手拆任务给多个，再由它汇总",
    "dag": "有分叉或汇合，按依赖分层跑（同层并发）",
}


def mode_hint(graph: Graph | None, mode: str) -> str:
    """给推导出来的模式配一句**符合这张图**的说明。

    为什么不能直接查 MODE_HINT：落到 dag 的原因有两种 —— 真的分叉汇合，
    或者只是用了"上下文共享 / 记忆"这类关系。对后者说"有分叉或汇合"是错的，
    用户会盯着两个节点找不到分叉在哪。
    """
    if mode == "dag":
        nodes, edges = normalise(graph)
        used: list[str] = []
        if any(shares_context(e) for e in edges):
            used.append("共享上下文")
        if any(shares_memory(e) for e in edges):
            used.append("共享记忆")
        if used and len(nodes) <= 2:
            return f"按你选的连线关系执行：{'、'.join(dict.fromkeys(used))}"
        if used:
            return f"含 {'、'.join(dict.fromkeys(used))} 关系，按依赖分层跑（同层并发）"
    return MODE_HINT.get(mode, mode)

MODE_LABEL_CN: dict[str, str] = {
    "single": "单个助手",
    "serial": "串行接力",
    "parallel": "并行",
    "master_worker": "主从",
    "dag": "分层",
}
