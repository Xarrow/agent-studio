#!/usr/bin/env bash
# ============================================================================
#  在指定环境里验证离线包：可原生跑，也可丢进容器跑（覆盖不同发行版/glibc）
#
#  用法：
#    verify-in-env.sh <包>                            # 当前环境原生全量验证
#    verify-in-env.sh <包> --image debian:12          # 容器里全量验证
#    verify-in-env.sh <包> --image rockylinux:8 --expect-blocked
#        # 反向验收：期望启动脚本把这个过旧的系统拦下（交给 check-version-guard.sh）
# ============================================================================
set -uo pipefail

TAR="${1:?用法: verify-in-env.sh <包> [--image 镜像] [--expect-blocked]}"
shift
IMAGE=""
EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --expect-blocked) EXPECT=1; shift ;;
    *) shift ;;
  esac
done

TAR_ABS="$(readlink -f "$TAR")"

# ---------- 反向验收：最小流程，容不下任何联网安装 ----------
if [ -n "$EXPECT" ]; then
  echo "[i] 反向验收：期望过旧的系统被版本守卫拦下"
  if [ -n "$IMAGE" ]; then
    docker run --rm -v "$TAR_ABS:/pkg.tar.gz:ro" -v "$PWD:/w" -w /w "$IMAGE" \
      bash /w/scripts/check-version-guard.sh /pkg.tar.gz
  else
    bash "$(dirname "$0")/check-version-guard.sh" "$TAR_ABS"
  fi
  exit $?
fi

# ---------- 全量验证 ----------
docker_prepare='
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq 2>/dev/null || true
  command -v curl  >/dev/null || apt-get install -y -qq curl   >/dev/null 2>&1 || true
  command -v gzip  >/dev/null || apt-get install -y -qq gzip   >/dev/null 2>&1 || true
  command -v pgrep >/dev/null || apt-get install -y -qq procps >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  command -v gzip  >/dev/null || dnf install -y -q gzip       >/dev/null 2>&1 || true
  command -v pgrep >/dev/null || dnf install -y -q procps-ng  >/dev/null 2>&1 || true
elif command -v microdnf >/dev/null 2>&1; then
  command -v gzip  >/dev/null || microdnf install -y gzip      >/dev/null 2>&1 || true
  command -v pgrep >/dev/null || microdnf install -y procps-ng >/dev/null 2>&1 || true
fi
'

if [ -n "$IMAGE" ]; then
  echo "[i] 进入容器验证：$IMAGE"
  docker run --rm -v "$PWD:/w" -w /w "$IMAGE" bash -c "
    $docker_prepare
    echo \"[i] 环境：\$(. /etc/os-release 2>/dev/null && echo \"\$PRETTY_NAME\") / \$(uname -m)\"
    echo \"[i] 工具：curl=\$(command -v curl || echo 无) gzip=\$(command -v gzip || echo 无) pgrep=\$(command -v pgrep || echo 无)\"
    command -v curl >/dev/null || { echo '::error::容器内没有 curl，装不上（可能是该发行版软件源已归档），无法做全量验证'; exit 2; }
    bash scripts/verify-bundle.sh '$TAR' 8848
  "
else
  echo "[i] 当前环境原生验证"
  bash scripts/verify-bundle.sh "$TAR_ABS" 8848
fi
