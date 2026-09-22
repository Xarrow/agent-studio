"""API 路由聚合。"""

from fastapi import APIRouter

from . import (
    agents,
    credentials,
    memories,
    openai_compat,
    runs,
    runtimes,
    sessions,
    skills,
    tools,
)

api_router = APIRouter()
api_router.include_router(credentials.router)   # /api/providers + /api/credentials
api_router.include_router(runtimes.router)      # /api/runtimes
api_router.include_router(agents.router)        # /api/agents
api_router.include_router(tools.router)         # /api/tools
api_router.include_router(skills.router)        # /api/skills
api_router.include_router(runs.router)          # /api/runs
api_router.include_router(sessions.router)      # /api/sessions（多轮会话）
api_router.include_router(memories.router)      # /api/memories（长期记忆）
api_router.include_router(memories.agent_router)  # /api/agents/{id}/memories + memory-policy

# OpenAI 兼容层：任何 OpenAI 客户端都能直接用这些 Agent
# （model = Agent，messages → 会话历史，text_delta → choices[].delta）
api_router.include_router(openai_compat.router)  # /v1/models + /v1/chat/completions

__all__ = ["api_router"]
