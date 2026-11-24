"""用户直接粘 `npx skills add …` 整条命令时，也要能解析。

现场：界面上贴 `npx skills add vercel-labs/agent-browser` → 报
unrecognized_source「看不懂这个来源」，因为空格被当成非法字符、owner/repo 规则也匹配不上。
"""

from __future__ import annotations

import pytest

from agent_studio.skill_sources.parser import parse_source


@pytest.mark.parametrize(
    "raw,owner,repo",
    [
        ("npx skills add vercel-labs/agent-browser", "vercel-labs", "agent-browser"),
        ("npx -y skills add vercel-labs/agent-browser", "vercel-labs", "agent-browser"),
        ("npx skills install vercel-labs/agent-browser", "vercel-labs", "agent-browser"),
        ("skills add vercel-labs/agent-browser", "vercel-labs", "agent-browser"),
        ("  npx skills add   vercel-labs/agent-browser  ", "vercel-labs", "agent-browser"),
    ],
)
def test_整条命令行也能解析(raw, owner, repo):
    r = parse_source(raw)
    assert r.kind == "github"
    assert (r.owner, r.repo) == (owner, repo)


def test_命令行带技能名与分支():
    r = parse_source("npx skills add vercel-labs/agent-browser#main@browse")
    assert (r.owner, r.repo, r.skill) == ("vercel-labs", "agent-browser", "browse")
    assert r.ref == "main"


def test_命令行带完整地址():
    r = parse_source("npx -y skills add https://github.com/vercel-labs/agent-browser")
    assert r.kind == "github" and r.repo == "agent-browser"
