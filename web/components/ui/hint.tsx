"use client";

/**
 * 隐形提示 —— 术语旁的问号，hover / 点击才展开**通俗解释**。
 *
 * 产品意图
 * --------
 * 专业术语本身保留（它们是准确的、也是使用者的共同语言），但**不让它们成为门槛**：
 * 每个术语旁边挂一个不抢眼的小问号，鼠标放上去（手机点一下）就用大白话解释。
 * 这样两拨人都被照顾到 ——
 *   ・懂的人：扫一眼就走，界面没有被"降智"
 *   ・不懂的人：不用去搜，原地就懂
 *
 * 设计约束
 * --------
 * ・**不占版面**：默认只是个小问号，读完就走，不打断阅读节奏
 * ・**说人话**：解释里不出现第二个术语（不能用术语解释术语）
 * ・**触屏可用**：手机没有 hover，所以点击也能开；点击外部 / Esc 关闭
 * ・**不溢出屏幕**：靠右的提示自动改为右对齐
 * ・**零依赖**：自研，不引第三方 tooltip 库（本项目既定原则）
 *
 * 用法
 * ----
 *   <Hint text="你交代事，它自己想办法">Agent</Hint>
 *   <Hint text="……" />                 // 只显示问号（术语在别处时用）
 *   <Hint text="……" side="right" />    // 强制气泡从右侧展开
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function Hint({
  children,
  text,
  className = "",
  side,
}: {
  /** 术语本身（可选）。给了就会带一条很淡的虚线下划线，暗示"这里有解释" */
  children?: ReactNode;
  /** 通俗解释。**用生活语言，不要再用术语** */
  text: ReactNode;
  className?: string;
  /** 强制气泡方向；不给则按屏幕位置自动判断 */
  side?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 气泡宽约 18rem：靠右时会溢出屏幕，改成右对齐
  useLayoutEffect(() => {
    if (!open || !btnRef.current || side) return;
    const r = btnRef.current.getBoundingClientRect();
    setFlip(r.left + r.width / 2 > window.innerWidth * 0.6);
  }, [open, side]);

  const alignRight = side === "right" || (side !== "left" && flip);

  return (
    <span
      ref={wrapRef}
      className={`relative inline-flex items-center gap-[3px] ${className}`}
    >
      {children != null && (
        <span
          className="border-b border-dashed"
          style={{ borderColor: "color-mix(in srgb, var(--color-muted) 45%, transparent)" }}
        >
          {children}
        </span>
      )}
      {/* 触屏点得准：按钮本体是 36×36 的**热区**，视觉仍是 16px 的小圆圈
          （内圈 span 画圆），靠 -m-[10px] 抵掉多出来的 20px ——
          这样行内排版和以前一模一样，但手指点得中。
          别再用 before:-inset-* 假装扩大热区：伪元素不接收点击，
          elementFromPoint 实测外扩 10px 全部落空 ✗。 */}
      <button
        ref={btnRef}
        type="button"
        data-tap
        aria-label="这是什么？"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="relative -m-[10px] flex h-9 w-9 shrink-0 cursor-help items-center justify-center"
      >
        <span
          className="flex h-[16px] w-[16px] items-center justify-center rounded-full text-[10px] font-bold leading-none transition-colors"
          style={{
            border: "1px solid color-mix(in srgb, var(--color-muted) 55%, transparent)",
            color: "var(--color-muted)",
            background: open
              ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
              : "transparent",
          }}
        >
          ?
        </span>
      </button>

      {open && (
        <span
          role="tooltip"
          className={`absolute top-full mt-1.5 z-50 w-[17.5rem] max-w-[calc(100vw-2.5rem)] p-2.5 rounded-md text-[12px] leading-relaxed font-normal shadow-lg ${
            alignRight ? "right-0" : "left-0"
          }`}
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            whiteSpace: "normal",
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * 术语表 —— 集中存放通俗解释，避免同一条解释在多处写得不一样。
 *
 * 写法要求：**读完这句就能用起来**，不要出现第二个术语。
 */
export const HINTS = {
  agent: "你告诉它要什么，它自己决定怎么做",
  runtime:
    "运行引擎；内置一种，不用选",
  provider: "提供 AI 能力的服务商",
  model: "贵的更聪明，便宜的更快",
  credential:
    "AI 的钥匙，本机加密保存",
  systemPrompt:
    "它是谁、什么风格、能做什么、不许做什么",
  maxIters:
    "最多走几步；-1 = 不限",
  timeout: "最多等多久，超时就报错",
  temperature:
    "往左更稳，往右更活",
  hitl: "有风险的动作先问你",
  thinking: "把推理过程也展示给你",
  skill: "预置的做事套路，装上照着做",
  tool: "能查网页、读文件、跑命令；不加只能聊天",
  multiTurn: "记得前面聊过什么",
  memory:
    "跨对话的长期记性",
  memoryRecall: "开始前自动挑相关记忆塞给它",
  memoryAuto: "聊完自动判断要不要记住",
  memoryScope: "给某个 AI 用，还是全都能用",
  compress:
    "超过这个轮数就把前面浓缩成摘要",
  token: "AI 的字数单位，一个汉字约 1～2 个",
  ttft: "按下发送到出第一个字的时间",
  run: "一次执行：你说什么、它做什么、花多久",
  span: "一个细小步骤，看时间花在哪",
  provider_lc: "服务商（提供 AI 的公司）",
} as const;
