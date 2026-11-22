/**
 * 画面坐标换算 —— **按实际渲染出来的内容框**，不是按容器。
 *
 * 旧实现写死 800×600 + object-top，面板不是 4:3 时点击就整体偏移（用户实测
 * "点搜索框点到旁边"）。现在只认两个数：容器尺寸 + 视频/图片的原始尺寸，
 * 剩下的留白由 object-contain 的规则算出来。
 *
 * 约定：`object-fit: contain` + `object-position: center top`（见 BrowserStage）。
 *   缩放比 = min(容器宽/原始宽, 容器高/原始高)
 *   内容宽高 = 原始尺寸 × 缩放比
 *   横向居中；纵向贴顶 → y 偏移 0
 */

export type ContentBox = {
  /** 内容区左上角在容器内的坐标 */
  ox: number;
  oy: number;
  /** 内容区渲染尺寸 */
  dw: number;
  dh: number;
  scale: number;
};

export function contentBox(
  rectW: number,
  rectH: number,
  naturalW: number,
  naturalH: number,
): ContentBox {
  if (!(rectW > 0) || !(rectH > 0) || !(naturalW > 0) || !(naturalH > 0)) {
    return { ox: 0, oy: 0, dw: rectW, dh: rectH, scale: 1 };
  }
  const scale = Math.min(rectW / naturalW, rectH / naturalH);
  const dw = naturalW * scale;
  const dh = naturalH * scale;
  return { ox: (rectW - dw) / 2, oy: 0, dw, dh, scale };
}

export type MappedPoint = { x: number; y: number; inside: boolean };

/**
 * 点击要落在**页面坐标**里，而画出来的像素尺寸经常不等于页面尺寸：
 * 视频轨会按带宽降档（1280→960→640），JPEG 兼容模式按 800 宽推流。
 * 拿画面尺寸当页面尺寸，静态页面一降档点击就整体偏（640 的画面对 1280 的页面偏 2 倍）。
 *
 * 规则：有页面尺寸（后端给的 viewport）且宽高比与画面一致就换成页面尺寸；
 * 比例对不上（异常）时保留画面尺寸 —— 至少不会比原来更偏。
 */
export function pageDims(
  frameW: number,
  frameH: number,
  viewport?: { width: number; height: number } | null,
): { w: number; h: number } {
  if (viewport && viewport.width > 0 && viewport.height > 0 && frameW > 0 && frameH > 0) {
    const a1 = frameW / frameH;
    const a2 = viewport.width / viewport.height;
    if (Math.abs(a1 - a2) < 0.02) return { w: viewport.width, h: viewport.height };
  }
  return { w: frameW, h: frameH };
}

/** 容器内坐标 → 页面（视频原始像素）坐标；落在留白上 inside=false。 */
export function mapToPage(
  px: number,
  py: number,
  rectW: number,
  rectH: number,
  naturalW: number,
  naturalH: number,
): MappedPoint {
  const box = contentBox(rectW, rectH, naturalW, naturalH);
  const inside = px >= box.ox && px <= box.ox + box.dw && py >= box.oy && py <= box.oy + box.dh;
  if (!inside) return { x: 0, y: 0, inside: false };
  return { x: (px - box.ox) / box.scale, y: (py - box.oy) / box.scale, inside: true };
}
