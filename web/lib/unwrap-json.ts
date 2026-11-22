/**
 * 整条内容就是一坨 JSON（模型把工具返回值原样当正文吐出来）：
 * 里面通常有个 answer/result/text 才是给人看的话，source 是来源，
 * 其余是元数据。直接平铺渲染 = 用户看到 {"answer":"…","source":{…}}。
 *
 * 两件事必须一起做：
 *   ① 能解析出可读正文 → 只渲染正文 + 来源卡片（原始 JSON 不进正文）
 *   ② **流式还没跑完时**也是同一份 JSON 的开头（`{"answer":"知识库《合同.md》…`），
 *      这时 JSON.parse 必然失败；不抽取的话用户会先看到一大段大括号，
 *      跑完才突然变成人话 —— 实测就是这样被报成「回复裸露原始 JSON」。
 */

/** 可能装着「给人看的那句话」的键 */
const TEXT_KEYS = [
  "answer",
  "result",
  "text",
  "content",
  "output",
  "reply",
  "message",
  "response",
] as const;

/** 可能装着来源的键 */
const SOURCE_KEYS = [
  "source",
  "sources",
  "citation",
  "citations",
  "reference",
  "references",
] as const;

export type JsonSource = Record<string, unknown>;

export type Unwrapped = {
  /** 给人看的正文 */
  body: string;
  /** 原始整条内容（复制/留档用；界面上不再平铺） */
  raw: string;
  /** 来源（对象或数组里的第一个对象）；没有就是 null */
  source: JsonSource | null;
  /** true = 流式还没结束，正文是从半截 JSON 里抽出来的 */
  partial: boolean;
};

function asRecord(v: unknown): JsonSource | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonSource) : null;
}

function pickSource(rec: JsonSource): JsonSource | null {
  for (const k of SOURCE_KEYS) {
    const v = rec[k];
    const one = asRecord(v);
    if (one) return one;
    if (Array.isArray(v)) {
      const first = v.map(asRecord).find((x): x is JsonSource => !!x);
      if (first) return first;
    }
  }
  return null;
}

/**
 * 从**半截** JSON 里抽出 `"answer": "……` 的正文。
 *
 * 只认顶层第一个文本键、且键值必须是字符串 —— 不做通用 JSON 容错解析，
 * 免得把正常正文里的大括号误吃掉。
 */
function partialBody(t: string): string | null {
  const head = new RegExp(`^\\{\\s*"(${TEXT_KEYS.join("|")})"\\s*:\\s*"`);
  const m = t.match(head);
  if (!m) return null;
  let out = "";
  let esc = false;
  for (let i = m[0].length; i < t.length; i++) {
    const c = t[i];
    if (esc) {
      if (c === "n") out += "\n";
      else if (c === "t") out += "\t";
      else if (c === "r") out += "\r";
      else if (c === "u") {
        const hex = t.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // 转义还没流完
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else out += c;
      esc = false;
    } else if (c === "\\") esc = true;
    else if (c === '"') break;
    else out += c;
  }
  const body = out.trim();
  return body ? out : null;
}

export function unwrapJson(text: string): Unwrapped | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith("{") || t.length < 12) return null;

  // ① 完整 JSON：解析成功就走结构化渲染
  if (t.endsWith("}")) {
    let obj: unknown = null;
    try {
      obj = JSON.parse(t);
    } catch {
      obj = null;
    }
    const rec = asRecord(obj);
    if (rec) {
      for (const k of TEXT_KEYS) {
        const v = rec[k];
        if (typeof v !== "string" || !v.trim()) continue;
        // 有一层嵌套（{"result":"{\"answer\":…}"}）时再抽一次，最多一层
        if (v.trim().startsWith("{")) {
          const inner = unwrapJson(v);
          if (inner) {
            return {
              body: inner.body,
              raw: t,
              source: inner.source ?? pickSource(rec),
              partial: false,
            };
          }
        }
        return { body: v, raw: t, source: pickSource(rec), partial: false };
      }
      // 结构对不上（比如只有 source）：不猜，交给 Markdown 当普通文本
      return null;
    }
  }

  // ② 流式半截 JSON：至少把已经流出来的正文先当正文渲染
  const body = partialBody(t);
  if (body) return { body, raw: t, source: null, partial: true };
  return null;
}
