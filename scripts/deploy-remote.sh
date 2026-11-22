#!/usr/bin/env bash
# ============================================================================
#  远端一体化包部署（agent-studio）
#
#  为什么需要它：东京那台**没有 git 仓库**，前端产物目录由 start.sh 里的
#  STUDIO_WEB_DIST 决定（app/web/out）。之前手工往 web/out 覆盖，后端是新的、
#  前端一直是旧包 —— 用户那边表现成"改了没生效"，排查了几轮才定位。
#  这个脚本只做一件事：**问远端它到底从哪读静态文件**，然后只往那儿写，
#  最后用 /api/version 回报的 commit 和文件数做验收。
#
#  两处补丁（都是真机踩出来的，别删）：
#   · 依赖同步：包里的依赖是**预展开**在 vendor/<arch>/site-packages 的（PYTHONPATH 注入），
#     不像 venv 那样会自己解析新依赖。后端新增了库（例如 WebRTC 的 aiortc/PyAV）
#     而只同步源码 → 远端 import 失败、功能悄悄降级。所以这里按 requirements-lock.txt
#     逐个比对远端已装版本，只补缺的（--no-deps：传递依赖都写在 lock 里）。
#   · 可控重启：uvicorn 在 SSE 长连接/浏览器会话上优雅退出会挂住，`systemctl restart`
#     会一直被 systemd 等到 TimeoutStopSec，期间新进程根本没起，回读到的还是旧版本。
#     这里先停（20s 不走就 SIGKILL），再起，然后轮询 /api/version 直到读到**新 commit**。
#
#  用法：
#    scripts/deploy-remote.sh <ssh主机> [--no-web] [--no-api] [--no-deps]
#  例：
#    scripts/deploy-remote.sh tokyo
#
#  约定（远端）：
#    · unit：agent-studio（systemd），服务用户 agentstudio
#    · 包根：/opt/agent-studio
#    · 后端源码：/opt/agent-studio/app/src
#    · 静态目录：由 start.sh 的 STUDIO_WEB_DIST 决定，脚本运行时读取
#    · 依赖目录：/opt/agent-studio/vendor/<arch>/site-packages（随包预展开）
# ============================================================================
set -euo pipefail

HOST="${1:-}"
shift || true
DO_WEB=1
DO_API=1
DO_DEPS=1
for a in "$@"; do
  case "$a" in
    --no-web) DO_WEB=0 ;;
    --no-api) DO_API=0 ;;
    --no-deps) DO_DEPS=0 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done
if [ -z "$HOST" ]; then
  echo "用法: $0 <ssh主机> [--no-web] [--no-api] [--no-deps]"; exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOCAL_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
echo "[1/6] 本地 commit=$LOCAL_COMMIT"

# 静态目录必须由构建产物存在才发；否则不发，避免把空目录同步上去变成白屏
if [ "$DO_WEB" = 1 ] && [ ! -f web/out/index.html ]; then
  echo "[!] web/out 不存在或没有 index.html —— 先构建： cd web && npm run build"; exit 1
fi

REMOTE_BASE="${REMOTE_BASE:-/opt/agent-studio}"
UNIT="${UNIT:-agent-studio}"
API_PORT="${API_PORT:-8891}"

echo "[2/6] 问远端：静态目录在哪、服务是谁"
REMOTE_INFO="$(ssh "$HOST" "sudo grep -oE 'STUDIO_WEB_DIST=\"?\\\$PWD[^\" ]*' $REMOTE_BASE/start.sh 2>/dev/null | head -1 | sed 's/.*PWD//;s/\"//g'; systemctl show -p MainPID --value $UNIT")"
WEB_SUFFIX="$(echo "$REMOTE_INFO" | head -1 | tr -d '\r')"
MAIN_PID="$(echo "$REMOTE_INFO" | tail -1 | tr -d '\r')"
if [ -z "$WEB_SUFFIX" ]; then
  echo "[!] 远端 start.sh 里没找到 STUDIO_WEB_DIST（包结构变了？）"; exit 1
fi
REMOTE_WEB="$REMOTE_BASE$WEB_SUFFIX"
echo "      静态目录 = $REMOTE_WEB   MainPID=${MAIN_PID:-none}"

if [ "$DO_API" = 1 ]; then
  echo "[3/6] 同步后端源码 → $REMOTE_BASE/app/src"
  tar -cf - src/agent_studio | ssh "$HOST" "sudo tar -C $REMOTE_BASE/app -xf - && sudo chown -R agentstudio:agentstudio $REMOTE_BASE/app/src"
fi

# ── 依赖：按 requirements-lock.txt 比对远端 vendor/<arch>/site-packages ──────
if [ "$DO_DEPS" = 1 ]; then
  echo "[4/6] 同步依赖清单并补齐 → $REMOTE_BASE/vendor/<arch>/site-packages"
  ssh "$HOST" "sudo tee $REMOTE_BASE/requirements-lock.txt >/dev/null" < requirements-lock.txt
  # 清单随包走：先落盘，再在远端用**包内运行时**补齐（不需要系统 python/网络代理）
  ssh "$HOST" "sudo bash -s -- '$REMOTE_BASE'" <<'REMOTE_DEPS'
set -euo pipefail
ROOT="$1"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) ARCH=aarch64 ;;
  x86_64|amd64)  ARCH=x86_64 ;;
  *) echo "[!] 不认识的目标架构：$ARCH"; exit 1 ;;
esac
SP="$ROOT/vendor/$ARCH/site-packages"
PY="$ROOT/runtime/$ARCH/python/bin/python3"
REQ="$ROOT/requirements-lock.txt"
[ -x "$PY" ] || { echo "[!] 找不到包内运行时 $PY（这个包不是离线一体包？）"; exit 1; }
[ -d "$SP" ] || { echo "[!] 找不到依赖目录 $SP"; exit 1; }

# 缺什么：逐条比 lock 的固定版本与 vendor 里读到的已装版本
#
# 两个坑（都是实测踩的）：
#  · 必须 -S 起 python：不然包内运行时自己的 site-packages 也会进 sys.path，
#    "手工 pip 装进 site-packages" 的那几份会把缺失掩盖掉（vendor 其实没有，检查却通过）。
#  · lock 里有平台条件依赖（pywin32 / colorama 只在 win32、httpx2-jsfetch 只在 emscripten），
#    不按 marker 过滤就会去 linux 上装 pywin32，pip 直接 no matching distribution。
MISSING="$(PYTHONPATH="$SP" "$PY" -S - "$REQ" <<'PY'
import sys
import importlib.metadata as md
from packaging.markers import Marker

want = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if not line or "==" not in line:
        continue
    name, rest = line.split("==", 1)
    ver, _, marker = rest.partition(";")
    if marker.strip():
        try:
            if not Marker(marker.strip()).evaluate():
                continue                      # 这条只对别的平台才要
        except Exception:
            pass                              # marker 解析不了就当需要（宁可多装）
    want[name.strip().lower().replace("_", "-")] = ver.strip()

have = {}
for d in md.distributions():
    n = (d.metadata["Name"] or "").lower().replace("_", "-")
    if n:
        have[n] = d.version

for n, v in sorted(want.items()):
    if have.get(n) != v:
        print(f"{n}=={v}")
PY
)"

TOTAL="$(grep -cE '^[a-z0-9]' "$REQ")"
if [ -z "$MISSING" ]; then
  echo "      依赖齐全（$TOTAL 项全部命中）"
else
  echo "$MISSING" | sed 's/^/      补装: /'
  printf '%s\n' "$MISSING" > /tmp/as-missing-req.txt
  # pip --target 的老毛病：同名目录已存在时它只「跳过」不覆盖，于是旧代码 + 新 dist-info
  # 并存（cryptography 50.0.1 的 .so、50.0.2 的 METADATA —— 元数据说新、跑的是旧）。
  # 所以先精确删掉这些包的旧 dist-info，再用 --upgrade 强制覆盖。
  while IFS= read -r pin; do
    pkg="${pin%%==*}"
    rm -rf "$SP/$pkg"-*.dist-info
  done < /tmp/as-missing-req.txt
  # --no-deps：传递依赖也逐条写在 lock 里，让 pip 只装我们点名的，绝不顺手动别的版本
  PYTHONPATH="$SP" "$PY" -m pip install -q --disable-pip-version-check \
    --no-warn-script-location --only-binary=:all: --no-deps --upgrade \
    --target "$SP" -r /tmp/as-missing-req.txt
  chown -R agentstudio:agentstudio "$ROOT/vendor/$ARCH"
fi

# 自检（同样 -S，只看 vendor）：WebRTC 媒体栈必须真的 import 得起来 ——
# 原生扩展缺 .so 时 pip 不会报，只有 import 才知道。
# 顺带卡「元数据新、代码旧」：拿模块自己的 __version__ 跟 dist-info 对一遍。
PYTHONPATH="$SP" "$PY" -S - <<'PY'
import importlib.metadata as md

for name in ("aiortc", "av", "pylibsrtp", "aioice", "cryptography"):
    try:
        meta = md.version(name)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"[!] vendor 里 {name} 不可用：{exc}")
    print(f"      {name}=={meta}")

try:
    import cryptography

    if cryptography.__version__ != md.version("cryptography"):
        raise SystemExit(
            "      [!] cryptography 代码版本 %s 与 dist-info %s 不一致（vendor 有残留副本）"
            % (cryptography.__version__, md.version("cryptography"))
        )
except SystemExit:
    raise
except Exception as exc:  # noqa: BLE001
    raise SystemExit(f"[!] cryptography 导入失败：{exc}")

try:
    import av.codec  # noqa: F401
    av.codec.Codec("libx264", "w")
    print("      libx264 编码器可用")
except Exception as exc:  # noqa: BLE001
    print(f"      [!] libx264 不可用（会走 VP8 兜底）：{exc}")
PY

# 提醒：包内运行时自己的 site-packages 不该再躺手工装的依赖（版本会和 vendor 打架）
"$PY" - "$REQ" <<'PY'
import importlib.metadata as md
import sys

want = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if "==" in line:
        want.add(line.split("==", 1)[0].strip().lower().replace("_", "-"))

dups = sorted({
    (d.metadata["Name"] or "").lower().replace("_", "-")
    for d in md.distributions()
} & want - {"pip"})
if dups:
    print("      [!] 运行时 site-packages 里还有手工装的同名包：" + ", ".join(dups))
    print("          （vendor 才是权威；这些是历史遗留，建议移到备份目录后重启）")
PY
REMOTE_DEPS
fi

if [ "$DO_WEB" = 1 ]; then
  echo "[5/6] 同步前端产物 → $REMOTE_WEB（保留一份 prev 便于回滚）"
  tar -C web/out -cf - . | ssh "$HOST" "sudo rm -rf $REMOTE_WEB.prev && sudo cp -a $REMOTE_WEB $REMOTE_WEB.prev 2>/dev/null; sudo rm -rf $REMOTE_WEB && sudo mkdir -p $REMOTE_WEB && sudo tar -C $REMOTE_WEB -xf - && sudo chown -R agentstudio:agentstudio $REMOTE_WEB"
fi

# 部署形态可能没有 .git（离线包）：把 commit 落成文件，/api/version 直接读它
if [ "$LOCAL_COMMIT" != "unknown" ]; then
  echo "$LOCAL_COMMIT" | ssh "$HOST" "sudo tee $REMOTE_BASE/app/.build_commit >/dev/null && sudo chown agentstudio:agentstudio $REMOTE_BASE/app/.build_commit"
fi

echo "[6/6] 可控重启并按 /api/version 验收"
ssh "$HOST" "sudo bash -s -- '$UNIT' '$API_PORT' '$LOCAL_COMMIT'" <<'REMOTE_RESTART' | tee /tmp/deploy-version.json
set -uo pipefail
UNIT="$1"; PORT="$2"; WANT="$3"

# 1) 停：放在后台等，挂住也不钉死这条命令（uvicorn 在长连接上会拖到 TimeoutStopSec）
sudo systemctl stop "$UNIT" &
STOP_PID=$!
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$UNIT" || break
  sleep 1
done
if systemctl is-active --quiet "$UNIT"; then
  echo "      [!] 优雅退出 20s 未完成 → SIGKILL（旧进程多半卡在关闭 SSE）" >&2
  sudo systemctl kill -s SIGKILL "$UNIT" || true
  sleep 1
fi
wait "$STOP_PID" 2>/dev/null || true
if systemctl is-active --quiet "$UNIT"; then
  echo "      [!] 旧进程仍在，重启中止" >&2
  exit 1
fi
echo "      旧进程已退出" >&2

# 2) 起
sudo systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
sudo systemctl start "$UNIT"

# 3) 等新进程真的接活：/api/version 能读、且 commit 是新提交
for _ in $(seq 1 60); do
  OUT="$(curl -sf --max-time 2 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null || true)"
  if [ -n "$OUT" ]; then
    case "$OUT" in
      *"\"commit\":\"$WANT\""*) printf '%s\n' "$OUT"; exit 0 ;;
    esac
    LAST="$OUT"
  fi
  sleep 1
done

echo "      [!] 60s 内没读到新 commit 的 /api/version；最后读到：${LAST:-<无响应>}" >&2
systemctl --no-pager -l status "$UNIT" | tail -20 >&2 || true
journalctl -u "$UNIT" -n 30 --no-pager >&2 || true
exit 1
REMOTE_RESTART
echo

python3 - "$LOCAL_COMMIT" <<'PY'
import json, sys
local = sys.argv[1]
try:
    d = json.load(open("/tmp/deploy-version.json"))
except Exception:
    print("[!] 远端 /api/version 不可读 —— 服务可能没起来"); sys.exit(1)
ok = True
if local != "unknown" and d.get("commit") not in (local, "unknown"):
    print(f"[!] commit 不一致：本地 {local} / 远端 {d.get('commit')}"); ok = False
if d.get("web_files", 0) < 20:
    print(f"[!] 远端静态文件数异常：{d.get('web_files')}（可能是空目录或指错路径）"); ok = False
print(("✓ 部署验收通过：" if ok else "✗ 部署验收失败：") + json.dumps(d, ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
