"use client";

/**
 * ⌘K / Ctrl+K 命令面板（R5）。
 *
 * 要解决的问题：找一个助手/一条会话/一份文档，得先知道它归在哪个页面
 * （导航四段之后好一些，但仍要 2-3 击 + 自己判断在哪儿）。
 * 这里一次键盘就能搜到，回车直达。
 *
 * 数据在**第一次打开时**才拉，六类并行；之后缓存在内存里，关掉不重复拉。
 * 纯前端过滤：条目规模小（助手十几个、会话几十个），不额外做后端搜索接口。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";
import type { Agent, KnowledgeDoc, Memory, Session, Tool } from "@/lib/types";

type Item = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  /** 命中后去哪儿 */
  href: string;
};

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    try {
      const [agents, ses, mem, docs, tools] = await Promise.allSettled([
        api.agents(),
        api.sessions(),
        api.memories({ status: "active" }),
        api.knowledgeDocs({ limit: 100 }),
        api.tools(),
      ]);
      const out: Item[] = [];

      if (agents.status === "fulfilled") {
        for (const a of agents.value as Agent[]) {
          out.push({
            key: `ag-${a.id}`,
            group: "助手",
            label: a.name,
            hint: a.definition?.model?.name ?? a.runtime,
            href: `/exec?agent=${a.id}`,
          });
        }
      }
      if (ses.status === "fulfilled") {
        for (const s of (ses.value as { list: Session[] }).list ?? []) {
          out.push({
            key: `ses-${s.id}`,
            group: "会话",
            label: s.title || "（无标题会话）",
            hint: new Date(s.last_active_at ?? s.created_at).toLocaleDateString("zh-CN"),
            href: `/exec?s=${s.id}${s.agent_id ? `&agent=${s.agent_id}` : ""}`,
          });
        }
      }
      if (mem.status === "fulfilled") {
        const list = (mem.value as { items?: Memory[] }).items ?? (mem.value as Memory[]);
        for (const m of Array.isArray(list) ? list.slice(0, 60) : []) {
          out.push({
            key: `mem-${m.id}`,
            group: "记忆",
            label: m.content.slice(0, 70),
            hint: m.status,
            href: "/memories",
          });
        }
      }
      if (docs.status === "fulfilled") {
        for (const d of docs.value.items as KnowledgeDoc[]) {
          out.push({
            key: `doc-${d.id}`,
            group: "知识",
            label: d.name,
            href: `/knowledge?doc=${d.id}`,
          });
        }
      }
      if (tools.status === "fulfilled") {
        for (const t of tools.value as Tool[]) {
          if (/^(worker_|proc_|fork_)/.test(t.name)) continue;
          out.push({
            key: `tool-${t.id}`,
            group: "工具",
            label: t.name,
            hint: t.kind,
            href: "/tools",
          });
        }
      }

      // 固定命令（不依赖数据）
      out.push(
        { key: "cmd-new-agent", group: "命令", label: "新建助手", href: "/agents?new=1" },
        { key: "cmd-exec", group: "命令", label: "开一段新对话", href: "/exec" },
        { key: "cmd-runs", group: "命令", label: "运行记录", href: "/runs" },
        { key: "cmd-cred", group: "命令", label: "LLM 配置", href: "/credentials" },
        { key: "cmd-env", group: "命令", label: "系统设置", href: "/environment" },
      );

      setItems(out);
    } finally {
      setLoading(false);
    }
  }, []);

  // ⌘K / Ctrl+K 开关；Esc 关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          const next = !v;
          if (next) {
            setQ("");
            setHi(0);
            void load();
          }
          return next;
        });
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, load]);

  /** 侧栏的搜索按钮派发这个事件（手机没有 ⌘K） */
  useEffect(() => {
    const openIt = () => {
      setQ("");
      setHi(0);
      setOpen(true);
      void load();
    };
    window.addEventListener("as:cmd", openIt);
    return () => window.removeEventListener("as:cmd", openIt);
  }, [load]);

  /** 输入即过滤：每个空格分词都要命中（多个词 = 取交集） */
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return items.slice(0, 40);
    const parts = k.split(/\s+/);
    return items
      .filter((it) => {
        const hay = `${it.label} ${it.hint ?? ""} ${it.group}`.toLowerCase();
        return parts.every((p) => hay.includes(p));
      })
      .slice(0, 60);
  }, [items, q]);

  const go = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    router.push(it.href);
  };

  if (!open || typeof document === "undefined") return null;

  const body = (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/25 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[min(620px,92vw)] overflow-hidden rounded-[14px] shadow-2xl"
        style={{ background: "var(--color-surface)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            // 中文组字中回车是选字，不是「打开这一项」
            if (isImeEvent(e)) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(filtered[hi]);
            }
          }}
          placeholder="搜助手、会话、记忆、知识、工具，或者输入命令…"
          aria-label="搜索"
          className="w-full bg-transparent px-4 py-3.5 text-[length:var(--fs-md)] outline-none"
          style={{ color: "var(--color-text)" }}
        />
        <div className="max-h-[52vh] overflow-y-auto pb-1">
          {loading && filtered.length === 0 && (
            <div className="px-4 py-3 text-[length:var(--fs-base)]" style={{ color: "var(--color-text-3)" }}>
              正在读取…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-4 py-3 text-[length:var(--fs-base)]" style={{ color: "var(--color-text-3)" }}>
              没有匹配项
            </div>
          )}
          {filtered.map((it, i) => {
            const showGroup = i === 0 || filtered[i - 1].group !== it.group;
            return (
              <div key={it.key}>
                {showGroup && (
                  <div
                    className="px-4 pt-2 pb-1 text-[length:var(--fs-xs)] font-semibold tracking-wide"
                    style={{ color: "var(--color-text-3)" }}
                  >
                    {it.group}
                  </div>
                )}
                <button
                  type="button"
                  data-tap
                  onMouseEnter={() => setHi(i)}
                  onClick={() => go(it)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left"
                  style={{ background: i === hi ? "var(--color-surface-2)" : "transparent" }}
                >
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-base)]">{it.label}</span>
                  {it.hint && (
                    <span
                      className="mono shrink-0 truncate text-[length:var(--fs-xs)]"
                      style={{ color: "var(--color-text-3)" }}
                    >
                      {it.hint}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="flex items-center gap-3 px-4 py-2 text-[length:var(--fs-xs)]"
          style={{ color: "var(--color-text-3)", background: "var(--color-surface-2)" }}
        >
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">⌘K</span>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
