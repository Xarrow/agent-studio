/**
 * 坐标换算护栏 —— 任何宽高比下面板点击零系统性偏移。
 *
 * 守的是实测过的病根：写死 800×600 + object-top，面板是 9:16 / 16:9 时
 * 点击整体偏一段；用户点搜索框点到旁边，还以为是"没反应"。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { contentBox, mapToPage } from "./video-map.ts";

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
