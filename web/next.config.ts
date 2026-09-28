import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 静态导出：部署机不依赖 Node（FastAPI 同进程托管 out/）
  output: "export",
  // Next.js 16 默认阻止跨源访问 dev 资源（/_next/*），
  // 用 IP 而非 localhost 访问时会导致 JS 加载失败、组件无法 hydrate。
  // 内网自托管场景统一放行这些 host。
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "192.168.2.11",
    "192.168.2.7",
    "192.168.2.13",
  ],
  // 关闭开发浮标：它默认停在左下角，会压住侧栏的主题切换器
  devIndicators: false,
};

export default nextConfig;
