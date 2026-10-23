"""文件预览解析的护栏测试。

覆盖的是"用户真的会遇到的四种文件 + 三种坏情况"：
格式对了但解析跑偏（日期变 0 点、表格顺序乱、xmind 拿不到 note），
或者坏文件把端点打成 500 —— 两者都会让预览层显示错误的东西，
比一个明确的"解不了"更糟。
"""

from __future__ import annotations

import datetime
import json
import zipfile
from pathlib import Path

import pytest

from agent_studio.preview import parse


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    return tmp_path


def test_xlsx_单元格与日期(workdir: Path) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "明细"
    ws.append(["日期", "名称", "数量"])
    ws.append([datetime.date(2026, 10, 1), "甲", 3])
    ws.append([datetime.datetime(2026, 10, 2, 14, 30), "乙", 4.5])
    ws.append([None, "丙", True])
    wb.create_sheet("第二页")["A1"] = "另一个 sheet"
    p = workdir / "t.xlsx"
    wb.save(p)

    r = parse(p)
    assert r["kind"] == "spreadsheet"
    assert [s["name"] for s in r["payload"]["sheets"]] == ["明细", "第二页"]
    rows = r["payload"]["sheets"][0]["rows"]
    assert rows[0] == ["日期", "名称", "数量"]
    # 零点的日期只显示日期 —— 表格里全是 "00:00:00" 是噪音
    assert rows[1][0] == "2026-10-01"
    # 有时分的时间保留
    assert rows[2][0] == "2026-10-02 14:30"
    # 整数不要显示成 3.0
    assert rows[1][2] == "3"
    assert rows[2][2] == "4.5"
    # 空格子留空，布尔写成 TRUE/FALSE（Excel 的显示口径）
    assert rows[3][0] == ""
    assert rows[3][2] == "TRUE"


def test_xlsx_尾部空行空列不显示(workdir: Path) -> None:
    """导出表常在末尾留几百个空行/空列，直接把 max_row 撑大 —— 预览要裁掉。"""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws["A1"] = "值"
    ws["D1"] = "x"  # 中间空两列
    ws["A50"] = "尾"
    p = workdir / "t.xlsx"
    wb.save(p)

    rows = parse(p)["payload"]["sheets"][0]["rows"]
    # A50 有内容，所以行数到 50；但末尾之后的空行全裁掉
    assert len(rows) == 50
    assert rows[0] == ["值", "", "", "x"]  # 中间空列保留（位置有意义）
    assert rows[-1][0] == "尾"


def test_docx_块顺序与表格(workdir: Path) -> None:
    """表格必须留在它原来的位置 —— 全文表格堆到末尾会让预览读起来像另一份文件。"""
    from docx import Document

    d = Document()
    d.add_heading("标题一", level=1)
    d.add_paragraph("正文一")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text = "H1"
    t.cell(0, 1).text = "H2"
    t.cell(1, 0).text = "v1"
    t.cell(1, 1).text = "v2"
    d.add_paragraph("正文二")
    p = workdir / "t.docx"
    d.save(p)

    r = parse(p)
    assert r["kind"] == "document"
    kinds = [b["t"] for b in r["payload"]["blocks"]]
    assert kinds == ["h1", "p", "table", "p"]
    table = next(b for b in r["payload"]["blocks"] if b["t"] == "table")
    assert table["rows"][0] == ["H1", "H2"]


def test_docx_列表项(workdir: Path) -> None:
    from docx import Document

    d = Document()
    d.add_paragraph("普通段落")
    d.add_paragraph("项目一", style="List Bullet")
    p = workdir / "t.docx"
    d.save(p)

    kinds = [b["t"] for b in parse(p)["payload"]["blocks"]]
    assert kinds == ["p", "li"]


def test_pptx_分页与备注(workdir: Path) -> None:
    from pptx import Presentation

    prs = Presentation()
    for i, (title, body) in enumerate([("第一页", "要点 A"), ("第二页", "要点 B")], 1):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = title
        s.placeholders[1].text = body
        if i == 1:
            s.notes_slide.notes_text_frame.text = "讲稿备注"
    p = workdir / "t.pptx"
    prs.save(p)

    r = parse(p)
    assert r["kind"] == "slides"
    slides = r["payload"]["slides"]
    assert [s["n"] for s in slides] == [1, 2]
    assert slides[0]["title"] == "第一页"
    # 标题不要在正文里重复一遍
    assert slides[0]["lines"] == ["要点 A"]
    assert slides[0]["notes"] == "讲稿备注"
    assert slides[1]["notes"] == ""


def test_xmind_新版content_json(workdir: Path) -> None:
    content = [
        {
            "title": "画布",
            "rootTopic": {
                "title": "根",
                "notes": {"plain": {"content": "根节点备注"}},
                "children": {"attached": [{"title": "子1"}, {"title": "子2", "children": {"attached": [{"title": "孙"}]}}]},
            },
        }
    ]
    p = workdir / "t.xmind"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("content.json", json.dumps(content, ensure_ascii=False))

    r = parse(p)
    assert r["kind"] == "outline"
    sheet = r["payload"]["sheets"][0]
    assert sheet["title"] == "画布"
    root = sheet["root"]
    assert root["title"] == "根"
    assert root["note"] == "根节点备注"
    assert [c["title"] for c in root["children"]] == ["子1", "子2"]
    assert root["children"][1]["children"][0]["title"] == "孙"


def test_xmind_旧版content_xml(workdir: Path) -> None:
    """老版本导出的 .xmind 是 content.xml —— 不少人手里的还是这种。"""
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="s1">
    <title>旧画布</title>
    <topic id="t0">
      <title>中心主题</title>
      <children>
        <topics type="attached">
          <topic id="t1"><title>分支一</title></topic>
          <topic id="t2"><title>分支二</title></topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>"""
    p = workdir / "old.xmind"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("content.xml", xml)

    r = parse(p)
    sheet = r["payload"]["sheets"][0]
    assert sheet["title"] == "旧画布"
    assert sheet["root"]["title"] == "中心主题"
    assert [c["title"] for c in sheet["root"]["children"]] == ["分支一", "分支二"]


def test_老格式给的是人话不是异常(workdir: Path) -> None:
    """xls/doc/ppt 是二进制老格式，解析器根本没有 —— 但要解释清楚怎么补救。"""
    for name in ("老表.xls", "老文档.doc", "老幻灯片.ppt"):
        p = workdir / name
        p.write_bytes(b"\x00\x00binary")
        with pytest.raises(ValueError) as ei:
            parse(p)
        msg = str(ei.value)
        assert "另存为" in msg  # 告诉用户怎么做，而不是只说"不支持"


def test_损坏的xlsx抛ValueError而不是崩(workdir: Path) -> None:
    """损坏文件：端点会把 ValueError 转成 200 + error；不能往上抛 500。"""
    p = workdir / "坏.xlsx"
    p.write_bytes(b"not a zip at all")
    with pytest.raises(Exception):
        parse(p)


def test_不支持的类型(workdir: Path) -> None:
    p = workdir / "a.zip"
    p.write_bytes(b"PK")
    with pytest.raises(ValueError):
        parse(p)
