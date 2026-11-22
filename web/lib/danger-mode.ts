/**
 * 危险模式的状态同步（设置页 ↔ 顶栏常驻提示）
 * ============================================
 *
 * 为什么单独一个文件：顶栏的提示条和设置页里的开关是两处渲染，状态一变两边
 * 都得立刻知道。用一个自定义事件 + localStorage 做一个极小的广播，避免为了
 * 一个布尔值把两棵树用 context 串起来（它们不在同一条渲染路径上）。
 *
 * 真相仍然在服务端（app_setting.file_policy_danger_mode）：这里的缓存只用于
 * 首帧不闪，页面加载后一律以接口返回为准。
 */

export const DANGER_MODE_KEY = "file_policy_danger_mode";

export function cachedDangerMode(): boolean {
  try {
    return window.localStorage.getItem("studio.dangermode") === "1";
  } catch {
    return false;
  }
}

export function broadcastDangerMode(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("studio.dangermode", on ? "1" : "0");
  } catch {
    /* 无痕模式等本地存储不可用：忽略，事件仍然会发 */
  }
  window.dispatchEvent(new CustomEvent("studio:dangermode", { detail: on }));
}
