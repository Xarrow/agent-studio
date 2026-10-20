/**
 * 文件识别与取回地址 —— 对话里"看起来是文件"的那一段，靠这里判定并给出可点击的目标。
 *
 * 为什么单独一份：同一段路径可能在三个地方出现（模型正文里的行内代码、工具调用参数、
 * 会话文件清单），判定规则和取回地址必须一致，否则同一个文件在两处表现不一样。
 */

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);

/** 能在页面里当文本预览的（其余一律走下载，不要拿二进制去渲染） */
const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "json", "jsonl", "ndjson", "csv", "tsv", "log",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "sh", "bash", "zsh", "py", "js",
  "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "html", "htm", "xml", "sql", "go",
  "rs", "java", "c", "h", "cpp", "hpp", "rb", "php", "lua", "swift", "kt", "mermaid", "diff", "patch",
]);

/**
 * 对话里点开文件时，按"能不能在这台设备上直接看"分类 —— 分类决定弹层里放什么：
 * 图片/PDF/音频/视频用原生控件，Markdown 渲染，CSV 出表格，代码走 CodeBlock，
 * 其余（Word/Excel/压缩包）老实说"预览不了"，只给下载。
 */
export type FileKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "markdown"
  | "table"
  | "html"
  | "text"
  | "other";

const PDF_EXT = new Set(["pdf"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const MD_EXT = new Set(["md", "markdown", "mdx"]);
const TABLE_EXT = new Set(["csv", "tsv"]);
const HTML_EXT = new Set(["html", "htm"]);

export function extOf(name: string): string {
  const base = name.split("/").pop() || name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return "image";
  if (PDF_EXT.has(e)) return "pdf";
  if (AUDIO_EXT.has(e)) return "audio";
  if (VIDEO_EXT.has(e)) return "video";
  if (MD_EXT.has(e)) return "markdown";
  if (TABLE_EXT.has(e)) return "table";
  if (HTML_EXT.has(e)) return "html";
  if (TEXT_EXT.has(e)) return "text";
  return "other";
}

/** 需要先取回文本才能预览的那几类（Markdown 渲染、表格解析、代码高亮） */
export function isTextishKind(kind: FileKind): boolean {
  return kind === "text" || kind === "markdown" || kind === "table";
}

/** 这个文件在这台设备上能不能直接看（决定弹层里给预览还是给下载） */
export function canPreview(kind: FileKind): boolean {
  return kind !== "other";
}

export function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() || p;
}

/**
 * 这段文字是不是一个"文件"？判定得**保守**：只有明确像路径的才变成可点的文件，
 * 免得把正文里的普通行内代码（`npm run build`、`top_k`）也做成一堆小卡片。
 *
 * 认这几种：绝对路径（/a/b.md）、带目录的相对路径（data/x.json、./out.txt）、
 * 以及带已知扩展名的裸文件名（result.md、报告.pdf）；含空格/换行/协议/邮箱的不算。
 */
export function looksLikeFilePath(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 260) return false;
  if (/[\s\n]/.test(s)) return false; // 路径里带空格就不猜了
  if (/:\/\//.test(s) || s.includes("@")) return false; // URL / 邮箱
  if (/^[a-z]+:\/\//i.test(s)) return false;
  const e = extOf(s);
  if (!e || e.length > 8 || !/^[a-z0-9]+$/i.test(e)) return false;
  // 版本号 / 纯数字小数点：1.5、2.0.1 不是文件
  if (/^\d+(\.\d+)*$/.test(s)) return false;
  // 扩展名之前得有真名字（字母或汉字）；".gitignore" 这种纯后缀不算
  const base = s.split("/").pop() || s;
  const stem = base.slice(0, base.lastIndexOf("."));
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(stem)) return false;
  if (s.startsWith("/")) return true; // 绝对路径
  if (/^\.{1,2}\//.test(s)) return true; // ./ 或 ../
  if (s.includes("/")) return true; // 带目录的相对路径
  // 裸文件名：看着像文件名（不留 Windows/URL 里那些非法字符，中文照样算）
  return /^[^\s/\\:*?"<>|]+$/.test(s);
}

/**
 * 取回地址。只有**本会话工作目录里的文件**才给 URL —— 别的路径（比如 /etc/hosts）
 * 平台本来就不该放行，对话框里只给"复制路径"。
 * 与后端 /api/sessions/{id}/files 返回的 url 口径一致：
 *   /api/work/file/sessions/<session_id>/<相对路径>
 */
export function fileUrlFor(path: string, sessionId?: string, workDir?: string): string | null {
  if (!sessionId) return null;
  const clean = path.replace(/\/+$/, "");
  let rel: string | null = null;
  if (workDir && clean.startsWith(workDir.replace(/\/+$/, "") + "/")) {
    rel = clean.slice(workDir.replace(/\/+$/, "").length + 1);
  } else {
    // 没拿到 work_dir 时按"路径里出现 /sessions/<本会话 id>/"来切
    const marker = `/sessions/${sessionId}/`;
    const i = clean.indexOf(marker);
    if (i >= 0) rel = clean.slice(i + marker.length);
  }
  if (!rel || rel.includes("..")) return null;
  return `/api/work/file/sessions/${sessionId}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * 文件名太长时做**中间省略**，保留扩展名。
 * 直接 truncate 截尾会把 `.json` / `.md` 切掉 —— 文件类型恰好是最要紧的信息。
 * 「报告-v2-final.json」→「报告-…-final.json」
 */
export function middleEllipsis(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const keep = Math.max(6, max - ext.length - 1); // 至少留 6 个字的词干
  const head = Math.ceil((keep - 1) / 2);
  const tail = keep - 1 - head;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}

/** 文件类型（给图标用）：image / text / json / xml / code / archive / sheet / pdf / other */
export function fileTypeKey(path: string): string {
  const e = extOf(path);
  if (!e) return "other";
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "json" || e === "jsonl" || e === "ndjson") return "json";
  if (e === "xml" || e === "html" || e === "htm" || e === "svg") return "xml";
  if (["csv", "tsv", "xlsx", "xls"].includes(e)) return "sheet";
  if (["md", "txt", "log", "yml", "yaml", "toml", "ini", "conf"].includes(e)) return "text";
  if (["pdf"].includes(e)) return "pdf";
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(e)) return "archive";
  if (["py", "ts", "tsx", "js", "jsx", "sh", "go", "rs", "java", "c", "cpp", "css"].includes(e)) return "code";
  return "other";
}
