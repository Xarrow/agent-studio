/**
 * 前端访问口令（HTTP Basic）。
 *
 * 为什么前端也要拦，光拦 API 不够
 * ------------------------------
 * 概览页（app/page.tsx）是**服务端组件**，它在 Next.js 服务端取数 —— 而服务端
 * 跑在内网，访问 API 是免口令的（后端刻意放行内网）。结果是：API 那边拦住了，
 * 但任何人只要打开公网前端域名，SSR 就会替他把数据取回来渲染出来。
 * 所以**入口这一层必须自己拦**。
 *
 * 为什么用 Basic 而不是自定义登录页
 * --------------------------------
 * 浏览器原生弹窗：不需要登录页、不需要会话管理、不需要额外存储，天然覆盖
 * 页面/SSR/静态资源全部路径。对"暂时加个口令"这个诉求是最省事的。
 *
 * 那个 cookie 是干嘛的（为什么故意不是 httpOnly）
 * ---------------------------------------------
 * 页面加载后还要**在浏览器里**调 API（另一个域名 dev-api），浏览器不会把
 * Basic 口令带过去。这里在认证通过时顺手写一个普通 cookie，让前端 JS 能读到
 * 口令并放进 API 请求里 —— **用户因此只需要输一次口令**，而不是"页面弹一次、
 * 再手动粘一次"。
 *
 * 安全边界：能读到这个 cookie 的前提是**已经通过了 Basic 认证**（否则页面
 * 根本加载不出来），所以它没有额外扩大暴露面。
 * 口令留空 = 不启用（内网访问不受影响）。
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const TOKEN = (process.env.STUDIO_ACCESS_TOKEN ?? "").trim();
const COOKIE_NAME = "studio_token";

export function middleware(req: NextRequest) {
  // 没配口令 = 不启用（保持原来的无认证行为）
  if (!TOKEN) return NextResponse.next();

  // 只拦「经 Cloudflare 隧道」的请求。
  // 判据：CF-Connecting-IP 是 Cloudflare 加的，只有走隧道才会有；直连内网
  // （http://192.168.2.11:3000）不带这个头。
  // 为什么必须区分：内网是信任域，本机浏览器/脚本/开发都不该被口令打扰；
  // 而公网那一侧才是需要拦的（前端页面是 SSR 的，不拦会把数据直接渲染给外人）。
  const viaCloudflare =
    req.headers.has("cf-connecting-ip") || req.headers.has("cf-ray");
  if (!viaCloudflare) return NextResponse.next();

  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const raw = atob(auth.slice(6));
      const idx = raw.indexOf(":");
      const user = idx >= 0 ? raw.slice(0, idx) : raw;
      const pwd = idx >= 0 ? raw.slice(idx + 1) : "";
      // 用户名或密码任一填口令都认 —— 浏览器弹窗对用户更宽容
      if ((pwd || user).trim() === TOKEN) {
        const res = NextResponse.next();
        if (req.cookies.get(COOKIE_NAME)?.value !== TOKEN) {
          res.cookies.set(COOKIE_NAME, TOKEN, {
            path: "/",
            sameSite: "lax",
            // 刻意不设 httpOnly：前端 JS 要读它去调 API
          });
        }
        return res;
      }
    } catch {
      /* 落到下面统一 401 */
    }
  }

  return new NextResponse("需要访问口令", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Agent Studio", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

export const config = {
  // 除了 Next 内部资源，其余全部走这道门
  matcher: ["/((?!_next/static|_next/image).*)"],
};
