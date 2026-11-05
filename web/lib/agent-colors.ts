/**
 * 按助手分色（纯函数，可单测）
 * ========================
 *
 * 编排者一口气派好几个助手时，界面上如果全是同一个颜色，用户得逐个读名字
 * 才知道"这一截是谁在跑"。颜色在这里不是装饰，是**身份**。
 *
 * 三条口径：
 * ① 同一份数据里颜色**稳定**：按首次出现顺序发色，刷新、展开、重排都不变色
 * ② 不撞功能色：避开红（失败）、黄（等待）、灰（次要），只做分辨不改语义
 * ③ 超过调色板长度就循环 —— 认得出"这是另一个"，比追求全局唯一更重要
 */

/** 8 个可区分的颜色（浅色主题下对比度够，色盲友好度尚可） */
export const AGENT_PALETTE = [
  "#2563eb", // 蓝
  "#0d9488", // 青绿
  "#7c3aed", // 紫
  "#b45309", // 琥珀（避开纯红）
  "#0891b2", // 天蓝
  "#be185d", // 玫红（与失败红区分：偏粉、更暗）
  "#4d7c0f", // 橄榄绿
  "#4338ca", // 靛蓝
];

/**
 * 名字列表 → 名字到颜色的映射。按传入顺序发色（调用方给"首次出现顺序"）。
 */
export function agentColorMap(names: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  let next = 0;
  for (const raw of names) {
    const name = (raw || "").trim();
    if (!name || map[name]) continue;
    map[name] = AGENT_PALETTE[next % AGENT_PALETTE.length];
    next += 1;
  }
  return map;
}

/** 取色；没登记的（比如普通工具）返回 fallback */
export function colorFor(map: Record<string, string>, name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  return map[name.trim()] || fallback;
}
