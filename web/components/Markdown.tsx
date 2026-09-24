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

/** 行内：**加粗**、`代码`、[文字](链接) */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // 一次扫描，按优先级匹配三种标记
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
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

export default function Markdown({ text }: { text: string }) {
  const src = (text || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return null;

  const lines = src.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ``` 代码块
    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) buf.push(lines[i++]);
      i++; // 跳过收尾的 ```
      blocks.push(
        <pre
          key={`b${k++}`}
          className="my-2 overflow-auto rounded-[8px] border px-2.5 py-2 text-[11.5px] leading-[1.6]"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
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
