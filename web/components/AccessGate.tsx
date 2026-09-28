"use client";

/**
 * 访问口令浮层。
 *
 * 什么时候出现
 * ------------
 * 任何请求收到 401 就广播 ``AUTH_REQUIRED_EVENT``，本组件监听到就弹出来。
 * 另外首次加载会主动探一次受保护接口 —— 这样"直接打开页面"也能立刻看到
 * 输入框，而不是先看到一堆加载失败。
 *
 * 为什么不用浏览器原生的 Basic 认证弹窗
 * ------------------------------------
 * 平台分两个域名（页面 / API），原生弹窗会**按域名各弹一次**；更要命的是
 * 跨域 fetch **不会**自动带上浏览器缓存的口令，所以原生弹窗这条路根本走不通。
 *
 * 验证通过后为什么刷新整页
 * ------------------------
 * 已经失败的请求不会自己重试；刷新一次让所有页面用带口令的请求重新拉，
 * 免得留下"有的地方有数据、有的地方空白"的中间态。
 *
 * 内网直连（后端不校验口令）时这个浮层永远不会出现。
 */

import { useEffect, useState } from "react";
import { AUTH_REQUIRED_EVENT, api, setAccessToken } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";

export function AccessGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onAuthRequired = () => setOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);

    // 主动探一次：不带口令时这里就会 401，从而触发上面的广播。
    // 内网直连时它静静成功，不会有任何打扰。
    void api.providers().catch(() => {
      /* 401 已由 request() 广播；其它错误留给各页面自己提示 */
    });

    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const submit = async () => {
    const t = value.trim();
    if (!t) {
      setErr("请输入访问口令");
      return;
    }
    setBusy(true);
    setErr(null);
    setAccessToken(t); // 先存上，下面的探测才会带上它
    try {
      await api.providers();
      window.location.reload(); // 通过 —— 刷新让所有页面重新取数
    } catch (e) {
      setAccessToken(""); // 不对就清掉，别留个坏口令反复失败
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.includes("口令") ? "口令不对，请重新输入" : msg);
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
         style={{ background: "color-mix(in srgb, var(--color-overlay) 85%, transparent)" }}>
      <div className="card w-full max-w-sm p-5">
        <h2 className="text-[16px] font-medium mb-1">需要访问口令</h2>
        <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
          这个平台对公网访问做了口令保护。输入一次即可，之后会记住。
        </p>

        <label className="label">访问口令</label>
        <input
          className="input mono"
          type="password"
          autoFocus
          value={value}
          placeholder="粘贴或输入口令"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 输入法候选没上屏时的回车是选字（口令也可能是中文输入法状态下的手误）
            if (e.key === "Enter" && !isImeEvent(e)) void submit();
          }}
        />
        {err && <div className="text-[12.5px] text-[var(--color-err)] mt-2">{err}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "验证中…" : "进入"}
          </button>
        </div>
      </div>
    </div>
  );
}
