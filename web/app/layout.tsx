import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { FeedbackProvider } from "@/components/ui/feedback";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "可视化 Agent 配置与运行观测平台",
};

/**
 * 在 HTML 解析阶段就定好主题，避免刷新时先白后黑的闪烁。
 * 默认 light（未设置或非 dark 时一律 light）。
 */
const THEME_INIT = `
try {
  var t = localStorage.getItem('agent-studio-theme');
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
}
`;

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
