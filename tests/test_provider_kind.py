"""provider 元数据要带 kind：工具密钥（kind=tools）不该出现在 LLM 配置里。

来由：deepseek-tools 是给 web_search/fetch/OCR/ASR/TTS 用的 key，被塞进
「LLM 配置 → 服务商」下拉，用户看到"一个不是模型的东西能选"，判定是设计错误。
"""

from __future__ import annotations


async def test_providers_带_kind_且能区分工具密钥(client):
    rows = (await client.get("/api/providers")).json()
    assert rows, "没有 provider"
    by_name = {r["name"]: r for r in rows}
    assert by_name["deepseek"]["kind"] == "llm"
    assert by_name["deepseek-tools"]["kind"] == "tools"
    # 工具密钥没有对话模型可选 —— 这正是它不该进 LLM 配置的原因
    assert by_name["deepseek-tools"]["models"] == []
