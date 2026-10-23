"use client";

/**
 * 文件内容渲染器 —— 对话里点开文件后，按类型画出来。
 *
 * 为什么单独一个文件：FileDialog 已经 700 多行（上传/删除/视频转码/文本取回都在一起），
 * 再塞四类渲染器会失控。这里只放"把结构画出来"这一件事，输入是后端已经解析好的 JSON。
 *
 * 共同口径：
 *  - 只画"能看清里面是什么"，不追求版式还原（Office 预览最容易做砸的就是版式）
 *  - 截断了要明说，不能让用户以为文件就这么点
 *  - 移动端优先：横向溢出由容器自己滚，不撑破弹层
 *  - 不放 hover-only 的交互（手机上没有 hover）
 */

import { useEffect, useMemo, useState } from "react";

/* ───────────────────────── 通用小件 ───────────────────────── */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-2 rounded-[8px] px-2.5 py-1.5 text-[11.5px] leading-relaxed"
      style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
    >
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
      {children}
    </p>
  );
}

/** 表格骨架：粘性表头 + 首列行号。xlsx 与 docx 里的表格都用它，免得两套样式。 */
function Grid({
  rows,
  firstRowIsHeader = true,
}: {
  rows: string[][];
  firstRowIsHeader?: boolean;
}) {
  if (!rows.length) return <Empty>没有内容</Empty>;
  const cols = Math.max(...rows.map((r) => r.length));
  return (
    <div
      className="max-h-[52dvh] overflow-auto rounded-[10px] border"
      style={{ borderColor: "var(--color-border)" }}
    >
      <table className="w-max min-w-full border-collapse text-[12.5px]">
        <tbody>
          {rows.map((row, ri) => {
            const isHead = firstRowIsHeader && ri === 0;
            return (
              <tr key={ri}>
                <th
                  className="sticky left-0 z-[1] w-9 min-w-9 px-1.5 py-1 text-right text-[11px] font-normal tabular-nums"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-muted)",
                    borderBottom: `1px solid var(--color-border)`,
                  }}
                >
                  {ri + 1}
                </th>
                {Array.from({ length: cols }).map((_, ci) => {
                  const v = row[ci] ?? "";
                  return isHead ? (
                    <th
                      key={ci}
                      className="whitespace-nowrap px-2 py-1.5 text-left font-medium"
                      style={{
                        background: "var(--color-surface-2)",
                        borderBottom: `1px solid var(--color-border)`,
                        borderLeft: ci ? `1px solid var(--color-border)` : undefined,
                        minWidth: 64,
                        // 表头跟内容一起横向滚：表格很高时用户往下翻，表头得一直在
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                      }}
                    >
                      {v}
                    </th>
                  ) : (
                    <td
                      key={ci}
                      className="max-w-[260px] truncate px-2 py-1 align-top"
                      title={v.length > 26 ? v : undefined}
                      style={{
                        borderLeft: ci ? `1px solid var(--color-border)` : undefined,
                        // 手机上 390 宽放 6 列会挤成一团：给每列一个下限，让表格自己变宽，
                        // 由容器横向滚动（比把每格都截成 4 个字好读）。
                        minWidth: 64,
                      }}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── 电子表格 ───────────────────────── */

export type SheetData = { name: string; rows: string[][]; totalRows?: number; totalCols?: number };

export function SpreadsheetView({ sheets }: { sheets: SheetData[] }) {
  const [active, setActive] = useState(0);
  if (!sheets.length) return <Empty>这个表里没有 sheet</Empty>;
  const cur = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div>
      {sheets.length > 1 && (
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActive(i)}
              className="shrink-0 rounded-full px-2.5 text-[12px] max-md:min-h-[32px]"
              style={{
                minHeight: 30,
                background: i === active ? "var(--color-accent-soft, var(--color-surface-2))" : "var(--color-surface-2)",
                color: i === active ? "var(--color-accent)" : "var(--color-muted)",
                border: `1px solid ${i === active ? "var(--color-accent)" : "transparent"}`,
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <Grid rows={cur.rows} />
      <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
        {cur.name} · {cur.rows.length} 行
        {cur.totalRows && cur.totalRows > cur.rows.length ? `（共 ${cur.totalRows} 行）` : ""}
        {cur.totalCols ? ` × ${cur.totalCols} 列` : ""}
      </p>
    </div>
  );
}

/* ───────────────────────── 文档 ───────────────────────── */

export type DocBlock = { t: string; text?: string; rows?: string[][] };

export function DocumentView({ blocks }: { blocks: DocBlock[] }) {
  if (!blocks.length) return <Empty>这个文档里没有可显示的段落</Empty>;
  return (
    <div className="max-h-[56dvh] overflow-auto pr-1">
      {blocks.map((b, i) => {
        const key = `${b.t}-${i}`;
        if (b.t === "table") return <div key={key} className="my-2"><Grid rows={b.rows ?? []} /></div>;
        if (b.t === "h1")
          return (
            <h1 key={key} className="mt-3 mb-1.5 text-[19px] font-semibold leading-snug">
              {b.text}
            </h1>
          );
        if (b.t === "h2")
          return (
            <h2 key={key} className="mt-3 mb-1 text-[16.5px] font-semibold leading-snug">
              {b.text}
            </h2>
          );
        if (b.t.startsWith("h"))
          return (
            <h3 key={key} className="mt-2.5 mb-1 text-[14.5px] font-semibold leading-snug">
              {b.text}
            </h3>
          );
        if (b.t === "li")
          return (
            <p key={key} className="mb-1 flex gap-1.5 text-[13.5px] leading-[1.65]">
              <span style={{ color: "var(--color-accent)" }}>·</span>
              <span className="min-w-0 flex-1">{b.text}</span>
            </p>
          );
        return (
          <p key={key} className="mb-1.5 text-[13.5px] leading-[1.65]">
            {b.text}
          </p>
        );
      })}
    </div>
  );
}

/* ───────────────────────── 幻灯片 ───────────────────────── */

export type SlideData = { n: number; title: string; lines: string[]; notes: string };

export function SlidesView({ slides }: { slides: SlideData[] }) {
  const [idx, setIdx] = useState(0);
  if (!slides.length) return <Empty>这份幻灯片没有可读的文字</Empty>;
  const s = slides[Math.min(idx, slides.length - 1)];
  const at = (i: number) => setIdx(Math.max(0, Math.min(slides.length - 1, i)));
  return (
    <div>
      <div
        className="rounded-[12px] border p-3.5 max-md:p-3"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        <p className="text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
          第 {s.n} 页
        </p>
        <h3 className="mt-0.5 text-[16px] font-semibold leading-snug">{s.title || "（这页没有标题）"}</h3>
        <div className="mt-2 space-y-1">
          {s.lines.length === 0 ? (
            <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
              这页没有文字（可能是整张图片）
            </p>
          ) : (
            s.lines.map((ln, i) => (
              <p key={i} className="whitespace-pre-wrap text-[13.5px] leading-[1.6]">
                {ln}
              </p>
            ))
          )}
        </div>
        {s.notes ? (
          <details className="mt-2.5">
            <summary className="cursor-pointer text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              备注
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{s.notes}</p>
          </details>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn px-2.5 text-[12px] max-md:min-h-[36px]"
          disabled={idx === 0}
          onClick={() => at(idx - 1)}
        >
          上一页
        </button>
        <span className="tabular-nums text-[12px]" style={{ color: "var(--color-muted)" }}>
          {idx + 1} / {slides.length}
        </span>
        <button
          type="button"
          className="btn ml-auto px-2.5 text-[12px] max-md:min-h-[36px]"
          disabled={idx === slides.length - 1}
          onClick={() => at(idx + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── 思维导图 ───────────────────────── */

export type OutlineNode = { title: string; children?: OutlineNode[]; note?: string };
export type OutlineSheet = { title: string; root: OutlineNode };

function OutlineBranch({ node, depth }: { node: OutlineNode; depth: number }) {
  // 默认展开前两层：深树一次全展开会把人淹掉，但收起第一层就看不出结构了
  const [open, setOpen] = useState(depth < 2);
  const kids = node.children ?? [];
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <div className="flex items-start gap-1">
        {kids.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-[3px] shrink-0 rounded px-0.5 text-[10px] leading-none"
            style={{ color: "var(--color-muted)" }}
            aria-label={open ? "收起" : "展开"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-[10px] shrink-0" />
        )}
        <div className="min-w-0">
          <span className={depth === 0 ? "text-[14px] font-semibold" : "text-[13px]"}>{node.title || "（空）"}</span>
          {node.note ? (
            <span className="ml-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              {node.note}
            </span>
          ) : null}
        </div>
      </div>
      {open && kids.length > 0 && (
        <div
          className="border-l"
          style={{ borderColor: "var(--color-border)", marginLeft: 8, paddingLeft: 6 }}
        >
          {kids.map((c, i) => (
            <OutlineBranch key={`${c.title}-${i}`} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OutlineView({ sheets }: { sheets: OutlineSheet[] }) {
  const [active, setActive] = useState(0);
  if (!sheets.length) return <Empty>没解析出内容</Empty>;
  const cur = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div>
      {sheets.length > 1 && (
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {sheets.map((s, i) => (
            <button
              key={s.title + i}
              type="button"
              onClick={() => setActive(i)}
              className="shrink-0 rounded-full px-2.5 text-[12px] max-md:min-h-[32px]"
              style={{
                minHeight: 30,
                background: "var(--color-surface-2)",
                color: i === active ? "var(--color-accent)" : "var(--color-muted)",
                border: `1px solid ${i === active ? "var(--color-accent)" : "transparent"}`,
              }}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[54dvh] overflow-auto">
        <OutlineBranch node={cur.root} depth={0} />
      </div>
    </div>
  );
}

/* ───────────────────────── JSON / XML ───────────────────────── */

const JSON_NODE_LIMIT = 4000;

/** 值按类型上色：数字/布尔/字符串用不同色，扫一眼能分清结构 */
function JsonScalar({ v }: { v: unknown }) {
  if (v === null) return <span style={{ color: "var(--color-muted)" }}>null</span>;
  if (typeof v === "string")
    return <span style={{ color: "var(--color-ok, #16a34a)" }}>&quot;{v.length > 200 ? v.slice(0, 200) + "…" : v}&quot;</span>;
  if (typeof v === "number") return <span style={{ color: "var(--color-accent)" }}>{String(v)}</span>;
  if (typeof v === "boolean") return <span style={{ color: "var(--color-warn, #b45309)" }}>{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function JsonBranch({ k, v, depth, budget }: { k: string | null; v: unknown; depth: number; budget: { n: number } }) {
  const isObj = v !== null && typeof v === "object";
  const isArr = Array.isArray(v);
  const [open, setOpen] = useState(depth < 2);
  const label = k === null ? null : <span className="mr-1" style={{ color: "var(--color-muted)" }}>{k}:</span>;

  if (!isObj) {
    return (
      <div className="pl-3 text-[12.5px] leading-[1.7]">
        {label}
        <JsonScalar v={v} />
      </div>
    );
  }

  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const summary = isArr ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div className="text-[12.5px] leading-[1.7]">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="inline-flex items-baseline gap-1 text-left"
        style={{ paddingLeft: depth ? 0 : 0 }}
      >
        <span className="text-[10px]" style={{ color: "var(--color-muted)" }}>{open ? "▾" : "▸"}</span>
        {label}
        <span style={{ color: "var(--color-muted)" }}>{summary}</span>
      </button>
      {open && (
        <div className="border-l pl-2" style={{ borderColor: "var(--color-border)", marginLeft: 4 }}>
          {entries.map(([kk, vv]) => {
            if (budget.n <= 0)
              return null;
            budget.n -= 1;
            return <JsonBranch key={kk} k={kk} v={vv} depth={depth + 1} budget={budget} />;
          })}
          {budget.n <= 0 ? (
            <p className="pl-3 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              …节点太多，后面的没画出来（下载下来看完整结构）
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function JsonView({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false as const, err: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);
  if (!parsed.ok) {
    return <Empty>这不是合法 JSON：{parsed.err}</Empty>;
  }
  const budget = { n: JSON_NODE_LIMIT };
  return (
    <div className="max-h-[56dvh] overflow-auto rounded-[10px] border p-2.5" style={{ borderColor: "var(--color-border)" }}>
      <JsonBranch k={null} v={parsed.value} depth={0} budget={budget} />
    </div>
  );
}

/**
 * XML 预览：自己取文本再重排。
 * 为什么不并到 FileDialog 的文本分支：那边取回文本的 effect 是按 isTextishKind 判断的，
 * 而 XML 不进那一套（json 也不进 CodeBlock 分支了）；这里独立拉一次更不容易互相影响。
 */
export function XmlFetch({ url, path }: { url: string | null; path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!url) return;
    setText(null);
    setErr(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => alive && setText(t))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : "读取失败"));
    return () => {
      alive = false;
    };
  }, [url]);
  if (err)
    return (
      <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
        读不出内容（{err}），可以直接下载试试。
      </p>
    );
  if (text === null) return <Empty>读取中…</Empty>;
  return <XmlView text={text} />;
}

/**
 * XML 缩进重排。
 *
 * 为什么不用"按 < 切行"那种一行正则：`<item>甲</item>` 会被切成
 * `<item>甲` 和 `</item>` 两行，文本被孤立出去，读起来像坏了。
 * 走 DOMParser 递归之后，"只有文本的子节点"整个留在一行，结构才是对的。
 */
function formatXml(text: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    // 不是合法 XML（比如有未闭合标签）：原样给人看，至少内容没丢
    return text;
  }
  const out: string[] = [];
  const walk = (node: Node, depth: number) => {
    const ind = "  ".repeat(depth);
    if (node.nodeType === 3) {
      const t = (node.nodeValue ?? "").trim();
      if (t) out.push(ind + t);
      return;
    }
    if (node.nodeType === 8) {
      out.push(ind + "<!--" + (node.nodeValue ?? "") + "-->");
      return;
    }
    if (node.nodeType === 9) {
      // 文档节点：保住 XML 声明
      const decl = text.trimStart().startsWith("<?xml") ? text.trimStart().slice(0, text.trimStart().indexOf("?>") + 2) : "";
      if (decl) out.push(decl);
      node.childNodes.forEach((c) => walk(c, depth));
      return;
    }
    const el = node as Element;
    const name = el.tagName || "";
    if (!name) {
      node.childNodes.forEach((c) => walk(c, depth));
      return;
    }
    const attrs = Array.from(el.attributes)
      .map((a) => ` ${a.name}="${a.value}"`)
      .join("");
    const kids = Array.from(el.childNodes).filter((c) => c.nodeType !== 3 || (c.nodeValue ?? "").trim());
    if (!kids.length) {
      out.push(`${ind}<${name}${attrs}/>`);
      return;
    }
    if (kids.length === 1 && kids[0].nodeType === 3) {
      out.push(`${ind}<${name}${attrs}>${(kids[0].nodeValue ?? "").trim()}</${name}>`);
      return;
    }
    out.push(`${ind}<${name}${attrs}>`);
    kids.forEach((c) => walk(c, depth + 1));
    out.push(`${ind}</${name}>`);
  };
  walk(doc, 0);
  return out.join("\n");
}

/**
 * XML 只做缩进重排 —— 不折叠。
 * 理由：XML 的树是"标签里套标签"，折叠会让开闭标签对不上，比展开更难读；
 * 而缩进之后结构与 JSON 一样一目了然。折叠留给 JSON（那里 key 是天然的层级）。
 */
export function XmlView({ text }: { text: string }) {
  const pretty = useMemo(() => formatXml(text), [text]);
  const shown = pretty.length > 60_000 ? pretty.slice(0, 60_000) : pretty;
  return (
    <div>
      <pre
        className="max-h-[56dvh] overflow-auto rounded-[10px] border p-2.5 text-[12px] leading-[1.6] whitespace-pre"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        {shown}
      </pre>
      {pretty.length > shown.length ? <Note>内容太长，只显示了前 6 万字</Note> : null}
    </div>
  );
}
