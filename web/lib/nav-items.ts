/**
 * 导航菜单项 —— 侧栏（Nav）和手机会话抽屉（ChatConsole）共用这一份。
 *
 * 为什么抽出来：对话页在手机上不再出全局顶栏（顶栏由 ChatConsole 自己出，
 * 那条只有「菜单 + 当前助手 + 配置」），全局导航就没有入口了。
 * 入口放回会话抽屉底部；两处各写一份菜单迟早会漂移，所以只留一份定义。
 */

export type NavItem = { href: string; label: string; icon: string; tip: string; short?: string };

/** 使用 —— 日常干活的入口（对话页自己就是这一项，抽屉里不必重复列） */
export const USE_ITEMS: NavItem[] = [
  {
    href: "/exec",
    label: "Agent 执行",
    icon: "exec",
    // 对话式干活入口（画布已退役）：选一个助手、说话、看它怎么想怎么做。
    tip: "选助手，说任务，全程可见",
  },
];

/** 配置 / 管理 —— 一次性设置的地方 */
export const SETUP_ITEMS: NavItem[] = [
  { href: "/runs", label: "管理", icon: "manage", tip: "每次执行一行，点开看过程与耗时" },
  { href: "/agents", label: "Agents", icon: "agents", tip: "一个会自己想办法做事的 AI" },
  { href: "/memories", label: "记忆", icon: "memory", tip: "跨对话的长期记性" },
  { href: "/tools", label: "工具", icon: "tools", tip: "能查网页、读文件、跑命令；不加只能聊天" },
  { href: "/remote-agents", label: "远程 Agent 管理", icon: "exchange", tip: "接入外部 A2A agent，挂到助手调用" },
  { href: "/environment", label: "环境配置", icon: "database", tip: "数据存哪：默认 SQLite，也可换 MySQL / PostgreSQL" },
  { href: "/credentials", label: "LLM 配置", icon: "key", tip: "模型服务商的密钥，本机加密保存" },
];

/** 图标路径（24×24 描边）：与 NavItem.icon 对应 */
export const ICON_PATHS: Record<string, string> = {
  exec: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z", // 对话气泡
  manage: "M4 6h16M4 12h16M4 18h10", // 列表
  agents: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5", // 立方体
  memory: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4", // 芯片/记忆
  tools: "M14.7 6.3a4.5 4.5 0 0 0-6 5.9L3 18l3 3 5.8-5.7a4.5 4.5 0 0 0 5.9-6L14 13l-3-3 3.7-3.7z", // 扳手
  exchange: "M7 16l-4-4 4-4M3 12h18M17 8l4 4-4 4M21 12", // 双向箭头
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3", // 数据库
  key: "M14.5 4a5.5 5.5 0 1 1-4.9 8L4 17.6V20h2.4l1-1v-2h2v-2h2l1.2-1.2A5.5 5.5 0 0 1 14.5 4z", // 钥匙
};
