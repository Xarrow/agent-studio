"""路由判定：四层 + 打分。纯函数，不碰库。

这些断言都是"用户会真的遇到的话"：写规则的人想的是「这样写就一定会分给它」，
而真实的话不会照着你写的样子说 —— 所以每条规则都要拿一句"像是人说的"去撞。
"""

from __future__ import annotations

from agent_studio.router import Candidate, Rule, route, score_candidates


def C(agent_id: str, name: str, desc: str = "", tags: tuple[str, ...] = ()) -> Candidate:
    return Candidate(agent_id=agent_id, name=name, description=desc, tags=tags)


CANDS = [
    C("ag_code", "编程助手", "写代码、改 bug、跑测试", ("bash", "write")),
    C("ag_report", "周报助手", "把一周的工作整理成周报", ("summary",)),
    C("ag_video", "视频下载助手", "下载抖音/YouTube 视频并归档", ("yt-dlp",)),
]


def test_L0_指名了就不猜():
    d = route("随便一句话", candidates=CANDS, explicit_agent_id="ag_report")
    assert d.agent_id == "ag_report"
    assert d.layer == 0 and d.confidence == "explicit"


def test_L1_规则命中压过内容打分():
    # 话里明明满是"代码"，但规则说这段归周报 —— 规则是用户写的，得算数
    rules = [Rule(agent_id="ag_report", pattern="代码评审结论")]
    d = route("把这次代码评审结论写进周报", candidates=CANDS, rules=rules)
    assert d.layer == 1
    assert d.agent_id == "ag_report"
    assert "代码评审结论" in d.reason


def test_L1_多条命中时按优先级和具体程度取():
    rules = [
        Rule(agent_id="ag_video", pattern="视频", priority=50),
        Rule(agent_id="ag_video", pattern="抖音视频", priority=50),
        Rule(agent_id="ag_code", pattern="脚本", priority=10),
    ]
    d = route("帮我写个脚本下载抖音视频", candidates=CANDS, rules=rules)
    # priority 10 的先
    assert d.agent_id == "ag_code"
    # 同优先级下更长的模式更具体
    rules2 = [Rule(agent_id="ag_video", pattern="视频", priority=50), Rule(agent_id="ag_report", pattern="抖音视频", priority=50)]
    d2 = route("帮我下载抖音视频", candidates=CANDS, rules=rules2)
    assert d2.agent_id == "ag_report"


def test_L1_指向不存在助手的规则等于没写():
    rules = [Rule(agent_id="ag_gone", pattern="视频")]
    d = route("下载视频", candidates=CANDS, rules=rules)
    assert d.layer != 1


def test_L2_名字命中就敢派():
    d = route("帮我写点代码，跑一下测试", candidates=CANDS)
    assert d.layer == 2
    assert d.agent_id == "ag_code"
    assert d.confidence == "high"
    assert "编程助手" in d.reason or "名字" in d.reason


def test_L2_只是擦边就低置信_要问人():
    # 只命中描述里的一个词（1 分），不该自作主张
    d = route("整理一下这周的会议纪要", candidates=CANDS)
    assert d.confidence in ("low", "unknown")
    assert d.agent_id is None, "分不够就别派，问一句比派错便宜"


def test_L2_同分也不猜():
    # 两位助手的描述一样，话只能从描述上认出这类活 —— 分不开就别派
    same = [
        C("a1", "甲助手", "处理表格数据"),
        C("a2", "乙助手", "处理表格数据"),
    ]
    d = route("帮我处理表格数据", candidates=same)
    assert d.confidence == "low"
    assert d.agent_id is None
    assert "同分" in d.reason


def test_L3_没有候选认得_用当前对话的助手():
    d = route("今天天气怎么样", candidates=CANDS, default_agent_id="ag_report")
    assert d.layer == 3
    assert d.agent_id == "ag_report"
    assert d.confidence == "fallback"


def test_L3_只有一个助手就用它():
    only = [C("solo", "万能助手", "什么都能干")]
    d = route("任意的话", candidates=only)
    assert d.layer == 3 and d.agent_id == "solo"


def test_L3_多候选且都不认得_不猜():
    d = route("今天天气怎么样", candidates=CANDS)
    assert d.agent_id is None
    assert d.confidence == "unknown"
    assert d.alternatives, "至少要把候选摆出来让人选"


def test_英文按词边界_go不该命中google():
    cands = [C("x", "go helper", "go build tools")]
    d = route("please google it", candidates=cands)
    assert d.score == 0, "go 不能因为出现在 google 里就算命中"


def test_中文按子串_财报能在句子里命中():
    cands = [C("fin", "财报助手", "")]
    d = route("帮我看一下这季度的财报", candidates=cands)
    assert d.agent_id == "fin"
    assert d.score >= 3


def test_打分是可解释的_每个加分都写了为什么():
    rows = score_candidates("写代码 跑测试", CANDS)
    top = rows[0]
    assert top["agent_id"] == "ag_code"
    assert top["why"], "加分必须有出处，否则界面只能说'它更合适'"
    assert all("「" in w for w in top["why"])


def test_停用词不会把所有助手都拉进来():
    cands = [C("a1", "助手A", "帮我处理各种任务")]
    d = route("帮我处理一下", candidates=cands)
    # "帮我" 是停用词；不该因此把 a1 判成 high
    assert d.confidence != "high"


def test_空输入不崩():
    d = route("", candidates=CANDS)
    assert d.agent_id is None or d.confidence == "fallback"


def test_规则中间多一个的也能命中():
    """用户写「季度复盘」，嘴里说的是「这季度的复盘」——命不中就会被判"我明明写了"。"""
    rules = [Rule(agent_id="ag_report", pattern="季度复盘", priority=20)]
    d = route("帮我把这季度的复盘写成一页纸", candidates=CANDS, rules=rules)
    assert d.layer == 1
    assert d.agent_id == "ag_report"


def test_放宽不该把不相干的话也认成命中():
    rules = [Rule(agent_id="ag_report", pattern="季度复盘")]
    d = route("把这周的会议纪要整理一下", candidates=CANDS, rules=rules)
    assert d.layer != 1, "放宽是抹虚词，不是模糊匹配"
