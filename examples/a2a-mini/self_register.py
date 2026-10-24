#!/usr/bin/env python3
"""在远端机器上跑：把自己的 agent card 推给 Agent Studio 自注册。

用法（在阿里云上）：
    REG_TOKEN=xxx python3 self_register.py
本地卡片地址默认 http://127.0.0.1:8900/.well-known/agent-card.json
"""
import json
import os
import sys
import urllib.error
import urllib.request

CARD_URL = os.environ.get("CARD_URL", "http://127.0.0.1:8900/.well-known/agent-card.json")
STUDIO = os.environ.get("STUDIO_SELF_URL", "https://as-prod.zeit.ccwu.cc/api/remote-agents/self")
TOKEN = os.environ.get("REG_TOKEN", "").strip()

if not TOKEN:
    print("缺 REG_TOKEN（在「远程 Agent 管理」页的「远端自注册」里取）")
    sys.exit(2)

with urllib.request.urlopen(CARD_URL, timeout=10) as r:
    card = json.load(r)

# 把卡片里的 url 换成本机对外的真实地址（卡片里是 127.0.0.1:8900 的话远端调不通）
card["url"] = os.environ.get("PUBLIC_URL", card.get("url", ""))

body = json.dumps(card).encode()
req = urllib.request.Request(
    STUDIO, data=body, method="POST",
    headers={
        "Content-Type": "application/json",
        "X-Register-Token": TOKEN,
        # Cloudflare 的浏览器完整性检查会 403 掉默认的 python-urllib UA（error 1010）
        "User-Agent": "a2a-mini/1 (agent-studio self-register)",
    },
)
try:
    with urllib.request.urlopen(req, timeout=40) as resp:
        d = json.load(resp)
        print("HTTP", resp.status, "| id:", d.get("id"), "| name:", d.get("name"),
              "| status:", d.get("status"), "| tool:", d.get("tool_name"),
              "| note:", (d.get("note") or "")[:60])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read()[:400].decode(errors="replace"))
    sys.exit(1)
except Exception as e:  # noqa: BLE001
    print(type(e).__name__, str(e)[:200])
    sys.exit(1)
