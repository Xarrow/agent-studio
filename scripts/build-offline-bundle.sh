#!/usr/bin/env bash
# ============================================================================
#  Agent Studio · 离线一体包构建脚本（x86_64 版）
#
#  产物：一个 tar.gz，目标机零依赖（不需要 Node、不需要系统 Python、不需要联网）。
#  包内：内置 CPython 运行时 + 预展开的全部依赖 + 后端源码 + 前端静态导出。
#
#  用法：bash scripts/build-offline-bundle.sh [x86_64]
#  联网：走 gateway 代理 192.168.2.7:7890（GitHub 经 gh-proxy）
# ============================================================================
set -euo pipefail

ARCH="${1:-x86_64}"
case "$ARCH" in
  x86_64)  PBS_ARCH="x86_64-unknown-linux-gnu" ;;
  aarch64) PBS_ARCH="aarch64-unknown-linux-gnu" ;;
  *) echo "不支持的架构：$ARCH"; exit 1 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/srv/build/asb-$ARCH}"
OUT="/srv/www/agent-studio-bundle"
PBS_TAG="${PBS_TAG:-20260924}"
PBS_VER="${PBS_VER:-3.13.15}"
STAGE="$WORK/stage/agent-studio"
DATE="$(date +%Y%m%d)"

export https_proxy="${https_proxy:-http://192.168.2.7:7890}"
export http_proxy="${http_proxy:-http://192.168.2.7:7890}"

echo "[1/6] 准备目录 $STAGE"
mkdir -p "$WORK" "$STAGE/app/src" "$STAGE/app/web" "$STAGE/runtime/$ARCH/python" "$STAGE/vendor/$ARCH"

echo "[2/6] 内置 Python 运行时 ($PBS_VER·$ARCH)"
if [ ! -x "$STAGE/runtime/$ARCH/python/bin/python3" ]; then
  PBS_URL="https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/cpython-$PBS_VER%2B$PBS_TAG-$PBS_ARCH-install_only_stripped.tar.gz"
  curl -fL --retry 3 -m 900 -o "$WORK/pbs.tar.gz" "$PBS_URL"
  tar xzf "$WORK/pbs.tar.gz" -C "$STAGE/runtime/$ARCH" --strip-components=1
  mv "$STAGE/runtime/$ARCH"/{bin,lib,include,share} "$STAGE/runtime/$ARCH/python/" 2>/dev/null || true
fi
"$STAGE/runtime/$ARCH/python/bin/python3" -V

echo "[3/6] 源码 + 前端静态产物"
cp -a "$REPO/src" "$STAGE/app/src/"
rm -rf "$STAGE/app/src/src" 2>/dev/null || true
mkdir -p "$STAGE/app/web"
cp -a "$REPO/web/out" "$STAGE/app/web/out"
[ -f "$STAGE/app/web/out/index.html" ] || { echo "缺少前端产物 web/out（先在 web/ 跑 npm run build）"; exit 1; }

echo "[4/6] 依赖集（按架构下载 wheel 并展开）"
REQ="$STAGE/requirements-lock.txt"
[ -f "$REQ" ] || cp "$REPO/requirements-lock.txt" "$REQ" 2>/dev/null || {
  echo "缺少 requirements-lock.txt（用 .venv 导出：python3 -m pip freeze --path .venv/lib/python3.13/site-packages）"; exit 1; }
SP="$STAGE/vendor/$ARCH/site-packages"
if [ ! -d "$SP" ]; then
  mkdir -p "$SP"
  PYBIN="$STAGE/runtime/$ARCH/python/bin/python3"
  if [ "$ARCH" = "$(uname -m)" ]; then
    # 本机构建：直接用运行时 pip 装进 vendor
    "$PYBIN" -m pip install -q --no-warn-script-location --target "$SP" -r "$REQ"
  else
    # 交叉构建：只下载该架构 wheel，再解包（不执行）
    WL="$WORK/wheels-$ARCH"; mkdir -p "$WL"
    python3 -m pip download -q --only-binary=:all: \
      --platform manylinux2014_$ARCH --platform manylinux_2_28_$ARCH \
      --platform manylinux_2_24_$ARCH --platform manylinux_2_17_$ARCH \
      --python-version 3.13 --implementation cp --abi cp313 \
      -d "$WL" -r "$REQ"
    for w in "$WL"/*.whl; do
      unzip -qo "$w" -d "$SP" '*.py' '*.so' '*.dist-info/*' '*.data/*' 2>/dev/null || true
    done
  fi
fi
ls "$SP" | wc -l

echo "[5/6] 启动脚本与说明"
cp "$REPO/scripts/bundle-start.sh" "$STAGE/start.sh"
chmod +x "$STAGE/start.sh"
cp "$REPO/scripts/bundle-README.md" "$STAGE/README.md" 2>/dev/null || true

echo "[6/6] 打包"
rm -rf "$STAGE/data"
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$OUT"
TAR="$OUT/agent-studio-$DATE-$ARCH.tar.gz"
tar czf "$TAR" -C "$WORK/stage" agent-studio
gzip -t "$TAR"
ls -lh "$TAR"
echo "完成：$TAR"
