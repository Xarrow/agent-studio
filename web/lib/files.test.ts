/**
 * 文件识别（lib/files.ts）的护栏 —— node --test，零依赖。
 *
 * 为什么值得守：`looksLikeFilePath` 决定"正文里这一段要不要变成可点的文件卡"。
 * 判宽了 → 满屏小卡片（`npm run build`、`top_k` 都变成文件）；
 * 判窄了 → 真文件点不开（用户投诉的原始问题）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  baseName,
  canPreview,
  extOf,
  fileKind,
  fileTypeKey,
  fileUrlFor,
  isTextishKind,
  looksLikeFilePath,
  middleEllipsis,
} from "./files.ts";

test("像文件的才认：绝对路径 / 带目录的相对路径 / 带扩展名的裸文件名", () => {
  for (const s of [
    "/srv/src/agent-studio/data/work/sessions/ses_abc/result.md",
    "data/a.json",
    "./out.txt",
    "result.md",
    "报告.pdf",
    "sub/dir/report-2026.csv",
  ]) {
    assert.equal(looksLikeFilePath(s), true, `${s} 应该被认成文件`);
  }
});

test("不像文件的一律不认（否则正文会变成一堆小卡片）", () => {
  for (const s of [
    "npm run build",
    "top_k",
    "cd /srv && ls",
    "https://example.com/a.md",
    "a@b.com",
    "**important**",
    "1.5",
    "Agent-Studio",
    "",
  ]) {
    assert.equal(looksLikeFilePath(s), false, `${s} 不该被认成文件`);
  }
});

test("扩展名与类型判定", () => {
  assert.equal(extOf("/a/b/Report.MD"), "md");
  assert.equal(extOf("noext"), "");
  assert.equal(fileKind("shot.PNG"), "image");
  assert.equal(fileKind("data.json"), "text");
  // 常见格式各有各的预览方式（PDF 内嵌、音视频原生控件、md 渲染、表格出表）
  assert.equal(fileKind("报告.pdf"), "pdf");
  assert.equal(fileKind("录音.mp3"), "audio");
  assert.equal(fileKind("demo.mp4"), "video");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("表.csv"), "table");
  assert.equal(fileKind("page.html"), "html");
  assert.equal(isTextishKind("markdown"), true);
  assert.equal(canPreview("pdf"), true);
  assert.equal(canPreview("other"), false);
  assert.equal(fileKind("pkg.zip"), "other");
  assert.equal(baseName("/a/b/result.md"), "result.md");
  assert.equal(baseName("/a/b/"), "b");
});

test("只有本会话工作目录里的文件才给取回地址（别的路径不给）", () => {
  const sid = "ses_abc";
  assert.equal(
    fileUrlFor(`/work/sessions/${sid}/result.md`, sid, "/work/sessions/" + sid),
    `/api/work/file/sessions/${sid}/result.md`,
  );
  // 子目录、带空格的文件名要编码
  assert.equal(
    fileUrlFor(`/work/sessions/${sid}/out/我的 报告.md`, sid, `/work/sessions/${sid}`),
    `/api/work/file/sessions/${sid}/out/%E6%88%91%E7%9A%84%20%E6%8A%A5%E5%91%8A.md`,
  );
  // 会话外的路径：不给 URL（对话框里只让复制路径）
  assert.equal(fileUrlFor("/etc/hosts", sid, `/work/sessions/${sid}`), null);
  assert.equal(fileUrlFor(`/work/sessions/${sid}/a.md`, undefined, undefined), null);
  // 想往上跳目录的不给
  assert.equal(fileUrlFor(`/work/sessions/${sid}/../../etc/passwd`, sid, `/work/sessions/${sid}`), null);
});

/* ── 打磨细节用的两个纯函数 ───────────────────────────────────────── */
test("文件名中间省略：长度没超就原样，超了保留扩展名", () => {
  assert.equal(middleEllipsis("result.md", 22), "result.md");
  const long = middleEllipsis("2026-10-19-季度经营分析报告最终版.json", 22);
  assert.equal(long.length <= 23, true, long);
  assert.equal(long.endsWith(".json"), true, "扩展名必须留着 —— 它就是文件类型");
  assert.equal(long.includes("…"), true);
  // 没有扩展名/带目录也要能处理
  assert.equal(middleEllipsis("a-very-long-name-without-ext", 12).length <= 13, true);
  assert.equal(middleEllipsis("out/sub/报告.md", 8).includes("/"), false);
});

test("文件类型：json/xml/图片/表格/代码分开认", () => {
  assert.equal(fileTypeKey("a.json"), "json");
  assert.equal(fileTypeKey("feed.xml"), "xml");
  assert.equal(fileTypeKey("page.html"), "xml");
  assert.equal(fileTypeKey("shot.PNG"), "image");
  assert.equal(fileTypeKey("list.csv"), "sheet");
  assert.equal(fileTypeKey("main.py"), "code");
  assert.equal(fileTypeKey("readme.md"), "text");
  assert.equal(fileTypeKey("pkg.tar.gz"), "archive");
  assert.equal(fileTypeKey("noext"), "other");
});
