/**
 * JSON / XML(HTML) 的格式化与语法着色 —— 零依赖，纯函数。
 *
 * 为什么自己做：平台部署机零 Node、前端也刻意不引第三方（reactflow 那种都被拒了），
 * 而"模型吐一段 JSON/XML，人得能看懂"是每天都会遇到的事：
 *   · 没格式化 —— 一整行 4000 字符，横向拖到底才能读；
 *   · 没着色 —— 键、字符串、数字、标签全一个颜色，找一层结构要逐字读。
 *
 * 这里只做**看得懂**这一件事：切成 token（键/串/数字/关键字/标点/标签/属性/注释），
 * 由 CodeBlock 上色；格式化成 2 空格缩进。解析失败时原样返回，绝不把人家内容改坏。
 */

export type TokClass =
  | ""
  | "key"
  | "str"
  | "num"
  | "kw"
  | "punct"
  | "tag"
  | "attr"
  | "val"
  | "txt"
  | "com";

export type Tok = { t: string; c: TokClass };

/** 太大的文本不高亮（几十万 token 的 span 会把手机主线程卡住），直接给纯文本 */
const MAX_HL = 120_000;

export function formatJson(src: string, indent = 2): { text: string; ok: boolean } {
  try {
    const v = JSON.parse(src);
    return { text: JSON.stringify(v, null, indent), ok: true };
  } catch {
    return { text: src, ok: false };
  }
}

export function minifyJson(src: string): { text: string; ok: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(src)), ok: true };
  } catch {
    return { text: src, ok: false };
  }
}

/** 已经是紧凑格式？用来决定默认显示"格式化"还是"压缩" */
export function looksMinifiedJson(src: string): boolean {
  const t = src.trim();
  return t.startsWith("{") || t.startsWith("[") ? !/\n\s+["}\]]/.test(t) && !/\n {2,}/.test(t) : false;
}

/**
 * XML / HTML 缩进格式化（保守做法）：
 *   · 只按标签切，**不合并/不删除**任何节点，文本原样保留；
 *   · 自闭合标签（<x/>）、注释、CDATA、处理指令不参与缩进层级；
 *   · 行内标签（<b>x</b> 这种成对且中间没有换行的短片段）会各占一行 —— 这是格式化
 *     的代价，但比一整行贴到底好读。解析失败（标签不配对）时原样返回。
 */
export function formatXml(src: string): { text: string; ok: boolean } {
  const s = src.trim();
  if (!s.startsWith("<")) return { text: src, ok: false };
  try {
    // 去掉根节点外的空白，按标签切开
    const pieces = s
      .replace(/>\s+</g, "><")
      .replace(/></g, ">\n<")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    let depth = 0;
    const out: string[] = [];
    let opens = 0;
    let closes = 0;
    for (const p of pieces) {
      const isClose = /^<\//.test(p);
      const isSelf = /\/>$/.test(p);
      const isSpecial = /^<[?!]/.test(p); // <!-- --> <![CDATA[ <??>
      const hasInner = /^<([\w:.-]+)[^>]*>.*<\/\1>$/.test(p); // <a>..</a> 同一片段
      if (isClose) {
        depth = Math.max(0, depth - 1);
        closes++;
      }
      out.push("  ".repeat(depth) + p);
      if (!isClose && !isSelf && !isSpecial && !hasInner) {
        // 开标签：只有真的没在同一片段里闭合才进一层
        if (/^<([\w:.-]+)/.test(p)) {
          depth++;
          opens++;
        }
      } else if (hasInner) {
        opens++;
        closes++;
      }
    }
    if (opens !== closes) return { text: src, ok: false }; // 不配对就别乱动
    return { text: out.join("\n"), ok: true };
  } catch {
    return { text: src, ok: false };
  }
}

/** 这一段能不能当 JSON 处理（宽松：以 { 或 [ 开头且能 parse） */
export function isJsonText(src: string): boolean {
  const t = src.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function tokenizeJson(src: string): Tok[] {
  if (src.length > MAX_HL) return [{ t: src, c: "" }];
  const out: Tok[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])|(\s+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ t: src.slice(last, m.index), c: "" });
    if (m[1] !== undefined) {
      // 字符串：后面跟冒号的是键
      out.push({ t: m[1], c: m[2] ? "key" : "str" });
      if (m[2]) out.push({ t: m[2], c: "punct" });
    } else if (m[3] !== undefined) out.push({ t: m[3], c: "num" });
    else if (m[4] !== undefined) out.push({ t: m[4], c: "kw" });
    else if (m[5] !== undefined) out.push({ t: m[5], c: "punct" });
    else out.push({ t: m[6], c: "" });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: src.slice(last), c: "" });
  return merge(out);
}

export function tokenizeXml(src: string): Tok[] {
  if (src.length > MAX_HL) return [{ t: src, c: "" }];
  const out: Tok[] = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const txt = src.slice(last, m.index);
      // 文本节点里可能是实体，整体按文本处理即可
      out.push({ t: txt, c: txt.trim() ? "txt" : "" });
    }
    const whole = m[0];
    if (m[1] === undefined) {
      // 注释 / CDATA / 处理指令
      out.push({ t: whole, c: "com" });
    } else {
      const name = m[1];
      const attrs = m[2] || "";
      const selfClose = m[3] || "";
      const open = whole.slice(0, whole.indexOf(name));
      out.push({ t: open, c: "punct" });
      out.push({ t: name, c: "tag" });
      if (attrs) {
        // 属性串再切一层：name + "=" + "value"
        const are = /(\s+)([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
        let am: RegExpExecArray | null;
        let aLast = 0;
        while ((am = are.exec(attrs)) !== null) {
          if (am.index > aLast) out.push({ t: attrs.slice(aLast, am.index), c: "" });
          out.push({ t: am[1], c: "" });
          out.push({ t: am[2], c: "attr" });
          out.push({ t: am[3], c: "punct" });
          out.push({ t: am[4], c: "val" });
          aLast = am.index + am[0].length;
        }
        if (aLast < attrs.length) out.push({ t: attrs.slice(aLast), c: "" });
      }
      out.push({ t: selfClose + ">", c: "punct" });
    }
    last = m.index + whole.length;
  }
  if (last < src.length) out.push({ t: src.slice(last), c: "" });
  return merge(out);
}

/** 合并相邻同类 token —— span 越少越好（手机上尤其明显） */
function merge(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const t of toks) {
    if (!t.t) continue;
    const prev = out[out.length - 1];
    if (prev && prev.c === t.c && t.c !== "" && t.c !== "kw") prev.t += t.t;
    else out.push({ ...t });
  }
  return out;
}

/** 按语言挑 tokenizer（其它语言不猜，返回 null = 不高亮） */
export function tokenizerFor(lang: string): ((s: string) => Tok[]) | null {
  const l = (lang || "").toLowerCase();
  if (l === "json" || l === "jsonl" || l === "json5") return tokenizeJson;
  if (l === "xml" || l === "html" || l === "svg" || l === "xhtml" || l === "rss" || l === "atom")
    return tokenizeXml;
  return null;
}

/** 以内容猜：一眼是 JSON/XML 的也上色（模型常忘了写 ```json） */
export function guessLang(code: string): string | null {
  const t = code.trim();
  if (!t) return null;
  if (isJsonText(t) && t.length < 20000) return "json";
  if (/^<\?xml|^<[a-zA-Z][\w:.-]*[\s>]/.test(t)) return "xml";
  return null;
}
