/**
 * 工作目录路径 → URL 的解析测试（node --test，零依赖）
 * ====================================================
 *
 * 守的是用户报过的真问题：「我需要页面上给出图片，而不是给出 Agent 服务器路径」——
 * 模型在 stdout 里抄了一行 `/srv/.../data/work/youtube_homepage.png`，
 * 页面必须把它当成图片显示出来，而且**消息正文 / 执行过程 / 完整记录**
 * 三处判定要一致。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isImagePath, linkifyWorkPaths, mentionsWorkFile, workImageUrls, workUrl } from "./work-paths.ts";

const ABS = "/srv/src/agent-studio/data/work/youtube_homepage.png";
const API = "/api/work/file/youtube_homepage.png";

test("绝对路径 / 相对路径 / 已是接口地址 → 都归一化成 /api/work/file/<rel>", () => {
  assert.equal(workUrl(ABS), API);
  assert.equal(workUrl("data/work/youtube_homepage.png"), API);
  assert.equal(workUrl(API), API, "已经是接口地址的不该被二次拼接");
  assert.equal(workUrl(""), "");
  assert.equal(workUrl("   "), "");
});

test("子目录与中文文件名也认", () => {
  assert.equal(workUrl("/srv/x/data/work/skills/a/SKILL.md"), "/api/work/file/skills/a/SKILL.md");
  assert.equal(workUrl("data/work/上海天气.png"), "/api/work/file/上海天气.png");
});

test("带空格的产物名：宁可不成链接，也不能拼出坏 URL", () => {
  // 认空格会让正则横跨空格吞掉后面的文本（a.png 和 /srv/x/data/work/b.jpg
  // 被拼成一个路径）—— 实测过，所以这里放宽为「不匹配」。
  const bad = "data/work/我的 截图 (1).png";
  assert.deepEqual(workImageUrls(bad), []);
  assert.deepEqual(workImageUrls(`见 ${bad} 和 /srv/x/data/work/ok.png`), ["/api/work/file/ok.png"]);
});

test("相关：只有图片后缀算图片", () => {
  assert.equal(isImagePath("a.png"), true);
  assert.equal(isImagePath("a.JPEG"), true);
  assert.equal(isImagePath("a.webp"), true);
  assert.equal(isImagePath("result.md"), false);
  assert.equal(isImagePath("a.png.bak"), false);
});

test("从 bash 输出里认出图片（真实那条：bytes written to file …）", () => {
  const out = `ALSA lib conf.c:5205:(_snd_config_evaluate) function snd_func_refer returned error: No such file or directory
[381567:381567:1016/134332.979590:ERROR:media/audio/alsa/alsa_util.cc:204] PcmOpen: plug:default,No such file or directory
76053 bytes written to file ${ABS}
-rw-r--r-- 1 root root 76053 Oct 16 13:43 ${ABS}`;
  assert.deepEqual(workImageUrls(out), [API], "同一张图出现两次只显示一次");
});

test("非图片文件不会变成图片（md / json / py）", () => {
  const t = "/srv/x/data/work/result.md /srv/x/data/work/baidu_hot.json /srv/x/data/work/primes.py";
  assert.deepEqual(workImageUrls(t), []);
  assert.equal(mentionsWorkFile(t), true, "但确实提到了工作目录文件");
});

test("多张图：保序 + 去重", () => {
  const t = `${ABS} 和 /srv/x/data/work/b.jpg，再来一次 ${ABS}`;
  assert.deepEqual(workImageUrls(t), [API, "/api/work/file/b.jpg"]);
});

test("大小写后缀、无匹配时返回空数组", () => {
  assert.deepEqual(workImageUrls("/srv/x/data/work/a.PNG"), ["/api/work/file/a.PNG"]);
  assert.deepEqual(workImageUrls("没有任何路径"), []);
  assert.deepEqual(workImageUrls(""), []);
});

test("不会把普通 URL 误当工作目录图片", () => {
  assert.deepEqual(workImageUrls("https://example.com/data/work/x.png"), [], "外部站点上的同名目录不是我们的产物");
  assert.deepEqual(workImageUrls("https://example.com/pic.png"), []);
});

test("正文转换：绝对路径 / 相对路径 / inline code 里的路径都要变成可看的", () => {
  const abs = `截图已保存：\`/srv/src/agent-studio/data/work/youtube_homepage.png\``;
  const out = linkifyWorkPaths(abs);
  assert.match(out, /!\[youtube_homepage\.png\]\(\/api\/work\/file\/youtube_homepage\.png\)/, "图片路径要变成内联图片");
  assert.doesNotMatch(out, /\n\n!\[/, "标签后面的图要紧贴标签，不能另起段落（否则标签变成孤零零一行）");
  assert.doesNotMatch(out, /\/srv\/src\/agent-studio/, "不能再把服务器绝对路径留在正文里");

  const rel = "产物在 data/work/result.md，图片 data/work/shot.png";
  const out2 = linkifyWorkPaths(rel);
  assert.match(out2, /\[result\.md\]\(\/api\/work\/file\/result\.md\)/, "非图片给可点链接");
  assert.match(out2, /!\[shot\.png\]\(\/api\/work\/file\/shot\.png\)/, "图片内联");
});

test("正文转换：普通文本不受影响（没有产物路径时一字不改）", () => {
  const t = "这是一段普通回答，含 /usr/bin 和 https://example.com/a.png";
  assert.equal(linkifyWorkPaths(t), t);
});

test("整行只有一个裸路径时给它自己的段落（图不跟文字挤一起）", () => {
  const t = "看这里\n/srv/x/data/work/alone.png\n再见";
  const out = linkifyWorkPaths(t);
  assert.match(out, /\n\n!\[alone\.png\]/, "独占一行的产物图应当块级展示");
});
