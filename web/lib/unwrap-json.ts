/**
 * 整条内容就是一坨 JSON（模型把工具返回值原样当正文吐出来）：
 * 里面通常有个 answer/result/text 才是给人看的话，其余是元数据。
 * 直接平铺渲染 = 用户看到 {"answer":"…","source":{…}}（复测 F1）。
 */
export function unwrapJson(text: string): { body: string; raw: string } | null {
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}") || t.length < 12) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  for (const k of ["answer", "result", "text", "content", "output", "reply"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return { body: v, raw: t };
  }
  return null;
}

