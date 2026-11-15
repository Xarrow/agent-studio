"""文档解析：把原始件变成可检索的文本分块。

设计口径
========
* 解析在**入库之后异步做**（上传 1 秒内列表可见），失败落 `status=failed` 并给可操作原因。
* 分块按"语义单位"切：PDF 按页、XLSX 按 sheet、MD/TXT/HTML 按段落（带长度上限）。
* 只依赖仓库里已装的库：pypdf / python-docx / openpyxl / python-pptx；HTML 用标准库解析。
  扫描件（图片型 PDF）不在这里 OCR —— 没有 OCR 时如实报错，别假装解析成功。
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

#: 单块目标长度（字符）。太小检索碎片化，太大把上下文撑爆。
CHUNK_CHARS = 1800
#: 单篇最多保留多少分块（防超大文档把库与上下文撑坏）
MAX_CHUNKS = 4000

PARSER_VERSION = "1"


@dataclass
class ParsedDoc:
    chunks: list[dict[str, Any]] = field(default_factory=list)
    text_length: int = 0
    pages: int | None = None
    sheets: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def summary(self, ms: int) -> dict[str, Any]:
        return {
            "textLength": self.text_length,
            "pages": self.pages,
            "sheets": self.sheets,
            "parserVersion": PARSER_VERSION,
            "ms": ms,
            "chunks": len(self.chunks),
        }


class ParseError(RuntimeError):
    """带人话原因的解析失败（页面上直接显示）。"""


def detect_kind(filename: str, mime: str = "", head: bytes = b"") -> str:
    """先看扩展名，再看魔数（防"改后缀"骗过白名单）。"""
    ext = Path(filename or "").suffix.lower().lstrip(".")
    magic = {
        b"%PDF": "pdf",
        b"PK\x03\x04": "zip",  # docx/xlsx/pptx 都是 zip
        b"\x89PNG": "image",
        b"\xff\xd8\xff": "image",
        b"GIF8": "image",
    }
    head_kind = next((k for sig, k in magic.items() if head.startswith(sig)), "")
    if ext in ("pdf",):
        return "pdf"
    if head_kind == "pdf":
        return "pdf"
    if ext in ("docx", "xlsx", "xlsm", "pptx", "md", "markdown", "txt", "html", "htm", "csv"):
        return "md" if ext in ("md", "markdown") else ("html" if ext in ("html", "htm") else ("xlsx" if ext in ("xlsx", "xlsm") else ext))
    if ext in ("png", "jpg", "jpeg", "gif", "webp", "bmp"):
        return "image"
    if head_kind == "zip" and not ext:
        return "zip"
    return ext or "bin"


def _split(text: str, *, page: int | None = None, sheet: str = "") -> list[dict[str, Any]]:
    """按空行分段，再按长度合并/切分到 CHUNK_CHARS 左右。"""
    text = re.sub(r"\r\n?", "\n", text or "").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    out: list[dict[str, Any]] = []
    buf = ""
    for p in paras:
        if len(p) > CHUNK_CHARS:
            if buf:
                out.append({"text": buf, "page": page, "sheet": sheet})
                buf = ""
            for i in range(0, len(p), CHUNK_CHARS):
                out.append({"text": p[i : i + CHUNK_CHARS], "page": page, "sheet": sheet})
            continue
        if len(buf) + len(p) + 1 <= CHUNK_CHARS:
            buf = f"{buf}\n\n{p}" if buf else p
        else:
            out.append({"text": buf, "page": page, "sheet": sheet})
            buf = p
    if buf:
        out.append({"text": buf, "page": page, "sheet": sheet})
    return out[:MAX_CHUNKS]


class _TextExtract(HTMLParser):
    """极简正文提取：去掉 script/style，块级标签换行。"""

    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip())

    def text(self) -> str:
        raw = " ".join(self.parts)
        raw = re.sub(r"[ \t]+", " ", raw)
        return re.sub(r"\n{3,}", "\n\n", raw).strip()


def parse_bytes(kind: str, data: bytes, filename: str = "") -> ParsedDoc:
    if kind == "pdf":
        return _parse_pdf(data)
    if kind == "docx":
        return _parse_docx(data)
    if kind == "xlsx":
        return _parse_xlsx(data)
    if kind == "pptx":
        return _parse_pptx(data)
    if kind in ("md", "txt", "csv"):
        text = data.decode("utf-8", errors="replace")
        chunks = _split(text)
        return ParsedDoc(chunks=chunks, text_length=len(text))
    if kind == "html":
        p = _TextExtract()
        p.feed(data.decode("utf-8", errors="replace"))
        text = p.text()
        return ParsedDoc(chunks=_split(text), text_length=len(text))
    if kind == "image":
        raise ParseError("图片需要 OCR 才能取文本；本期未启用 OCR（可直接下载原件查看）")
    raise ParseError(f"暂不支持解析这种类型：{kind or filename or '未知'}")


def _parse_pdf(data: bytes) -> ParsedDoc:
    try:
        from pypdf import PdfReader
    except Exception as exc:  # pragma: no cover
        raise ParseError("缺少 PDF 解析库（pypdf）") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise ParseError(f"PDF 打不开（可能加密或损坏）：{exc}") from exc
    chunks: list[dict[str, Any]] = []
    total = 0
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        total += len(text)
        chunks.extend(_split(text, page=i))
    if not chunks:
        raise ParseError("PDF 里没有可提取的文字（很可能是扫描件，需要 OCR）")
    return ParsedDoc(chunks=chunks, text_length=total, pages=len(reader.pages))


def _parse_docx(data: bytes) -> ParsedDoc:
    try:
        import docx  # python-docx
    except Exception as exc:  # pragma: no cover
        raise ParseError("缺少 DOCX 解析库（python-docx）") from exc
    try:
        d = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ParseError(f"DOCX 打不开：{exc}") from exc
    parts = [p.text for p in d.paragraphs if p.text.strip()]
    for t in d.tables:
        for row in t.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    text = "\n\n".join(parts)
    return ParsedDoc(chunks=_split(text), text_length=len(text))


def _parse_xlsx(data: bytes) -> ParsedDoc:
    try:
        import openpyxl
    except Exception as exc:  # pragma: no cover
        raise ParseError("缺少 XLSX 解析库（openpyxl）") from exc
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:
        raise ParseError(f"表格打不开：{exc}") from exc
    chunks: list[dict[str, Any]] = []
    total = 0
    sheets = []
    for ws in wb.worksheets:
        sheets.append(ws.title)
        lines = []
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v) for v in row]
            if any(c.strip() for c in cells):
                lines.append(" | ".join(cells).rstrip(" |"))
            if len(lines) >= 400:  # 一个 sheet 太多行就断块，避免单块过大
                text = "\n".join(lines)
                total += len(text)
                chunks.extend(_split(text, sheet=ws.title))
                lines = []
        if lines:
            text = "\n".join(lines)
            total += len(text)
            chunks.extend(_split(text, sheet=ws.title))
    if not chunks:
        raise ParseError("表格里没有内容")
    return ParsedDoc(chunks=chunks, text_length=total, sheets=sheets)


def _parse_pptx(data: bytes) -> ParsedDoc:
    try:
        from pptx import Presentation
    except Exception as exc:  # pragma: no cover
        raise ParseError("缺少 PPTX 解析库（python-pptx）") from exc
    try:
        prs = Presentation(io.BytesIO(data))
    except Exception as exc:
        raise ParseError(f"PPTX 打不开：{exc}") from exc
    chunks: list[dict[str, Any]] = []
    total = 0
    for i, slide in enumerate(prs.slides, start=1):
        parts = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                t = shape.text_frame.text.strip()
                if t:
                    parts.append(t)
        text = "\n".join(parts)
        total += len(text)
        chunks.extend(_split(text, page=i))
    if not chunks:
        raise ParseError("PPTX 里没有可提取的文字")
    return ParsedDoc(chunks=chunks, text_length=total, pages=len(prs.slides))
