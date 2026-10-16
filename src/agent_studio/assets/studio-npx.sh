#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Agent Studio 的 npx / skills 影子命令
#
# 为什么有这个东西
# ----------------
# 技能仓库的 README 一律这么写安装方式：
#
#     npx skills add minio/skills/aimem
#
# 但 Agent Studio 的部署机是**零 Node / 零系统 Python / 可能不联网**的。
# 用户（和跑在机器上的助手）手里只有这一行字，照抄就 `npx: not found`。
# 于是这里放一个**不碰 Node、只认 skills 命令**的替身：
#
#     npx skills add <引用> [--skill 名] [--all] [--agent 助手名] [-g] [-y]
#     npx skills list | remove <名> | update <引用> | find <词>
#     skills ...                       # 不带 npx 的写法同样支持
#
# 它把命令翻成平台 API 调用 —— 取仓库、发现 SKILL.md、落盘都由平台做，
# 机器上不需要 Node，也不需要能上 GitHub（平台侧自己有镜像兜底）。
#
# ⚠️ 两条纪律
#   1. **其它 npm 包原样让路**：`npx cowsay hi` 会转给 PATH 里真正的 npx；
#      没有就明确报「本机没有 Node」，绝不假装成功。
#   2. 成功 0 / 失败非 0 —— 脚本和助手靠退出码判断。
#
# 环境变量
#   STUDIO_URL    平台地址，默认 http://127.0.0.1:8848
#   STUDIO_TOKEN  公网模式下的访问口令（Authorization: Bearer）
#   STUDIO_PY     自带 Python 路径（没有 curl 时用它发请求；默认 python3）
# ─────────────────────────────────────────────────────────────────────────────
set -eu

ME=$(basename "$0")
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
STUDIO_URL="${STUDIO_URL:-http://127.0.0.1:8848}"
STUDIO_TOKEN="${STUDIO_TOKEN:-}"
PY="${STUDIO_PY:-python3}"
TMP_PY="$(mktemp 2>/dev/null || echo /tmp/studio-npx-py.$$)"
trap 'rm -f "$TMP_PY"' EXIT INT TERM

# JSON 美化/解析的 Python 小工具：**写成文件再调用**。
# ⚠️ 不能用 `"$PY" - <<'PY'` 直接喂源码 —— 那样 stdin 被 heredoc 占了，
# 管道里的 JSON 就进不来（实测：body 永远是空的，报「看不懂的内容」）。
cat > "$TMP_PY" <<'PY'
import json, sys

mode = sys.argv[1]
args = sys.argv[2:]
raw = sys.stdin.read()

# agents_json 收的不是 JSON 而是管道分隔的名字表 —— 必须在解析前处理
if mode == "agents_json":
    print(json.dumps([x for x in raw.strip().split("|") if x]))
    raise SystemExit(0)

try:
    d = json.loads(raw)
except Exception:
    print("平台返回了看不懂的内容：%s" % raw[:300].replace("\n", " "))
    raise SystemExit(1)

if isinstance(d, dict) and "detail" in d:
    det = d["detail"]
    if isinstance(det, dict) and det.get("skills"):
        print("这个仓库里有多个技能，指定一个再装：")
        for s in det["skills"]:
            print("  --skill %-24s %s" % (s.get("name"), (s.get("description") or "")[:60]))
        raise SystemExit(3)
    print("失败：%s" % (det if isinstance(det, str) else json.dumps(det, ensure_ascii=False))[:400])
    raise SystemExit(1)

if mode == "installed":
    print("已装的技能：")
    for r in d:
        src = r.get("source") or {}
        where = src.get("repo") or src.get("type") or ""
        print("  %-28s %s" % (r.get("name"), where))
elif mode == "install":
    for it in d.get("items", []):
        print("%s %s  （来源 %s @ %s）" % ("已更新" if it.get("updated") else "已安装",
                                          it.get("name"), d.get("repo"), d.get("ref")))
    for a in d.get("attached") or []:
        print("已挂到助手：%s" % a)
    for a in d.get("agents_missing") or []:
        print("没找到这个助手（技能已装好）：%s" % a)
elif mode == "scan":
    stars = ("★ %s" % d["stars"]) if d.get("stars") else ""
    print("%s @ %s  %s" % (d.get("repo"), d.get("ref"), stars))
    for s in d.get("skills", []):
        print("  %-28s %s" % (s.get("name"), s.get("path") or "."))
        if s.get("description"):
            print("      %s" % s["description"][:100])
elif mode == "ids":
    want = args[0]
    for r in d:
        if r.get("name") == want:
            print(r["id"])
            break
elif mode == "agents_json":
    print(json.dumps([x for x in raw.strip().split("|") if x]))
PY

# 用法： <json> | pretty <mode> [args...]
pretty() {
  "$PY" "$TMP_PY" "$@"
}

# ── HTTP：优先 curl；没有就用自带 Python（部署机没有系统 Python 也跑得动）──
_auth() { [ -n "$STUDIO_TOKEN" ] && printf 'Authorization: Bearer %s' "$STUDIO_TOKEN" || printf 'X-No-Auth: 1'; }

http_post() { # $1=path $2=json
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$STUDIO_TOKEN" ]; then
      curl -sS -m 180 -X POST -H 'Content-Type: application/json' -H "$(_auth)" -d "$2" "$STUDIO_URL$1"
    else
      curl -sS -m 180 -X POST -H 'Content-Type: application/json' -d "$2" "$STUDIO_URL$1"
    fi
  else
    "$PY" - "$STUDIO_URL$1" "$2" "$STUDIO_TOKEN" <<'PY'
import sys, urllib.request, urllib.error
url, body, token = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request(url, data=body.encode(), method="POST",
                             headers={"Content-Type": "application/json"})
if token:
    req.add_header("Authorization", "Bearer " + token)
try:
    sys.stdout.write(urllib.request.urlopen(req, timeout=180).read().decode())
except urllib.error.HTTPError as e:
    sys.stdout.write(e.read().decode())
PY
  fi
}

http_get() { # $1=path
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$STUDIO_TOKEN" ]; then curl -sS -m 60 -H "$(_auth)" "$STUDIO_URL$1"
    else curl -sS -m 60 "$STUDIO_URL$1"; fi
  else
    "$PY" - "$STUDIO_URL$1" "$STUDIO_TOKEN" <<'PY'
import sys, urllib.request
req = urllib.request.Request(sys.argv[1])
if sys.argv[2]:
    req.add_header("Authorization", "Bearer " + sys.argv[2])
sys.stdout.write(urllib.request.urlopen(req, timeout=60).read().decode())
PY
  fi
}

http_delete() { # $1=path → 输出状态码
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$STUDIO_TOKEN" ]; then curl -sS -m 60 -X DELETE -o /dev/null -w '%{http_code}' -H "$(_auth)" "$STUDIO_URL$1"
    else curl -sS -m 60 -X DELETE -o /dev/null -w '%{http_code}' "$STUDIO_URL$1"; fi
  else
    "$PY" - "$STUDIO_URL$1" "$STUDIO_TOKEN" <<'PY'
import sys, urllib.request, urllib.error
req = urllib.request.Request(sys.argv[1], method="DELETE")
if sys.argv[2]:
    req.add_header("Authorization", "Bearer " + sys.argv[2])
try:
    sys.stdout.write(str(urllib.request.urlopen(req, timeout=60).status))
except urllib.error.HTTPError as e:
    sys.stdout.write(str(e.code))
PY
  fi
}

# ── JSON 处理：交给写好的小工具（不假设有 jq）───────────────────────────
# （小工具在脚本开头写成临时文件；JSON 从 stdin 进）

# ── 不是 skills 命令 → 让路给真正的 npx ─────────────────────────────────
if [ "$ME" = "npx" ] || [ "$ME" = "pnpx" ] || [ "$ME" = "bunx" ]; then
  _is_skills=1
  for a in "$@"; do
    case "$a" in
      skills|skills@*) _is_skills=0 ;;
    esac
  done
  if [ "$_is_skills" = "1" ]; then
    _rest=""
    _old_ifs=$IFS; IFS=:
    for d in $PATH; do
      [ "$d" = "$(dirname "$SELF")" ] && continue
      [ -x "$d/$ME" ] && { _rest="$d/$ME"; break; }
    done
    IFS=$_old_ifs
    if [ -n "$_rest" ]; then exec "$_rest" "$@"; fi
    echo "$ME：本机没有 Node（Agent Studio 的部署机是零 Node 的）。" >&2
    echo "只有 skills 生态的命令能在这里跑：" >&2
    echo "  $ME skills add tt-a1i/archify" >&2
    exit 127
  fi
fi

# ── 剥掉执行器与 npx 自带开关，还原成 skills 自己的参数 ───────────────────
_args=""
_skip=0
for a in "$@"; do
  if [ "$_skip" = "1" ]; then _skip=0; continue; fi
  case "$a" in
    npx|pnpx|bunx|dlx|skills) continue ;;
    skills@*) continue ;;
    -y|--yes|-q|--quiet|--no-install|--ignore-existing|--prefer-online) continue ;;
    -p|--package|--registry|--cache|--userconfig) _skip=1; continue ;;
  esac
  _args="$_args $(printf '%s' "$a" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/")"
done
eval "set --$_args"

if [ "$#" = "0" ]; then
  cat >&2 <<'USAGE'
用法：npx skills add <owner/repo[/目录]> [--skill 名] [--all] [--agent 助手名]
      npx skills list | remove <名> | update <引用> | find <关键词>
USAGE
  exit 2
fi

action="$1"; shift
case "$action" in
  i|install) action=add ;;
  ls) action=list ;;
  rm|uninstall) action=remove ;;
  up|upgrade) action=update ;;
  search|browse) action=find ;;
esac

ref=""; skill=""; all="0"; list_only="0"; agents=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skill|-s) skill="$2"; shift 2 ;;
    --skill=*) skill="${1#--skill=}"; shift ;;
    --agent|-a) agents="$agents|$2"; shift 2 ;;
    --agent=*) agents="$agents|${1#--agent=}"; shift ;;
    --all) all="1"; shift ;;
    --list|-l) list_only="1"; shift ;;
    -g|--global|-y|--yes|--force|-f) shift ;;   # 平台技能本来就是全局的
    --category|--name|--ref) shift 2 ;;
    --*=*) shift ;;
    -*) shift ;;
    *) [ -z "$ref" ] && ref="$1"; shift ;;
  esac
done

# ── 预览：list（带引用=预览仓库）/ find ────────────────────────────────
if [ "$action" = "list" ] && [ -z "$ref" ]; then
  http_get "/api/skills" | pretty installed
  exit 0
fi
if [ "$action" = "list" ] || [ "$list_only" = "1" ] || [ "$action" = "find" ]; then
  [ -z "$ref" ] && { echo "要跟一个引用，例如 owner/repo" >&2; exit 2; }
  http_post "/api/skills/scan" "{\"ref\":\"$ref\"}" | pretty scan
  exit 0
fi

# ── 删除 ───────────────────────────────────────────────────────────────
if [ "$action" = "remove" ]; then
  [ -z "$ref" ] && { echo "skills remove 要跟一个技能名" >&2; exit 2; }
  sid=$(http_get "/api/skills" | pretty ids "$ref")
  [ -z "$sid" ] && { echo "没找到技能：$ref" >&2; exit 1; }
  code=$(http_delete "/api/skills/$sid")
  if [ "$code" = "204" ] || [ "$code" = "200" ]; then echo "已删除：$ref"; exit 0; fi
  echo "删除失败（HTTP $code）" >&2; exit 1
fi

# ── add / update：同一个接口（同名幂等 → 重装即更新）─────────────────────
[ -z "$ref" ] && { echo "要跟一个引用，例如 owner/repo" >&2; exit 2; }
json="{\"ref\":\"$ref\""
[ -n "$skill" ] && json="$json,\"skill\":\"$skill\""
[ "$all" = "1" ] && json="$json,\"all\":true"
if [ -n "$agents" ]; then
  alist=$(printf '%s' "$agents" | pretty agents_json)
  json="$json,\"agents\":$alist"
fi
json="$json}"

http_post "/api/skills/install" "$json" | pretty install
