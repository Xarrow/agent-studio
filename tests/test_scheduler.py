"""护栏：定时（自动运行）的"下次什么时候跑"必须算对。

这是整个无人值守里**最容易算错、也最贵**的一环：算早了会重复跑、算晚了会漏跑，
而且错了以后在界面上只表现为"它没按我设的时间跑"，很难查。
所以 compute_next 刻意写成**纯函数**（不碰库、不取当前时间）—— 就为了能被这里钉死。
"""

from __future__ import annotations

import datetime as _dt

from agent_studio.scheduler import compute_next, describe, parse_at, parse_weekdays

# 2026-09-26 是**周六**（写死日期，避免测试跟着"今天"漂）
SAT = _dt.datetime(2026, 9, 26, 12, 0)


def ts(dt: _dt.datetime) -> int:
    return int(dt.timestamp() * 1000)


def at(y, m, d, hh, mm):
    return ts(_dt.datetime(y, m, d, hh, mm))


# ── 每小时 ─────────────────────────────────────────────────────────────────
def test_hourly_lands_on_next_hour():
    now = ts(_dt.datetime(2026, 9, 26, 12, 34, 56))
    assert compute_next("hourly", now=now) == ts(_dt.datetime(2026, 9, 26, 13, 0))
    # 正好整点 → 去下一个整点（不是"现在"，否则会立刻又跑一次）
    on_hour = ts(_dt.datetime(2026, 9, 26, 12, 0))
    assert compute_next("hourly", now=on_hour) == ts(_dt.datetime(2026, 9, 26, 13, 0))


# ── 每天 ───────────────────────────────────────────────────────────────────
def test_daily_before_time_is_today():
    assert compute_next("daily", "09:00", now=ts(_dt.datetime(2026, 9, 26, 8, 0))) == at(2026, 9, 26, 9, 0)


def test_daily_after_time_is_tomorrow():
    assert compute_next("daily", "09:00", now=ts(_dt.datetime(2026, 9, 26, 9, 30))) == at(2026, 9, 27, 9, 0)


def test_daily_exact_moment_moves_to_tomorrow():
    """正好等于设定时刻 → 排到明天（避免同一个时刻被反复触发）。"""
    assert compute_next("daily", "09:00", now=at(2026, 9, 26, 9, 0)) == at(2026, 9, 27, 9, 0)


# ── 每周 ───────────────────────────────────────────────────────────────────
def test_weekly_picks_next_selected_weekday():
    # 周六 12:00，要求周一/周三 09:00 → 下周一
    assert compute_next("weekly", "09:00", "1,3", now=ts(SAT)) == at(2026, 9, 28, 9, 0)


def test_weekly_same_day_later_time_is_today():
    # 周六 12:00，要求周六 20:00 → 今天 20:00（当天还没到就得跑）
    assert compute_next("weekly", "20:00", "6", now=ts(SAT)) == at(2026, 9, 26, 20, 0)


def test_weekly_same_day_passed_time_goes_next_week():
    # 周六 12:00，要求周六 09:00（已过）→ 下周六 09:00
    assert compute_next("weekly", "09:00", "6", now=ts(SAT)) == at(2026, 10, 3, 9, 0)


# ── 默认值 / 脏输入（永远不能把调度搞挂）──────────────────────────────────
def test_unknown_mode_means_off():
    assert compute_next("", now=ts(SAT)) is None
    assert compute_next(None, now=ts(SAT)) is None
    assert compute_next("weekly,每小时", now=ts(SAT)) is None
    assert compute_next("DAILY", "09:00", now=ts(_dt.datetime(2026, 9, 26, 8, 0))) == at(2026, 9, 26, 9, 0), "大小写不该影响"


def test_parse_at_falls_back_to_default():
    assert parse_at("07:30") == (7, 30)
    assert parse_at("7:5") == (7, 5)
    assert parse_at("25:00") == (9, 0)
    assert parse_at("九点") == (9, 0)
    assert parse_at(None) == (9, 0)


def test_parse_weekdays_falls_back_to_monday():
    assert parse_weekdays("1,3,5") == [1, 3, 5]
    assert parse_weekdays("6,6,2") == [2, 6], "去重且排序"
    assert parse_weekdays("9,abc,") == [1], "全是脏值 → 默认周一（不是空跑）"
    assert parse_weekdays("") == [1]


def test_describe_is_human_readable():
    """界面直接显示这句话 —— 不能把枚举值甩给用户。"""
    assert describe("", None, None) == "不定时"
    assert describe("hourly", None, None) == "每小时一次"
    assert describe("daily", "09:05", None) == "每天 09:05"
    assert describe("weekly", "08:00", "1,3") == "每周 周一、周三 08:00"
