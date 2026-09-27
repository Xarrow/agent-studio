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

/** 行内：**加粗**、`代码`、[文字](链接) */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // 一次扫描，按优先级匹配三种标记
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\$\S(?:[^$\n]*\S)?\$)/g;
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

const TEX_SYM: Record<string, string> = {
  // 希腊字母
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // 算符 / 关系
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  to: "→", rightarrow: "→", Rightarrow: "⇒", leftrightarrow: "↔", mapsto: "↦",
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
  sum: "∑", prod: "∏", int: "∫", oint: "∮", sqrt: "√",
  cdotp: "·", ldots: "…", dots: "…", cdots: "⋯",
  quad: " ", qquad: "  ", ", ": " ", ";": " ", " ": " ",
  "%": "%", "#": "#", "{": "{", "}": "}", "_": "_", "&": "&", "$": "$",
};

type MNode =
  | { k: "t"; v: string }
  | { k: "grp"; a: MNode[] }
  | { k: "frac"; a: MNode[]; b: MNode[] }
  | { k: "sqrt"; a: MNode[] }
  | { k: "sup"; base: MNode[]; sup: MNode[] }
  | { k: "sub"; base: MNode[]; sub: MNode[] }
  | { k: "supsub"; base: MNode[]; sup: MNode[]; sub: MNode[] };

/** 把一根 TeX 串解析成节点树。认不出的命令按字面文本（宁可显示 \foo，不要白掉）。 */
function texParse(src: string): MNode[] {
  let i = 0;
  const peek = () => src[i];

  /** 取一个"组"：{...} 递归；否则取单字符（x^2 里的 2） */
  const group = (): MNode[] => {
    if (peek() === "{") {
      i++;
      const out = seq(true);
      if (peek() === "}") i++;
      return out;
    }
    if (i >= src.length) return [];
    return [{ k: "t", v: src[i++] }];
  };

  /** 取一个基元（一个 MNode） */
  const atom = (): MNode => {
    const c = peek();
    if (c === "{") return { k: "grp", a: group() };
    if (c === "\\") {
      i++;
      let name = "";
      while (i < src.length && /[a-zA-Z]/.test(src[i])) name += src[i++];
      if (!name) {
        const ch = src[i++] ?? "";
        return { k: "t", v: TEX_SYM[ch] ?? ch };
      }
      if (name === "frac") return { k: "frac", a: group(), b: group() };
      if (name === "sqrt") return { k: "sqrt", a: group() };
      if (name === "text" || name === "mathrm" || name === "operatorname") {
        return { k: "t", v: plain(group()) }; // 这些里面的字符按字面
      }
      return { k: "t", v: TEX_SYM[name] ?? "\\" + name };
    }
    i++;
    return { k: "t", v: c ?? "" };
  };

  /** 一串基元；遇到 } 就停（若在组里） */
  const seq = (inGroup: boolean): MNode[] => {
    const out: MNode[] = [];
    while (i < src.length) {
      if (inGroup && peek() === "}") break;
      const base = atom();
      // 基元后面可能挂上下标（可以同时有 ^ 和 _，顺序随意）
      let sup: MNode[] | null = null;
      let sub: MNode[] | null = null;
      while (peek() === "^" || peek() === "_") {
        const isSup = peek() === "^";
        i++;
        const arg = group();
        if (isSup) sup = arg;
        else sub = arg;
      }
      if (sup && sub) out.push({ k: "supsub", base: [base], sup, sub });
      else if (sup) out.push({ k: "sup", base: [base], sup });
      else if (sub) out.push({ k: "sub", base: [base], sub });
      else out.push(base);
    }
    return out;
  };

  /** 把节点树摊回纯文本（\text{} 用） */
  const plain = (nodes: MNode[]): string =>
    nodes
      .map((n) => {
        switch (n.k) {
          case "t": return n.v;
          case "grp": return plain(n.a);
          case "frac": return `${plain(n.a)}/${plain(n.b)}`;
          case "sqrt": return `√${plain(n.a)}`;
          case "sup": return `${plain(n.base)}^${plain(n.sup)}`;
          case "sub": return `${plain(n.base)}_${plain(n.sub)}`;
          case "supsub": return `${plain(n.base)}^${plain(n.sup)}_${plain(n.sub)}`;
        }
      })
      .join("");

  return seq(false);
}


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
      blocks.push(<CodeBlock key={`b${k++}`} code={buf.join("\n")} lang={lang} />);
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

    // 表格：| 列 | 列 | 换行后跟 |---|---| —— 模型产出里很常见（天气、对比、参数表）
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
      const head = cells(lines[i]);
      i += 2; // 跳过表头行与分隔行
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={`tb${k++}`} className="my-2 overflow-auto rounded-[8px] border" style={{ borderColor: "var(--color-border)" }}>
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr style={{ background: "var(--color-surface-2)" }}>
                {head.map((h, n) => (
                  <th
                    key={n}
                    className="border-b px-2 py-1 text-left font-semibold"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    {inline(h, `th${k}-${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      className="border-b px-2 py-1 align-top"
                      style={{ borderColor: "color-mix(in srgb, var(--color-border) 60%, transparent)" }}
                    >
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
