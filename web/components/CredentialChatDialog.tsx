"use client";

/**
 * 「对话测试」—— 在 LLM 配置页直接跟模型聊两句。
 *
 * 为什么要有它（跟 Agent 试跑分开）
 * --------------------------------
 * 配一个模型要验证两件**互相独立**的事：
 *   ① 这把 key + 这个端点 + 这个模型，能不能正常对话？
 *   ② 这个助手的提示词 / 工具 / 记忆配得对不对？
 * 混在一起测，一旦报错就分不清是哪一层 —— 而且要先建好助手才能验证 ①，
 * 建助手又依赖 ①。分开之后，①在这里当场就能确认。
 *
 * 刻意做得很轻：不带工具、不带记忆、不带系统提示词，就是一段裸对话。
 * 只有裸对话通过，才能说明问题出在别处。
 */

import { useEffect, useRef, useState } from "react";
import { useImeGuard } from "@/lib/ime";
import { api, fmt } from "@/lib/api";
import type { Credential } from "@/lib/types";
import { DLG_BACKDROP, DLG_CARD } from "@/components/ui/kit";

type Turn = {
  role: "user" | "assistant";
  content: string;
  /** 助手轮才有的附加信息：耗时 / token / 出错的原文 */
  meta?: string;
  failed?: boolean;
};

export function CredentialChatDialog({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [model, setModel] = useState(credential.default_model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  /** 输入法守卫：中文组字没上屏时回车是选字，不是发送 */
  const ime = useImeGuard();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [probing, setProbing] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 拉该凭据可用的模型（复用探测；探不到就用推荐清单兜底）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.credentialModels(credential.id);
        if (!alive) return;
        const list = (r.models?.length ? r.models : (r.suggested ?? [])) || [];
        const all = Array.from(
          new Set([...(credential.default_model ? [credential.default_model] : []), ...list]),
        );
        setModels(all);
        setModel((cur) => cur || all[0] || "");
      } catch {
        if (alive) setModels(credential.default_model ? [credential.default_model] : []);
      } finally {
        if (alive) setProbing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [credential.id, credential.default_model]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!model) {
      setErr("还没选模型 —— 先在上方选一个。");
      return;
    }
    setErr(null);
    setInput("");

    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(history);
    setBusy(true);
    try {
      const r = await api.credentialChat(credential.id, {
        model,
        // 只把对话内容发过去（meta 是本地展示用的，不发给模型）
        messages: history
          .filter((t) => t.role === "user" || t.role === "assistant")
          .map((t) => ({ role: t.role, content: t.content })),
      });
      if (r.ok && r.reply) {
        const u = r.usage ?? {};
        const tk = u.total_tokens ? ` · ${u.total_tokens} tokens` : "";
        setTurns((prev) => [
          ...prev,
          { role: "assistant", content: r.reply as string, meta: `${fmt.ms(r.latency_ms)}${tk}` },
        ]);
      } else {
        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: r.error || "调用失败",
            meta: r.latency_ms ? fmt.ms(r.latency_ms) : undefined,
            failed: true,
          },
        ]);
      }
    } catch (e) {
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: e instanceof Error ? e.message : String(e),
          failed: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} max-w-2xl p-5 flex flex-col`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-[16px] font-medium">对话测试 · {credential.name}</h2>
            <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
              直接跟模型聊，不经过助手 —— 用来确认「这把 key + 这个模型」本身能通
            </p>
          </div>
          <button className="btn shrink-0" onClick={onClose}>
            关闭
          </button>
        </div>

        {/* 模型选择 */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[12px] text-[var(--color-muted)] shrink-0">模型</span>
          <select
            className="input mono flex-1"
            value={model}
            disabled={probing || !models.length}
            onChange={(e) => setModel(e.target.value)}
          >
            {probing && <option value={model}>取模型中…</option>}
            {!probing && !models.length && <option value="">（没有可用模型，先去编辑里选）</option>}
            {!probing &&
              models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
          </select>
          {turns.length > 0 && (
            <button className="btn shrink-0" onClick={() => setTurns([])}>
              清空
            </button>
          )}
        </div>

        {/* 对话区 */}
        <div
          ref={boxRef}
          className="flex-1 overflow-y-auto rounded-md p-3 space-y-2.5 min-h-[220px]"
          style={{ background: "var(--color-surface-2)" }}
        >
          {turns.length === 0 && !busy && (
            <p className="text-[12.5px] text-[var(--color-muted)] text-center py-10">
              随便问一句，看看它答不答得上来。
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "text-right" : ""}>
              <div
                className="inline-block text-left max-w-[85%] rounded-md px-3 py-2 text-[13px] whitespace-pre-wrap break-words"
                style={{
                  background:
                    t.role === "user"
                      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                      : "var(--color-surface)",
                  color: t.failed ? "var(--color-err)" : "var(--color-text)",
                }}
              >
                {t.content}
              </div>
              {t.meta && (
                <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5">{t.meta}</div>
              )}
            </div>
          ))}
          {busy && (
            <div className="text-[12.5px] text-[var(--color-muted)]">思考中…</div>
          )}
        </div>

        {err && <div className="text-[12.5px] text-[var(--color-err)] mt-2">{err}</div>}

        {/* 输入 */}
        <div className="flex gap-2 mt-3">
          <input
            className="input flex-1"
            value={input}
            placeholder="输入消息，回车发送（中文组字中回车是选字）"
            disabled={busy}
            {...ime.props}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if (ime.blocked(e)) return;
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn btn-primary shrink-0" disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
