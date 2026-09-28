"""长期记忆子系统（平台层能力，与运行时无关）。

模块划分：

- ``recall``  —— 召回：候选池 → 打分（recent/keyword/hybrid）→ 预算裁剪 → 渲染文本
- ``extract`` —— 提炼：从执行记录提炼候选 + 去重护栏
- ``policy``  —— 每个 Agent 的记忆策略（默认值 + 覆盖）

设计原则：这里**不出现任何框架类型**。适配器只消费渲染好的文本。
"""

from .extract import Candidate, call_llm, dedupe, parse_candidates
from .policy import DEFAULT_POLICY, get_policy, to_read, update_policy
from . import external
from .recall import RecallResult, RecalledMemory, mark_hit, recall, render

__all__ = [
    "Candidate",
    "DEFAULT_POLICY",
    "RecallResult",
    "RecalledMemory",
    "call_llm",
    "dedupe",
    "external",
    "get_policy",
    "mark_hit",
    "parse_candidates",
    "recall",
    "render",
    "to_read",
    "update_policy",
]
