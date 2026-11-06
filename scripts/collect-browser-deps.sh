#!/usr/bin/env bash
# 把某个浏览器需要的系统共享库整包收下来（给"全新机器、没有 root、不联网"那条路用）。
#
# 为什么需要它
# ------------
# Chromium 本体是自带的，但它动态链接十几个系统库（libnss3 / libnspr4 / libgbm …）。
# 干净机器上缺这些库，浏览器一启动就死在 "error while loading shared libraries"。
# 两条自救路线：
#   ① 装系统包（要 root）：页面上的「装系统依赖」按钮 / apt-get install …
#   ② 把库随包带过来（不要 root）：本脚本收库 → 运行时 LD_LIBRARY_PATH 指过去
#
# 用法
#   scripts/collect-browser-deps.sh <chrome可执行文件> [目标目录]
#   默认目标：<repo>/dist/browser-deps/lib
#
# 注意：**绝不打包 glibc 本体**（libc/libm/libpthread/ld-linux …）。用 LD_LIBRARY_PATH
# 顶替 glibc 会让进程以五花八门的方式崩掉，这不是"兼容性更好"，是把问题推迟到运行时。
set -euo pipefail

BIN=${1:-}
DEST=${2:-}
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "用法: $0 <chrome可执行文件> [目标目录]" >&2
  exit 2
fi
if [ -z "$DEST" ]; then
  DEST="$(cd "$(dirname "$0")/.." && pwd)/dist/browser-deps/lib"
fi

mkdir -p "$DEST"

# glibc 核心库黑名单（见文件头的理由）
is_glibc() {
  case "$(basename "$1")" in
    libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libresolv.so.*|ld-linux*|libutil.so.*) return 0 ;;
    *) return 1 ;;
  esac
}

copied=0
skip_glibc=0
while IFS= read -r line; do
  # ldd 输出形如:  libnss3.so => /usr/lib/x86_64-linux-gnu/libnss3.so (0x00007f...)
  case "$line" in
    *"=>"*)
      src=$(printf '%s' "$line" | sed 's/.*=> //; s/ (0x[0-9a-f]*)$//')
      ;;
    /*)
      src=$(printf '%s' "$line" | sed 's/ (0x[0-9a-f]*)$//')
      ;;
    *) continue ;;
  esac
  [ -f "$src" ] || continue
  if is_glibc "$src"; then
    skip_glibc=$((skip_glibc + 1))
    continue
  fi
  # 保留真实文件 + soname 软链（Chrome 按 soname 找，缺软链等于没拷）
  cp -L "$src" "$DEST/$(basename "$src")" 2>/dev/null || true
  base=$(basename "$src")
  real=$(readlink -f "$src")
  if [ "$(basename "$real")" != "$base" ] && [ -f "$real" ]; then
    cp -L "$real" "$DEST/$(basename "$real")" 2>/dev/null || true
  fi
  # ldd 里出现过的名字（可能是 soname）也建个软链，双重保险
  name=$(printf '%s' "$line" | awk '{print $1}')
  if [ -n "$name" ] && [ ! -e "$DEST/$name" ]; then
    ln -sf "$base" "$DEST/$name" 2>/dev/null || true
  fi
  copied=$((copied + 1))
done < <(ldd "$BIN" 2>/dev/null)

echo "收到 $DEST：$copied 个库（跳过 glibc 核心库 $skip_glibc 个）"

# NSS/NSPR 的坑：libnss3 只是入口，真正干活的是它 **dlopen** 的同伴库
# （libsoftokn3 / libfreebl3 / libplc4 / libplds4 / libnssckbi …）。
# 这些不在 ldd 输出里，但缺一个 Chrome 就会在启动时报
# ``FATAL:crypto/nss_util.cc nss_error=-5925`` 然后 SIGABRT —— 看起来像"库拷了但没用"。
# 所以按 libnss3/libnspr4 所在的目录，把整套 NSS 家族一起收。
SYS_LIB_DIR=$(ldd "$BIN" 2>/dev/null | awk '/libnss3\.so/ {print $3}' | head -1 | xargs -r dirname)
if [ -n "${SYS_LIB_DIR:-}" ] && [ -d "$SYS_LIB_DIR" ]; then
  n=0
  for pat in 'libnss3.so*' 'libnssutil3.so*' 'libsmime3.so*' 'libssl3.so*' 'libnspr4.so*' \
             'libplc4.so*' 'libplds4.so*' 'libsoftokn3.so*' 'libfreebl3.so*' 'libfreeblpriv3.so*' \
             'libnssckbi.so*' 'libnssdbm3.so*'; do
    for f in "$SYS_LIB_DIR"/$pat; do
      [ -e "$f" ] || continue
      cp -L "$f" "$DEST/$(basename "$f")" 2>/dev/null && n=$((n + 1))
    done
  done
  echo "补收 NSS/NSPR 家族：$n 个文件（ldd 看不到，但缺了就起不来）"
fi

du -sh "$DEST" | awk '{print "体积:", $1}'

# 自检：把系统库遮住也能跑吗（在有 root 的机器上才有意义，这里只做存在性检查）
missing=$(ldd "$BIN" 2>/dev/null | grep -c "not found" || true)
echo "这个二进制当前缺库数：$missing（0 = 本机自带就够）"
