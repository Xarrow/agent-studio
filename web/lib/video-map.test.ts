/**
 * 坐标换算护栏 —— 任何宽高比下面板点击零系统性偏移。
 *
 * 守的是实测过的病根：写死 800×600 + object-top，面板是 9:16 / 16:9 时
 * 点击整体偏一段；用户点搜索框点到旁边，还以为是"没反应"。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { contentBox, mapToPage, pageDims } from "./video-map.ts";

test("16:10 画面放进 16:10 容器：内容铺满、无留白", () => {
  const box = contentBox(640, 400, 1280, 800);
  assert.equal(box.ox, 0);
  assert.equal(box.oy, 0);
  assert.equal(box.dw, 640);
  assert.equal(box.dh, 400);
  assert.equal(box.scale, 0.5);
  const p = mapToPage(320, 200, 640, 400, 1280, 800);
  assert.deepEqual(p, { x: 640, y: 400, inside: true });
});

test("宽容器（面板偏扁）：左右留白，点留白不算点中", () => {
  // 容器 800×400 放 16:10 画面 → 内容 640×400，左右各留 80
  const box = contentBox(800, 400, 1280, 800);
  assert.equal(box.dw, 640);
  assert.equal(box.ox, 80);
  assert.equal(mapToPage(40, 200, 800, 400, 1280, 800).inside, false);
  assert.equal(mapToPage(400, 200, 800, 400, 1280, 800).x, 640);
  // 左上角刚好是内容区左上角
  assert.deepEqual(mapToPage(80, 0, 800, 400, 1280, 800), { x: 0, y: 0, inside: true });
  // 右下角
  assert.deepEqual(mapToPage(720, 400, 800, 400, 1280, 800), { x: 1280, y: 800, inside: true });
});

test("窄高容器（手机浮层）：上下留白，纵向贴顶", () => {
  // 容器 360×600 放 16:10 → 内容 360×225，下方留 375
  const box = contentBox(360, 600, 1280, 800);
  assert.equal(box.dw, 360);
  assert.equal(box.dh, 225);
  assert.equal(box.oy, 0);
  assert.equal(mapToPage(180, 500, 360, 600, 1280, 800).inside, false);
  assert.deepEqual(mapToPage(180, 112.5, 360, 600, 1280, 800), { x: 640, y: 400, inside: true });
});

test("4:3 画面放进 16:9 容器：左右留白，比例正确", () => {
  // 容器 800×450 放 800×600 → 内容 600×450，左右各 100
  const box = contentBox(800, 450, 800, 600);
  assert.equal(box.dw, 600);
  assert.equal(box.ox, 100);
  assert.equal(box.scale, 0.75);
  assert.deepEqual(mapToPage(100, 0, 800, 450, 800, 600), { x: 0, y: 0, inside: true });
  assert.deepEqual(mapToPage(700, 450, 800, 450, 800, 600), { x: 800, y: 600, inside: true });
});

test("尺寸还没就绪时不炸（返回整块容器）", () => {
  assert.deepEqual(contentBox(0, 0, 0, 0), { ox: 0, oy: 0, dw: 0, dh: 0, scale: 1 });
  const p = mapToPage(10, 10, 100, 100, 0, 0);
  assert.equal(p.inside, true);
});

test("画面像素 ≠ 页面像素时，点击换算必须用页面坐标", () => {
  // 实测：Bing 首页静止 → 视频轨从 1280 降到 960、640，页面仍是 1280×800。
  // 拿画面尺寸当页面尺寸，点 (640,400) 会落到页面 (1280,800) —— 整体偏 2 倍，
  // 表现就是「点搜索框点到旁边 / 点了空白处」。
  assert.deepEqual(pageDims(640, 400, { width: 1280, height: 800 }), { w: 1280, h: 800 });
  assert.deepEqual(pageDims(960, 600, { width: 1280, height: 800 }), { w: 1280, h: 800 });
  // JPEG 兼容模式按 800 宽推流，页面还是 1280 —— 同样要换回页面坐标
  assert.deepEqual(pageDims(800, 500, { width: 1280, height: 800 }), { w: 1280, h: 800 });
  // 比例对不上（异常/裁切）时保留画面尺寸：至少不会比原来更偏
  assert.deepEqual(pageDims(640, 480, { width: 1280, height: 800 }), { w: 640, h: 480 });
  // 没有页面尺寸（老后端/还没同步）时保持旧行为
  assert.deepEqual(pageDims(960, 600, null), { w: 960, h: 600 });
  // 换成页面尺寸后点内容中心，落在页面中心
  const d = pageDims(640, 400, { width: 1280, height: 800 });
  assert.deepEqual(mapToPage(320, 200, 640, 400, d.w, d.h), { x: 640, y: 400, inside: true });
});
