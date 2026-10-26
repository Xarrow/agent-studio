"use client";

/**
 * 输入区工具行的「技能」「记忆」两个入口。
 *
 * 为什么各自单独成组件：open 状态留在 ChatConsole 里的话，每开关一次
 * 就会让整个对话页（含消息流里所有 Markdown）重渲染一遍 —— 面板弹出的
 * 那一下会明显顿一下。状态下沉到这里，开关只影响这两个节点。
 *
 * 互斥用一个 window 事件：同一时刻只该有一个浮层开着，
 * 但两个组件的状态互相看不见，所以开之前先广播一声。
 */

import { useEffect, useState } from "react";
import type { Agent } from "@/lib/types";
import { SkillPicker } from "./SkillPicker";
import { ToolPicker } from "./ToolPicker";
import { MemoryPicker } from "./MemoryPicker";

const EVENT = "studio:panel-open";

function useExclusive(name: string) {
  const [open, setOpen] = useState(false);

  // 别人开了 → 自己关
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== name) setOpen(false);
    };
    window.addEventListener(EVENT, onOther);
    return () => window.removeEventListener(EVENT, onOther);
  }, [name]);

  const toggle = () => {
    setOpen((v) => {
      if (!v) window.dispatchEvent(new CustomEvent(EVENT, { detail: name }));
      return !v;
    });
  };

  return { open, setOpen, toggle };
}

/* 桌面带文字：这三颗是「给这轮加技能/工具/记忆」，光看图标认不出来。
   手机仍只留图标 —— 一排排不下，触控区保 36。 */
const btnCls =
  "h-9 w-9 sm:h-8 sm:w-auto sm:px-2 shrink-0 flex items-center justify-center gap-1.5 rounded-xl hover:bg-[var(--color-surface-2)] transition-colors";

/** 桌面才出的文字标签（手机隐掉） */
const Label = ({ children }: { children: string }) => (
  <span className="hidden sm:inline text-[12px] leading-none whitespace-nowrap">{children}</span>
);

export function SkillEntry({
  agent,
  onChanged,
}: {
  agent: Agent | undefined;
  onChanged: () => void;
}) {
  const { open, setOpen, toggle } = useExclusive("skill");
  if (!agent) return null;

  return (
    <>
      <button
        data-tap
        type="button"
        aria-expanded={open}
        title="这个助手挂了哪些技能（点开就地勾选）"
        onClick={toggle}
        className={btnCls}
        style={{ color: open ? "var(--color-accent)" : "var(--color-muted)" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 4 7v6c0 4.4 3.4 7.4 8 8 4.6-.6 8-3.6 8-8V7l-8-4z" />
        </svg>
        <Label>技能</Label>
      </button>
      <SkillPicker agent={agent} onChanged={onChanged} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ToolEntry({
  agent,
  onChanged,
}: {
  agent: Agent | undefined;
  onChanged: () => void;
}) {
  const { open, setOpen, toggle } = useExclusive("tool");
  if (!agent) return null;

  return (
    <>
      <button
        data-tap
        type="button"
        aria-expanded={open}
        title="这个助手挂了哪些工具（点开就地勾选）"
        onClick={toggle}
        className={btnCls}
        style={{ color: open ? "var(--color-accent)" : "var(--color-muted)" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a4 4 0 0 0 5 5L20 21H4l-.7-9.7a4 4 0 0 0 5-5l3.2-3.2 3.2 3.2z" />
        </svg>
        <Label>工具</Label>
      </button>
      <ToolPicker agent={agent} onChanged={onChanged} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function MemoryEntry({ onPick }: { onPick: (text: string) => void }) {
  const { open, setOpen, toggle } = useExclusive("memory");

  return (
    <>
      <button
        data-tap
        type="button"
        aria-expanded={open}
        title="翻一条记忆填进输入框"
        onClick={toggle}
        className={btnCls}
        style={{ color: open ? "var(--color-accent)" : "var(--color-muted)" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16v12H8l-4 4V5z" />
        </svg>
        <Label>记忆</Label>
      </button>
      <MemoryPicker open={open} onOpenChange={setOpen} onPick={onPick} />
    </>
  );
}
