#!/usr/bin/env bash
# ============================================================================
#  Agent Studio · 离线一体包构建脚本（x86_64 版）
#
#  产物：一个 tar.gz，目标机零依赖（不需要 Node、不需要系统 Python、不需要联网）。
#  包内：内置 CPython 运行时 + 预展开的全部依赖 + 后端源码 + 前端静态导出。
#
#  用法：bash scripts/build-offline-bundle.sh [x86_64|aarch64|macos-arm64]
#        macos-arm64 = macOS（Apple Silicon）原生包，内含 aarch64-apple-darwin 运行时
#  联网：走 gateway 代理 192.168.2.7:7890（GitHub 经 gh-proxy）
# ============================================================================
set -euo pipefail

ARCH="${1:-x86_64}"
case "$ARCH" in
  x86_64)
    PBS_ARCH="x86_64-unknown-linux-gnu"; DIR_ARCH="x86_64"
    PLATS=(manylinux2014_x86_64 manylinux_2_17_x86_64 manylinux_2_24_x86_64 manylinux_2_28_x86_64) ;;
  aarch64)
    PBS_ARCH="aarch64-unknown-linux-gnu"; DIR_ARCH="aarch64"
    PLATS=(manylinux2014_aarch64 manylinux_2_17_aarch64 manylinux_2_24_aarch64 manylinux_2_28_aarch64) ;;
  macos-arm64|macos-aarch64)
    # macOS 的 python-build-standalone 是 darwin 目标，和 linux-aarch64 不是同一个运行时。
    # 包内目录仍叫 aarch64：bundle-start.sh 把 uname -m 的 arm64 映射到 aarch64，脚本不用改。
    PBS_ARCH="aarch64-apple-darwin"; DIR_ARCH="aarch64"
    PLATS=(macosx_11_0_arm64 macosx_11_0_universal2) ;;
  *) echo "不支持的架构：$ARCH"; exit 1 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/srv/build/asb-$ARCH}"
OUT="${OUT:-/srv/www/agent-studio-bundle}"
PBS_TAG="${PBS_TAG:-20260924}"
PBS_VER="${PBS_VER:-3.13.15}"
STAGE="$WORK/stage/agent-studio"
DATE="$(date +%Y%m%d)"

export https_proxy="${https_proxy-http://192.168.2.7:7890}"
export http_proxy="${http_proxy-http://192.168.2.7:7890}"
# 说明：上面用 '-' 而不是 ':-'，这样调用方传空值可以显式关掉代理（CI 里那个网关代理不可达）。
# PBS_URL_BASE 同理：本地空着走 gh-proxy，CI 传空字符串 = 直连 GitHub。

echo "[1/6] 准备目录 $STAGE"
mkdir -p "$WORK" "$STAGE/app/src" "$STAGE/app/web" "$STAGE/runtime/$DIR_ARCH/python" "$STAGE/vendor/$DIR_ARCH"

echo "[2/6] 内置 Python 运行时 (${PBS_VER}·$ARCH)"
if [ ! -x "$STAGE/runtime/$DIR_ARCH/python/bin/python3" ]; then
  PBS_URL="${PBS_URL_BASE-https://gh-proxy.com/}https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/cpython-$PBS_VER%2B$PBS_TAG-$PBS_ARCH-install_only_stripped.tar.gz"
  curl -fL --retry 3 -m 900 -o "$WORK/pbs.tar.gz" "$PBS_URL"
  tar xzf "$WORK/pbs.tar.gz" -C "$STAGE/runtime/$DIR_ARCH" --strip-components=1
  mv "$STAGE/runtime/$DIR_ARCH"/{bin,lib,include,share} "$STAGE/runtime/$DIR_ARCH/python/" 2>/dev/null || true
fi
"$STAGE/runtime/$DIR_ARCH/python/bin/python3" -V

echo "[3/6] 源码 + 前端静态产物"
# 先清掉上一次构建留下的 app/，否则旧的错误布局（app/src/src）会残留进新包
rm -rf "$STAGE/app"
mkdir -p "$STAGE/app/src" "$STAGE/app/web"
# 拷目录「内容」而不是目录本身：直接 cp -a src 会变成 app/src/src/agent_studio，
# 而启动脚本按 PYTHONPATH=app/src 找模块 → 找不到，包起不来（本地打的包踩过）
cp -a "$REPO/src/." "$STAGE/app/src/"
mkdir -p "$STAGE/app/web"
cp -a "$REPO/web/out" "$STAGE/app/web/out"
[ -f "$STAGE/app/web/out/index.html" ] || { echo "缺少前端产物 web/out（先在 web/ 跑 npm run build）"; exit 1; }

echo "[4/6] 依赖集（按架构下载 wheel 并展开）"
REQ="$STAGE/requirements-lock.txt"
[ -f "$REQ" ] || cp "$REPO/requirements-lock.txt" "$REQ" 2>/dev/null || {
  echo "缺少 requirements-lock.txt（用 .venv 导出：python3 -m pip freeze --path .venv/lib/python3.13/site-packages）"; exit 1; }
SP="$STAGE/vendor/$DIR_ARCH/site-packages"
if [ ! -d "$SP" ]; then
  mkdir -p "$SP"
  PYBIN="$STAGE/runtime/$DIR_ARCH/python/bin/python3"
  HOST_ARCH="$(uname -m)"; [ "$HOST_ARCH" = "arm64" ] && HOST_ARCH="aarch64"
  if [ "$DIR_ARCH" = "$HOST_ARCH" ]; then
    # 本机构建：装进 vendor，但强制按低 glibc 平台挑 wheel。
    # 不钉平台的话，在新系统（如 glibc 2.41 的 Debian 13）上 pip 会挑"兼容里最新"的 wheel
    # （cryptography 就带 manylinux_2_34 那份），产物的 glibc 门槛被悄悄抬到 2.34，
    # 在 Rocky 8/CentOS 8（glibc 2.28）上直接起不来。
    # 注意：跨平台模式不会自动接受更低标签，必须把 2014/2_17/2_24/2_28 都列出来。
    PLAT_ARGS=(); for p in "${PLATS[@]}"; do PLAT_ARGS+=(--platform "$p"); done
    "$PYBIN" -m pip install -q --no-warn-script-location --only-binary=:all: \
      "${PLAT_ARGS[@]}" \
      --target "$SP" -r "$REQ"
  else
    # 交叉构建：只下载该架构 wheel，再解包（不执行）
    WL="$WORK/wheels-$ARCH"; mkdir -p "$WL"
    PLAT_ARGS=(); for p in "${PLATS[@]}"; do PLAT_ARGS+=(--platform "$p"); done
    python3 -m pip download -q --only-binary=:all: \
      "${PLAT_ARGS[@]}" \
      --python-version 3.13 --implementation cp --abi cp313 \
      -d "$WL" -r "$REQ"
    # .dylib 也要收（macOS 有些包把共享库单独放）
    for w in "$WL"/*.whl; do
      unzip -qo "$w" -d "$SP" '*.py' '*.so' '*.dylib' '*.dist-info/*' '*.data/*' 2>/dev/null || true
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
