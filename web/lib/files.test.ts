/**
 * 文件识别（lib/files.ts）的护栏 —— node --test，零依赖。
 *
 * 为什么值得守：`looksLikeFilePath` 决定"正文里这一段要不要变成可点的文件卡"。
 * 判宽了 → 满屏小卡片（`npm run build`、`top_k` 都变成文件）；
 * 判窄了 → 真文件点不开（用户投诉的原始问题）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { baseName, extOf, fileKind, fileUrlFor, looksLikeFilePath } from "./files.ts";

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
