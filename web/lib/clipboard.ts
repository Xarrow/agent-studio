/**
 * 复制到剪贴板 —— 内网 http 下也必须能用。
 *
 * 为什么不能直接用 navigator.clipboard：它只在**安全上下文**（https / localhost）存在。
 * 平台在内网是 http://192.168.2.11:8848 这种地址打开的 —— 那里 navigator.clipboard
 * 是 undefined，原来 `navigator.clipboard?.writeText(...).then(...)` 会直接抛异常，
 * 于是"点了复制什么都没发生"（还以为是自己没点到）。
 *
 * 兜底走老办法：临时 textarea + execCommand('copy')，http 下照样工作。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 / 非安全上下文 → 走兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
