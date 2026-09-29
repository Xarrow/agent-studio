#!/usr/bin/env bash
# ============================================================================
#  在指定环境里验证离线包：可原生跑，也可丢进容器跑（覆盖不同发行版/glibc）
#
#  用法：
#    verify-in-env.sh <包路径>                                  # 在当前环境原生验证
#    verify-in-env.sh <包路径> --image debian:12                # 在容器里验证
#    verify-in-env.sh <包路径> --image debian:11 --expect-blocked
#        # 旧系统（glibc < 2.34）预期被启动脚本拦下：跑通=失败，被拦下且给出
#        # glibc 提示=通过。这样"能否拦住"也变成可自动验收的一项。
# ============================================================================
set -uo pipefail

TAR="${1:?用法: verify-in-env.sh <包路径> [--image 镜像] [--expect-blocked]}"
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

run_in_env() {
  if [ -n "$IMAGE" ]; then
    echo "[i] 进入容器验证：$IMAGE"
    docker run --rm -v "$PWD:/w" -w /w "$IMAGE" bash -c '
      set -e
      # 只装缺的工具，避免跟镜像自带包冲突（如 rocky 的 curl-minimal）
      if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        command -v curl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl
        command -v gzip >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gzip
        command -v pgrep >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps
      elif command -v dnf >/dev/null 2>&1; then
        command -v gzip >/dev/null || dnf install -y -q gzip
        command -v pgrep >/dev/null || dnf install -y -q procps-ng
      elif command -v microdnf >/dev/null 2>&1; then
        command -v gzip >/dev/null || microdnf install -y gzip
        command -v pgrep >/dev/null || microdnf install -y procps-ng
      fi
      echo "[i] 容器环境：$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") / $(uname -m)"
      bash scripts/verify-bundle.sh "/w/'"$TAR"'" 8848
    '
  else
    echo "[i] 当前环境原生验证：$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") / $(uname -m)"
    bash scripts/verify-bundle.sh "$TAR" 8848
  fi
}

if [ -n "$EXPECT" ]; then
  set +e
  OUT="$(run_in_env 2>&1)"
  RC=$?
  set -e
  printf '%s\n' "$OUT"
  if [ "$RC" -eq 0 ]; then
    echo "::error::预期该环境应被拦下，结果却跑通了 —— 版本守卫失效"
    exit 1
  fi
  if ! printf '%s\n' "$OUT" | grep -qi 'glibc'; then
    echo "::error::确实失败了，但原因不是 glibc 版本守卫（见上方输出）"
    exit 1
  fi
  echo "✅ 旧系统被正确拦下，且给出的是人话提示（不是难懂的动态链接报错）"
  exit 0
fi

run_in_env
