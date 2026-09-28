"use client";

/**
 * 极简 Markdown 渲染器（自研，零依赖）
 *
 * 为什么要自己写：模型的产出天然是 Markdown（标题/列表/加粗/代码/分隔线），
 * 直接当纯文本贴出来就是一堆 `## 🔥` `**加粗**` `---` —— 实测结论卡与配置里的
 * "这次的产出"两处都这样。引第三方库（react-markdown 一整套）对这个产品是重炮
 * 打蚊子，而且用户明确偏好零依赖、能自持。
 *
 * 只支持实际会出现的语法，不做完整实现：
 *   #~#### 标题 · - / 1. 列表 · **加粗** · `行内代码` · ```代码块```
 *   > 引用 · --- 分隔线 · [文字](链接) · 空行分段
 * 不支持的（表格/脚注/HTML）按普通文本段落渲染 —— 宁可朴素，不要出错。
 */

import React from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { Mermaid } from "@/components/Mermaid";
import { ChartBlock, CsvBlock, DiffBlock, JsonBlock } from "@/components/DataBlocks";
import { splitInlineDisplayMath, texParse, type MNode } from "@/lib/tex";

/** 行内：**加粗**、`代码`、[文字](链接) */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // 一次扫描，按优先级匹配三种标记
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(\$\S(?:[^$\n]*\S)?\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith("**")) {
      out.push(
        <strong key={key} style={{ fontWeight: 600 }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded px-1 py-px text-[11.5px]"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("$")) {
      // 行内公式：$x^2$ / $rac{a}{b}$
      out.push(<TexInline key={key} tex={tok.slice(1, -1)} />);
    } else if (tok.startsWith("![")) {
      // 图片：模型给链接就直接显示（比一个裸链接有用得多）
      const mm = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
      out.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={key}
          src={mm ? mm[2] : ""}
          alt={mm ? mm[1] : ""}
          className="my-1 max-w-full rounded-md border"
          style={{ borderColor: "var(--color-border)" }}
        />,
      );
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push(
        <a
          key={key}
          href={mm ? mm[2] : "#"}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--color-accent)", textDecoration: "underline" }}
        >
          {mm ? mm[1] : tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}


/* ── 轻量 TeX 子集渲染（零依赖）──────────────────────────────────────────
   为什么自己做：公式是"要读的内容"，引 KaTeX 是整套依赖 + 字体文件，与本产品
   零依赖/自持的取向冲突；而实际会出现的公式就那几类：分数、上下标、希腊字母、
   求和/积分、根号、关系符。所以只实现这些。
   遇到不认识的命令**原样显示**（宁可显示 \foo，也不要渲染错或整块白掉）。
   实现路子：TeX 串 → 节点树 → span + inline-flex 排（分数 = 上下两行 + 一条横线），
   不用 canvas/svg、不加载字体。 */



/** 渲染上面解析出来的节点树。分数 = 上下两行 + 一条横线（inline-flex 排）；
 *  上下标用原生 sup/sub。整体用衬线斜体，接近数学排版的样子，但不加载任何字体。 */
function renderTex(nodes: MNode[], kb: string): React.ReactNode[] {
  return nodes.map((n, idx) => {
    const key = `${kb}-${idx}`;
    switch (n.k) {
      case "t":
        return <React.Fragment key={key}>{n.v}</React.Fragment>;
      case "grp":
        return <React.Fragment key={key}>{renderTex(n.a, key)}</React.Fragment>;
      case "frac":
        return (
          <span
            key={key}
            className="inline-flex flex-col items-center align-middle"
            style={{ verticalAlign: "-0.45em", margin: "0 2px" }}
          >
            <span className="px-1" style={{ paddingBottom: 1, lineHeight: 1.15 }}>
              {renderTex(n.a, key + "a")}
            </span>
            <span className="w-full" style={{ height: 1, background: "currentColor" }} />
            <span className="px-1" style={{ paddingTop: 1, lineHeight: 1.15 }}>
              {renderTex(n.b, key + "b")}
            </span>
          </span>
        );
      case "sqrt":
        return (
          <span key={key}>
            {/* 方根指数（\sqrt[3]{x}）：小字贴左上，与数学排版一致 */}
            {n.idx ? (
              <span style={{ fontSize: "0.65em", verticalAlign: "0.55em" }}>
                {renderTex(n.idx, key + "i")}
              </span>
            ) : null}
            <span style={{ opacity: 0.85 }}>√</span>
            <span style={{ borderTop: "1px solid currentColor", paddingTop: 1 }}>{renderTex(n.a, key)}</span>
          </span>
        );
      case "sup":
        return (
          <span key={key}>
            {renderTex(n.base, key + "b")}
            <sup style={{ fontSize: "0.72em" }}>{renderTex(n.sup, key + "s")}</sup>
          </span>
        );
      case "sub":
        return (
          <span key={key}>
            {renderTex(n.base, key + "b")}
            <sub style={{ fontSize: "0.72em" }}>{renderTex(n.sub, key + "s")}</sub>
          </span>
        );
      case "supsub":
        return (
          <span key={key}>
            {renderTex(n.base, key + "b")}
            <sub style={{ fontSize: "0.72em" }}>{renderTex(n.sub, key + "s")}</sub>
            <sup style={{ fontSize: "0.72em" }}>{renderTex(n.sup, key + "p")}</sup>
          </span>
        );
    }
  });
}

const TEX_STYLE: React.CSSProperties = {
  fontStyle: "italic",
  fontFamily: "ui-serif, Cambria, 'Times New Roman', serif",
};

/** 行内公式 $...$ */
function TexInline({ tex }: { tex: string }) {
  return (
    <span className="whitespace-nowrap" style={TEX_STYLE}>
      {renderTex(texParse(tex), "mi")}
    </span>
  );
}

/** 块级公式 $$...$$ —— 居中独占一行（公式宽了就横向滚动，不撑破卡片） */
function TexBlock({ tex }: { tex: string }) {
  return (
    <div className="my-2 overflow-x-auto text-center" style={{ ...TEX_STYLE, fontSize: "1.06em" }}>
      {renderTex(texParse(tex), "mb")}
    </div>
  );
}

/**
 * ```svg 代码块 —— agent 直接产出的图，**直接画出来**
 * （OpenGenerativeUI 那一类：产出即可见，不用先看代码再想象）。
 *
 * 走沙箱 iframe（sandbox=""）而不是 dangerouslySetInnerHTML：
 * 模型产出的 SVG 里可能带 <script> / onload，内联就等于让它拿到同源权限。
 * 沙箱里没有脚本权限，外面也不受它影响。想看源码就切到「代码」。
 */
function SvgBlock({ code }: { code: string }) {
  const [showCode, setShowCode] = React.useState(false);
  if (showCode) {
    return (
      <div className="my-2">
        <button
          type="button"
          data-tap
          className="mb-1 text-[11.5px] hover:underline"
          style={{ color: "var(--color-accent)" }}
          onClick={() => setShowCode(false)}
        >
          ← 看图
        </button>
        <CodeBlock code={code} lang="svg" />
      </div>
    );
  }
  return (
    <div className="my-2 rounded-[10px] border" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
          图（SVG）
        </span>
        <button
          type="button"
          data-tap
          className="ml-auto text-[11.5px] hover:underline"
          style={{ color: "var(--color-accent)" }}
          onClick={() => setShowCode(true)}
        >
          代码
        </button>
      </div>
      <iframe
        title="svg-preview"
        sandbox=""
        srcDoc={`<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#fff">${code}</body></html>`}
        className="block h-[260px] w-full"
      />
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  const src = (text || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return null;

  const lines = src.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ``` 代码块 —— CodeBlock（复制按钮 + html 预览）
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) buf.push(lines[i++]);
      i++; // 跳过收尾的 ```
      const body = buf.join("\n");
      if (lang === "json") {
        blocks.push(<JsonBlock key={`b${k++}`} code={body} />);
      } else if (lang === "csv") {
        blocks.push(<CsvBlock key={`b${k++}`} code={body} delimiter="," />);
      } else if (lang === "tsv") {
        blocks.push(<CsvBlock key={`b${k++}`} code={body} delimiter="\t" />);
      } else if (lang === "chart") {
        blocks.push(<ChartBlock key={`b${k++}`} code={body} />);
      } else if (lang === "diff" || lang === "patch") {
        blocks.push(<DiffBlock key={`b${k++}`} code={body} />);
      } else if (lang === "mermaid") {
        // 流程图：自动布局画出来（认不出的语法会自己退回代码）
        blocks.push(<Mermaid key={`b${k++}`} code={body} />);
      } else if (lang === "svg") {
        // agent 直接产 SVG → 直接显示（OpenGenerativeUI 那一类：产出即可见）
        blocks.push(<SvgBlock key={`b${k++}`} code={body} />);
      } else {
        blocks.push(<CodeBlock key={`b${k++}`} code={body} lang={lang} />);
      }
      continue;
    }

    // 表格（| a | b | + |---|---|）—— 模型汇报对比/列表时高频出现，
    // 之前按普通文本贴出来就是一排竖线 ✗。连续表格行合成一张表。
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const rows: string[][] = [];
      const splitRow = (l: string) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      rows.push(splitRow(line));
      i += 2; // 表头 + 分隔行
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div key={`t${k++}`} className="my-2 overflow-x-auto rounded-[8px] border" style={{ borderColor: "var(--color-border)" }}>
          <table className="w-full text-[12px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-surface-2)" }}>
                {rows[0].map((h, j) => (
                  <th key={j} className="px-2.5 py-1.5 text-left font-medium" style={{ borderBottom: "1px solid var(--color-border)" }}>
                    {inline(h, `th${k}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 align-top" style={{ borderBottom: "1px solid var(--color-border)" }}>
                      {inline(c, `td${k}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 块级公式 $$...$$（可跨行）—— 放在标题/表格之前，避免 $$ 里的 | # 被误判
    if (line.trimStart().startsWith("$$")) {
      const buf: string[] = [];
      const rest = line.trimStart().slice(2);
      const inlineEnd = rest.indexOf("$$");
      if (inlineEnd >= 0) {
        buf.push(rest.slice(0, inlineEnd));
      } else {
        buf.push(rest);
        i++;
        while (i < lines.length && !lines[i].includes("$$")) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i].split("$$")[0]);
      }
      i++;
      blocks.push(<TexBlock key={`b${k++}`} tex={buf.join(" ").trim()} />);
      continue;
    }

    // 同一行里混排的块级公式：`说明：$$E=mc^2$$ 后半句`
    // —— 之前只认"整行以 $$ 开头"，这种写法会把首尾 $$ 当字面量留在页面上。
    // 拆成三段：前文按段落、公式按块级居中、后文（若有）塞回待处理行。
    const dm = splitInlineDisplayMath(line);
    if (dm && line.trimStart().startsWith("$$") === false) {
      if (dm.head.trim()) {
        blocks.push(
          <p key={`p${k++}`} className="my-1.5 leading-[1.7]">
            {inline(dm.head.trim(), `dm${k}`)}
          </p>,
        );
      }
      blocks.push(<TexBlock key={`b${k++}`} tex={dm.math.trim()} />);
      if (dm.tail.trim()) lines[i] = dm.tail.trim();
      else i++;
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const size = lvl === 1 ? 14.5 : lvl === 2 ? 13.5 : 12.5;
      blocks.push(
        <div
          key={`h${k++}`}
          className="mt-2.5 mb-1 font-semibold first:mt-0"
          style={{ fontSize: size, lineHeight: 1.5 }}
        >
          {inline(h[2], `h${k}`)}
        </div>,
      );
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        <div key={`hr${k++}`} className="my-2.5 border-t" style={{ borderColor: "var(--color-border)" }} />,
      );
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <div
          key={`q${k++}`}
          className="my-2 border-l-2 pl-2.5 text-[12px] leading-[1.7]"
          style={{ borderColor: "var(--color-accent)", color: "var(--color-muted)" }}
        >
          {inline(buf.join(" "), `q${k}`)}
        </div>,
      );
      continue;
    }

    // 列表（- / * / 数字.）—— 支持一层缩进的简单嵌套
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: { indent: number; text: string }[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const mm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])!;
        items.push({ indent: mm[1].length, text: mm[3] });
        i++;
      }
      blocks.push(
        <ul key={`ul${k++}`} className="my-1.5 flex flex-col gap-1">
          {items.map((it, n) => (
            <li
              key={n}
              className="flex gap-1.5 text-[12.5px] leading-[1.7]"
              style={{ paddingLeft: Math.min(it.indent, 8) * 1.5 }}
            >
              <span className="shrink-0" style={{ color: "var(--color-accent)" }}>
                •
              </span>
              <span className="min-w-0 break-words">{inline(it.text, `l${k}-${n}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落（连续非空行合并）
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith("```") &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    blocks.push(
      <p key={`p${k++}`} className="my-1.5 text-[12.5px] leading-[1.75] break-words">
        {inline(buf.join(" "), `p${k}`)}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}
