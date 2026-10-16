/**
 * 工作目录路径 → 页面可看的 URL（纯函数，可单测）
 * ==================================================
 *
 * 为什么单独抽出来：模型给图片的路子太多 —— Write/Edit 出产物卡是一路，
 * 无头浏览器截图 / matplotlib 保存 / 脚本导出是另一路（**只是一行 stdout**：
 * `76053 bytes written to file /srv/.../data/work/x.png`）。
 * 这些路径要出现在消息正文、执行过程、完整记录三个地方，判定逻辑必须
 * 完全一致；靠每处各写一遍正则，早晚有一处漏掉（实测：正文显示了图片，
 * 执行过程和完整记录里还是服务器路径 ✗）。
 *
 * 三种写法都要认：
 *   绝对路径  /srv/src/agent-studio/data/work/youtube_homepage.png
 *   相对路径  data/work/youtube_homepage.png
 *   已是接口  /api/work/file/youtube_homepage.png
 *
 * ⚠️ 两条硬约束（都有单测锁）：
 *  1. **路径段里不认空格**。认了就会横跨空格贪心匹配到下一段文本
 *     （实测：`a.png 和 /srv/x/data/work/b.jpg` 被拼成一个坏路径）。
 *     宁可让「带空格的产物名」显示成文本，也不能拼出打不开的 URL。
 *  2. **不认 URL 里的同名字符串**（https://example.com/data/work/x.png）——
 *     那是别人站点的图，不是我们的产物。
 */

/** 工作目录在服务器上的绝对前缀（模型抄工具输出时会带上） */
export const WORK_DIR_MARK = "data/work/";

const IMG_EXT_SRC = "png|jpe?g|gif|webp|svg|bmp";

const DOC_EXT_SRC =
  "png|jpe?g|gif|webp|svg|bmp|pdf|txt|md|markdown|json|csv|tsv|html?|xml|ya?ml|log|py|js|ts|sql|ipynb";

/** 路径段允许的字符：中英文、数字、`.` `-` `_` `(` `)` `+`（不含空格与 `/`） */
const SEG = "[\\w.\\-()+\\u4e00-\\u9fff]+";

const WORK_DIR_RE = WORK_DIR_MARK.replace("/", "\\/");

/** 文本里出现的**工作目录下的图片**（去重、保序） */
export const WORK_IMG_RE = new RegExp(
  `(?<![\\w.])\\/*(?:${SEG}\\/)*${WORK_DIR_RE}((?:[^\\s\\/]*\\/)*[^\\s\\/]+\\.(?:${IMG_EXT_SRC}))`,
  "gi",
);

export function isImagePath(p: string): boolean {
  return new RegExp(`\\.(?:${IMG_EXT_SRC})$`, "i").test(p || "");
}

/** 值得在页面上给出来的产物（与后端 /api/work 的白名单一致） */
export function isProductPath(p: string): boolean {
  return new RegExp(`\\.(?:${DOC_EXT_SRC})$`, "i").test(p || "");
}

/**
 * 任意写法 → `/api/work/file/<相对路径>`。
 * 浏览器拿到 `/srv/...` 会当成站点路径去请求（图直接裂），所以必须归一化。
 */
export function workUrl(u: string): string {
  const raw = (u || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/api/work/file/")) return raw;
  const i = raw.lastIndexOf(WORK_DIR_MARK);
  const rel = (i >= 0 ? raw.slice(i + WORK_DIR_MARK.length) : raw)
    .replace(/^\/+/, "")
    .trim();
  return `/api/work/file/${rel}`;
}

/**
 * 匹配处是不是某个 URL 的一部分。
 * 往前找到最近的空白看那一整段：里面有 `://`（https://x/data/work/a.png）
 * 或本身就像个 scheme（`https:` 紧贴在匹配前面）→ 是别人站点的地址，跳过。
 */
function insideUrl(text: string, at: number): boolean {
  const head = text.slice(0, at);
  const cut = Math.max(
    head.lastIndexOf(" "),
    head.lastIndexOf("\n"),
    head.lastIndexOf("\t"),
    head.lastIndexOf("（"),
    head.lastIndexOf("，"),
  );
  const chunk = head.slice(cut + 1);
  return /:\/\//.test(chunk) || /^[a-zA-Z][\w+.\-]*:/.test(chunk);
}

/** 从一段文本里挑出所有工作目录图片的 URL（去重、保序） */
export function workImageUrls(text: string): string[] {
  const out: string[] = [];
  const src = text || "";
  for (const m of src.matchAll(WORK_IMG_RE)) {
    if (m.index === undefined || insideUrl(src, m.index)) continue;
    const rel = (m[1] || "").trim();
    if (!rel) continue;
    const url = workUrl(rel);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** 非图片但也值得点开的产物后缀（pdf / md / py …） */


/** 裸路径：`/任意/前缀/data/work/<文件>`（文件后缀在上表内） */
const WORK_PATH_RE = new RegExp(
  `(?<![\\w.])/*(?:${SEG}/)*${WORK_DIR_RE}((?:[^\\s/]*/)*[^\\s/]+(?:\\.(?:${DOC_EXT_SRC})))`,
  "gi",
);

/**
 * 产物路径出现的三种形态，都要变成页面可看的：
 *   1. 裸路径 → 图片内联 / 文件链接
 *   2. inline code 内的路径（模型习惯 `path` 强调）→ 同样转换，但**去掉反引号**
 *      —— code 里渲染不了链接，留着反引号就是把可点的东西锁进死文本
 *   3. 绝对路径（/srv/.../data/work/x.png）→ 归一化后再链接
 */
export function linkifyWorkPaths(text: string): string {
  /** 块级（路径单独占一行时）：给它自己的段落，图不被文字挤着 */
  const asBlock = (rel: string) => {
    const name = rel.split("/").pop() || rel;
    return isImagePath(rel)
      ? `\n\n![${name}](${workUrl(rel)})\n\n`
      : `\n\n[${name}](${workUrl(rel)})\n\n`;
  };
  /** 行内：`文件路径：\`x.png\`` 这种 —— 图就贴在标签后面。
   *  不要拆成「标签 + 空段落 + 图」：实测那样标签会变成孤零零的
   *  「📁 文件路径：」什么都不跟，看着像页面出错了（用户就是照这个报的）。 */
  const asInline = (rel: string) => {
    const name = rel.split("/").pop() || rel;
    return isImagePath(rel)
      ? `![${name}](${workUrl(rel)})`
      : `[${name}](${workUrl(rel)})`;
  };
  return (text || "")
    // ① inline code 里的路径：贴着原位替换
    .replace(/`[^`\n]*?\/data\/work\/([^`\n]*?)`/g, (full, rel: string) =>
      new RegExp(`\\.(?:${DOC_EXT_SRC})$`, "i").test((rel || "").trim())
        ? asInline(rel.trim())
        : full,
    )
    // ② 裸路径：这一行除了它（最多还有个项目符号）没别的 → 块级；夹在文字里 → 行内
    .replace(WORK_PATH_RE, (full, rel: string, offset: number, whole: string) => {
      const lineStart = whole.lastIndexOf("\n", offset) + 1;
      const nl = whole.indexOf("\n", offset);
      const line = whole.slice(lineStart, nl === -1 ? whole.length : nl);
      const rest = line.replace(full, "").trim();
      const alone = rest === "" || /^[-*•]\s*$/.test(rest);
      return alone ? asBlock(rel) : asInline(rel);
    });
}

/** 文本里是否提到了工作目录下的文件（不限于图片） */
export function mentionsWorkFile(text: string): boolean {
  return new RegExp(`${WORK_DIR_RE}${SEG}`).test(text || "");
}
