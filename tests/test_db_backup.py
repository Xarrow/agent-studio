"""数据库副本：活库也安全、只留最近几份、别删错东西。

为什么要专门测它（血泪）：库是自托管平台的唯一真相，而副本一直靠"谁想起来谁 cp"，
堆在 data/ 里不轮转 —— 实测被误清过一次，所以现在要求它**自动、可验证、只动自己的文件**。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from agent_studio.maintenance import DB_KEEP, backup_db, db_backups, prune_db_backups


def _make_db(path: Path, rows: int = 3) -> None:
    con = sqlite3.connect(str(path))
    con.execute("create table t(x integer)")
    con.executemany("insert into t values (?)", [(i,) for i in range(rows)])
    con.commit()
    con.close()


def test_backup_is_a_readable_snapshot(tmp_path):
    """副本必须是**能打开的完整库**（不是半写的文件）—— 这才是"能回退"。"""
    db = tmp_path / "studio.db"
    _make_db(db, 5)
    made = backup_db(str(db))
    assert made and Path(made).exists()
    con = sqlite3.connect(made)
    try:
        assert con.execute("select count(*) from t").fetchone()[0] == 5
    finally:
        con.close()


def test_only_keeps_the_newest_few(tmp_path):
    """只留最近 DB_KEEP 份（留太多会把磁盘吃满，反而更危险）。"""
    db = tmp_path / "studio.db"
    _make_db(db)
    made = []
    for _ in range(DB_KEEP + 2):
        # 名字里带秒级时间戳 —— 同一秒内连做几次会撞名，这里塞一下
        import time

        time.sleep(1.05)
        made.append(backup_db(str(db)))
    left = db_backups(str(db))
    assert len(left) == DB_KEEP, f"应当只留 {DB_KEEP} 份：{left}"
    assert left[0] == sorted(made)[-1], "留下的必须是最新的那几份"


def test_prune_never_touches_other_files(tmp_path):
    """轮转**只动我们自己按命名造的副本** —— 别人的文件一个都不许碰。

    （反面教材：清理时用通配把手工备份也扫进去过。）
    """
    db = tmp_path / "studio.db"
    _make_db(db)
    keep_me = tmp_path / "studio.db.pre-masterkey-20260101-000000"
    keep_me.write_text("手写的关键备份", encoding="utf-8")
    plain = tmp_path / "notes.txt"
    plain.write_text("无关文件", encoding="utf-8")

    for _ in range(DB_KEEP + 1):
        import time

        time.sleep(1.05)
        backup_db(str(db))
    # backup_db 自己已按 DB_KEEP 轮转过一次 —— 这里把预算再收紧一档，
    # 逼出一次真删除，看它会不会带走不该带的东西。
    assert len(db_backups(str(db))) == DB_KEEP
    removed = prune_db_backups(str(db), DB_KEEP - 1)
    assert len(removed) == 1
    assert keep_me.exists(), "手工命名的关键备份**绝不能**被轮转带走"
    assert plain.exists()
