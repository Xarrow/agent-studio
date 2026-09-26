"""把已有的密钥密文从旧主密钥迁到新主密钥（主密钥轮换）。

为什么要这个脚本
----------------
``secret`` 表里的 LLM key、``data/database.json`` 里的库密码，都是用**主密钥**
加密的。主密钥换了（从开发默认值换成真钥匙），旧密文就解不开了 ——
没有这个脚本，用户面对的是"密钥全部失效、只能重新填一遍"。
有它，就是一条命令的事。

怎么用（典型场景：从写死的开发默认值迁到自己生成的真钥匙）
----------------------------------------------------------
    # 1) 生成一把真钥匙，写进 systemd drop-in（Environment=STUDIO_MASTER_KEY=...）
    # 2) 先备份库：sqlite3 data/studio.db ".backup data/studio.db.pre-rotate"
    # 3) 迁移（**用新钥匙作环境**，旧钥匙显式告知）：
    STUDIO_MASTER_KEY=<新钥匙> uv run python scripts/rotate_master_key.py \
        --old-key agent-studio-dev-master-key
    # 4) 重启 api（改后端/环境 → 必须重启）

安全约定
--------
* 只处理**能解开**的密文；解不开的（不是旧钥匙加的）跳过并计数，**不静默丢数据**。
* 全程不改明文、不改任何业务字段，只把 ``ciphertext`` 换成新钥匙版本。
* 不打印任何密钥内容（只打印条数与指纹）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

#: 与 security.crypto 一致的派生方式（sha256 → urlsafe base64）
DEV_KEY = "agent-studio-dev-master-key"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "studio.db"
DB_CONFIG = ROOT / "data" / "database.json"


def fernet_of(raw: str) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest()))


def fingerprint(raw: str) -> str:
    """只暴露指纹（前 8 位），日志里能核对"是不是这把"，但不泄漏密钥本身。"""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]


def rotate_blob(old: Fernet, new: Fernet, blob: bytes) -> tuple[bytes | None, str]:
    """返回 (新密文 | None, 说明)。解不开就返回 None —— 交给调用方计数，不丢数据。"""
    try:
        plain = old.decrypt(blob)
    except InvalidToken:
        try:
            new.decrypt(blob)
            return blob, "already"      # 已经是新钥匙加的，不用动
        except InvalidToken:
            return None, "undecryptable"
    return new.encrypt(plain), "rotated"


def main() -> int:
    ap = argparse.ArgumentParser(description="主密钥轮换：把已有密文迁到新主密钥")
    ap.add_argument("--old-key", default=DEV_KEY, help="旧主密钥（默认：开发默认值）")
    ap.add_argument("--new-key", default="", help="新主密钥（默认取环境变量 STUDIO_MASTER_KEY）")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="SQLite 库路径")
    ap.add_argument("--dry-run", action="store_true", help="只看会改几条，不落盘")
    args = ap.parse_args()

    import os

    new_raw = args.new_key or os.environ.get("STUDIO_MASTER_KEY", "").strip()
    if not new_raw:
        print("✗ 没有新主密钥：用 --new-key 给，或先设环境变量 STUDIO_MASTER_KEY", file=sys.stderr)
        return 2
    if new_raw == args.old_key:
        print("✗ 新旧主密钥相同，没什么可换的", file=sys.stderr)
        return 2

    old, new = fernet_of(args.old_key), fernet_of(new_raw)
    print(f"旧钥匙指纹 {fingerprint(args.old_key)} → 新钥匙指纹 {fingerprint(new_raw)}"
          f"{'（dry-run）' if args.dry_run else ''}")

    changed = already = bad = 0

    # ① secret 表（LLM 凭据）
    db = Path(args.db)
    if db.exists():
        conn = sqlite3.connect(db)
        rows = conn.execute("SELECT id, ciphertext FROM secret").fetchall()
        for sid, blob in rows:
            out, how = rotate_blob(old, new, bytes(blob))
            if how == "rotated":
                if not args.dry_run:
                    conn.execute("UPDATE secret SET ciphertext = ? WHERE id = ?", (out, sid))
                changed += 1
            elif how == "already":
                already += 1
            else:
                bad += 1
                print(f"  ⚠ {sid} 两边都解不开（跳过，未改动）")
        if not args.dry_run:
            conn.commit()
        conn.close()
        print(f"secret 表：待迁移 {len(rows)} 条 → 已换 {changed}，已是新钥匙 {already}，解不开 {bad}")
    else:
        print(f"（跳过）没有这个库：{db}")

    # ② data/database.json 里的库密码（网络库才有；SQLite 为空）
    if DB_CONFIG.exists():
        raw = json.loads(DB_CONFIG.read_text(encoding="utf-8"))
        enc = str(raw.get("password_enc") or "")
        if enc:
            out, how = rotate_blob(old, new, base64.b64decode(enc.encode("ascii")))
            if how == "rotated":
                raw["password_enc"] = base64.b64encode(out).decode("ascii")
                if not args.dry_run:
                    DB_CONFIG.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
                print("database.json：库密码已换新钥匙")
            else:
                print(f"database.json：{how}（未改动）")
        else:
            print("database.json：没有加密字段（SQLite 连接不需要密码）")

    if args.dry_run:
        print("dry-run：什么都没写")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
