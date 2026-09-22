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
 *   <Hint text="它会自己想办法完成你交代的事，不用你一步步指挥">Agent</Hint>
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
      <button
        ref={btnRef}
        type="button"
        aria-label="这是什么？"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="shrink-0 w-[13px] h-[13px] rounded-full flex items-center justify-center text-[9px] font-bold leading-none transition-colors cursor-help"
        style={{
          border: "1px solid color-mix(in srgb, var(--color-muted) 55%, transparent)",
          color: "var(--color-muted)",
          background: open
            ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
            : "transparent",
        }}
      >
        ?
      </button>

      {open && (
        <span
          role="tooltip"
          className={`absolute top-full mt-1.5 z-50 w-[17.5rem] max-w-[calc(100vw-2.5rem)] p-2.5 rounded-md text-[11.5px] leading-relaxed font-normal shadow-lg ${
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
  agent: "一个会自己想办法帮你做事的 AI。你告诉它要什么，它自己决定怎么做。",
  runtime:
    "运行这个 AI 的「引擎」。不同引擎擅长的东西不同（比如有的支持边想边做、有的支持让你中途确认）。现阶段系统内置一种，不用选。",
  provider: "提供 AI 能力的服务商（比如 DeepSeek、OpenAI）。就像选哪家公司的手机卡。",
  model: "同一家服务商里有不同的档位，贵的更聪明、便宜的更快。",
  credential:
    "让 AI 能工作的钥匙（一串密码）。在这台机器上加密保存，不会明文显示出来。",
  systemPrompt:
    "给这个 AI 的「一开始的交代」：它是谁、要按什么风格说话、什么能做、什么不许做。写得越具体，它越懂你。",
  maxIters:
    "收到你的要求后，它最多可以自己想几步。设成 -1 表示不限步数，直到它觉得做完了为止。",
  timeout: "一次任务最多等多久。超过就停下并报错，避免一直卡着。",
  temperature:
    "回答有多自由。往左更稳、更贴事实；往右更活跃、更会发挥。做正经事就调左一点。",
  hitl: "它打算做有风险的动作时（比如执行命令），先停下来问你同不同意，你点头它才做。",
  thinking: "它把推理过程也展示给你看，方便你确认它没想歪。",
  skill: "预先写好的「做事套路」。装上之后它就知道这类任务该按什么步骤做。",
  tool: "给它加一只「手」：能查网页、读文件、跑命令之类。不加就只能聊天。",
  multiTurn: "它记得这个对话里前面聊过什么，可以接着往下说，不用重复。",
  memory:
    "跨对话的长期记性：它会把值得记的事存下来，以后每次聊天前自动想起来。",
  memoryRecall: "聊天开始前，自动从长期记性里挑出和这次相关的部分塞给它。",
  memoryAuto: "聊完以后，它自己判断这次有没有值得长期记住的事，有就存下来。",
  memoryScope: "这条记性给谁用：只给某一个 AI，还是所有 AI 都能用。",
  compress:
    "聊得太长会超出 AI 一次能处理的量，超过这个轮数就把前面的内容浓缩成摘要。",
  token: "AI 眼里的「字数」单位。一个汉字大约 1～2 个，一段话几百个。",
  ttft: "从你按下发送，到它吐出第一个字花了多久。越短越感觉「反应快」。",
  run: "一次完整的执行记录：你说什么、它想什么、做了什么、花了多久。",
  span: "执行过程中的一个细小步骤，用来排查「时间都花在哪了」。",
  provider_lc: "服务商（提供 AI 的公司）",
} as const;
