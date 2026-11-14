"""管理层 CLI：``python -m agent_studio.cli_skills …``

不引第三方 CLI 库（项目约定不新增依赖）。所有命令支持 ``--json`` 输出稳定结构，
便于脚本与 CI 断言。

命令：
    parse <字符串>                 只解析，不联网
    add <来源> [--skill x] [--path p] [--dry-run]
    check [--force]                检查更新
    update [名称]                  更新一个（不给就更新全部有更新的）
    doctor [--host h]              网络/环境诊断
    source list|add|edit|remove|test|browse
    settings [--mode auto|npx|native] [--pin skills@x.y.z]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import httpx

DEFAULT_BASE = os.environ.get("STUDIO_BASE", "http://127.0.0.1:8848")


def _client(base: str, token: str | None) -> httpx.Client:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.Client(base_url=base.rstrip("/"), headers=headers, timeout=180)


def _emit(obj: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            print(f"{k}: {v if not isinstance(v, (dict, list)) else json.dumps(v, ensure_ascii=False)}")
    else:
        print(json.dumps(obj, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="skills", description="远程技能来源：解析/安装/检查/更新")
    p.add_argument("--base", default=DEFAULT_BASE, help="API 地址（默认 http://127.0.0.1:8848）")
    p.add_argument("--token", default=os.environ.get("STUDIO_ACCESS_TOKEN") or None)
    p.add_argument("--json", action="store_true", dest="as_json")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("parse", help="解析来源字符串（不联网）")
    s.add_argument("raw")

    a = sub.add_parser("add", help="从来源安装技能")
    a.add_argument("raw")
    a.add_argument("--skill", action="append", default=[])
    a.add_argument("--path", action="append", default=[])
    a.add_argument("--ref")
    a.add_argument("--dry-run", action="store_true")

    c = sub.add_parser("check", help="检查更新")
    c.add_argument("--force", action="store_true")

    u = sub.add_parser("update", help="更新技能（不给名字=全部有更新的）")
    u.add_argument("name", nargs="?")

    d = sub.add_parser("doctor", help="网络与环境诊断")
    d.add_argument("--host", default="github.com")

    st = sub.add_parser("settings", help="查看/修改远程技能设置")
    st.add_argument("--mode", choices=["auto", "npx", "native"])
    st.add_argument("--pin")
    st.add_argument("--allow-latest", choices=["on", "off"])

    src = sub.add_parser("source", help="仓库来源管理")
    ssub = src.add_subparsers(dest="source_cmd", required=True)
    sl = ssub.add_parser("list")
    sl.add_argument("--json", action="store_true", dest="as_json_local")
    sa = ssub.add_parser("add")
    sa.add_argument("address")
    sa.add_argument("--name", default="")
    sa.add_argument("--ref", default="")
    sa.add_argument("--subpath", default="")
    sa.add_argument("--priority", type=int, default=100)
    sa.add_argument("--token", default="")
    se = ssub.add_parser("edit")
    se.add_argument("id")
    se.add_argument("--name")
    se.add_argument("--enabled", choices=["on", "off"])
    se.add_argument("--priority", type=int)
    sr = ssub.add_parser("remove")
    sr.add_argument("id")
    stt = ssub.add_parser("test")
    stt.add_argument("id")
    sb = ssub.add_parser("browse")
    sb.add_argument("id")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    as_json = bool(args.as_json)
    with _client(args.base, args.token) as c:
        if args.cmd == "parse":
            r = c.get("/api/skills/parse", params={"q": args.raw})
            _emit(r.json(), as_json)
            return 0 if r.json().get("ok") else 2

        if args.cmd == "add":
            body = {
                "ref": args.raw,
                "skills": args.skill or None,
                "paths": args.path or None,
                "ref_pin": args.ref,
                "dry_run": args.dry_run,
            }
            r = c.post("/api/skills/remote/install", json=body)
            _emit(r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": r.text}, as_json)
            return 0 if r.status_code < 400 else 1

        if args.cmd == "check":
            r = c.get("/api/skills/updates", params={"force": args.force})
            data = r.json()
            if not as_json:
                for it in data.get("items", []):
                    flag = "有更新" if it.get("has_update") else "已最新"
                    print(f"{it['name']}: {flag} ({it.get('status')})")
            else:
                _emit(data, True)
            return 0

        if args.cmd == "update":
            if args.name:
                r = c.get("/api/skills", params={"q": args.name})
                rows = r.json() if r.status_code == 200 else []
                hit = next((x for x in rows if x.get("name") == args.name), None)
                if not hit:
                    print(f"没找到技能：{args.name}", file=sys.stderr)
                    return 2
                r2 = c.post(f"/api/skills/{hit['id']}/update")
                _emit(r2.json(), as_json)
                return 0 if r2.status_code < 400 else 1
            data = c.get("/api/skills/updates").json()
            done = []
            for it in data.get("has_updates", []):
                r2 = c.post(f"/api/skills/{it['id']}/update")
                done.append({"name": it["name"], "ok": r2.status_code < 400})
            _emit({"updated": done}, as_json)
            return 0

        if args.cmd == "doctor":
            _emit(c.get("/api/skills/doctor", params={"host": args.host}).json(), as_json)
            return 0

        if args.cmd == "settings":
            body: dict[str, Any] = {}
            if args.mode:
                body["mode"] = args.mode
            if args.pin is not None:
                body["npx_pin"] = args.pin
            if args.allow_latest:
                body["allow_latest"] = args.allow_latest == "on"
            if body:
                _emit(c.put("/api/skills/remote/settings", json=body).json(), as_json)
            else:
                _emit(c.get("/api/skills/remote/settings").json(), as_json)
            return 0

        if args.cmd == "source":
            if args.source_cmd == "list":
                _emit(c.get("/api/skill-sources").json(), as_json or args.as_json_local)
            elif args.source_cmd == "add":
                r = c.post(
                    "/api/skill-sources",
                    json={
                        "address": args.address,
                        "name": args.name,
                        "ref": args.ref,
                        "subpath": args.subpath,
                        "priority": args.priority,
                        "token": args.token,
                    },
                )
                _emit(r.json(), as_json)
                return 0 if r.status_code < 400 else 1
            elif args.source_cmd == "edit":
                cur = next((x for x in c.get("/api/skill-sources").json() if x["id"] == args.id), None)
                if not cur:
                    print("来源不存在", file=sys.stderr)
                    return 2
                body = {
                    "name": args.name if args.name is not None else cur["name"],
                    "kind": cur["kind"],
                    "address": cur["address"],
                    "ref": cur["ref"],
                    "subpath": cur["subpath"],
                    "enabled": cur["enabled"] if args.enabled is None else args.enabled == "on",
                    "priority": args.priority if args.priority is not None else cur["priority"],
                    "net_policy": cur.get("net_policy") or {},
                    "tags": cur.get("tags") or [],
                    "note": cur.get("note") or "",
                }
                _emit(c.put(f"/api/skill-sources/{args.id}", json=body).json(), as_json)
            elif args.source_cmd == "remove":
                r = c.delete(f"/api/skill-sources/{args.id}")
                _emit({"ok": r.status_code < 400}, as_json)
            elif args.source_cmd == "test":
                _emit(c.post(f"/api/skill-sources/{args.id}/test").json(), as_json)
            elif args.source_cmd == "browse":
                _emit(c.post(f"/api/skill-sources/{args.id}/browse").json(), as_json)
            return 0
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
