import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { FeedbackProvider } from "@/components/ui/feedback";
import { AccessGate } from "@/components/AccessGate";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "可视化 Agent 配置与运行观测平台",
};

/**
 * 主题固定为浅色。
 *
 * 说明：界面上的明暗切换入口已按需求移除；深色主题的 CSS 变量（globals.css
 * 里的 [data-theme="dark"]）保留未删，日后若要恢复切换，只需在导航里重新挂
 * 一个 ThemeToggle 并把下面这行改回读 localStorage 即可。
 */
const THEME_INIT = `document.documentElement.setAttribute('data-theme', 'light');`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      {/* suppressHydrationWarning：浏览器扩展常在 body 注入属性/节点，
          会让 React 报 hydration 不匹配。这里显式忽略顶层差异。 */}
      <body className="antialiased" suppressHydrationWarning>
        <FeedbackProvider>
          {/* 公网访问的口令浮层：收到 401 时自动弹出（内网直连不会出现） */}
          <AccessGate />
          <div className="flex h-screen overflow-hidden">
            <Nav />
            {/* pt-14：移动端顶部栏是 fixed，需要给内容留出高度（≥768px 无顶栏） */}
            <main className="flex-1 overflow-auto pt-14 md:pt-0">{children}</main>
          </div>
        </FeedbackProvider>
      </body>
    </html>
  );
}
