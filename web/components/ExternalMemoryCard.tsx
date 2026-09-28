"use client";

/**
 * 「外部记忆服务」配置块（记忆页顶部）—— 把别处已有的记忆库接进来。
 *
 * 设计口径：
 *   · **先给结论再给表单**：标题行直接显示"已接入 / 未接入"，不用点开才知道；
 *   · 表单默认收起（没配过时展开一次，配好了就收起 —— 不常驻占地方）；
 *   · 密钥只提交、不回显（后端也只回"配没配"），留空 = 不改；
 *   · 「测试连接」真发一次搜索，把结果或错误原文如实显示（不装作成功）。
 */

import React, { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { ExternalMemoryConfig } from "@/lib/types";
import { Chip } from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";

const DEFAULTS: ExternalMemoryConfig = {
  enabled: false,
  base_url: "",
  search_path: "/search",
  add_path: "/add",
  timeout_s: 15,
  extra_headers: {},
  search_body: {},
  add_body: {},
  results_path: "",
  has_api_key: false,
  ready: false,
};

export function ExternalMemoryCard() {
  const fb = useFeedback();
  const [cfg, setCfg] = useState<ExternalMemoryConfig>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    enabled: false,
    base_url: "",
    api_key: "",
    search_path: "/search",
    add_path: "/add",
    timeout_s: 15,
    // 请求侧映射：用文本编辑（JSON），保存时解析 —— 手机上也只用一个大文本框，不做多行表单
    results_path: "",
    extra_headers: "",
    search_body: "",
    add_body: "",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string; ms?: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = await api.externalMemory();
        if (!alive) return;
        setCfg(got);
        setDraft({
          enabled: got.enabled,
          base_url: got.base_url,
          api_key: "",
          search_path: got.search_path || "/search",
          add_path: got.add_path || "/add",
          timeout_s: got.timeout_s || 15,
          results_path: got.results_path || "",
          extra_headers: Object.keys(got.extra_headers || {}).length
            ? JSON.stringify(got.extra_headers, null, 1)
            : "",
          search_body: Object.keys(got.search_body || {}).length
            ? JSON.stringify(got.search_body, null, 1)
            : "",
          add_body: Object.keys(got.add_body || {}).length
            ? JSON.stringify(got.add_body, null, 1)
            : "",
        });
        // 没接入过就默认展开，省得用户找不到入口
        setOpen(!got.ready);
      } catch {
        /* 读不到就按默认显示，不打扰 */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    // 三个 JSON 字段先解析 —— 坏 JSON 明确报错，别把"没法用"的配置存进去
    const parseJson = (label: string, text: string): Record<string, unknown> | undefined => {
      const t = text.trim();
      if (!t) return undefined; // 空 = 用标准契约
      try {
        const got = JSON.parse(t);
        if (!got || typeof got !== "object" || Array.isArray(got)) {
          throw new Error("要是一个对象");
        }
        return got as Record<string, unknown>;
      } catch (e) {
        throw new Error(`${label}不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        base_url: draft.base_url.trim(),
        search_path: draft.search_path.trim() || "/search",
        add_path: draft.add_path.trim() || "/add",
        timeout_s: Number(draft.timeout_s) || 15,
        results_path: draft.results_path.trim(),
        extra_headers: parseJson("额外请求头", draft.extra_headers) ?? {},
        search_body: parseJson("搜索请求体", draft.search_body) ?? {},
        add_body: parseJson("写入请求体", draft.add_body) ?? {},
      };
      if (draft.api_key.trim()) body.api_key = draft.api_key.trim();
      const saved = await api.saveExternalMemory(
        body as Parameters<typeof api.saveExternalMemory>[0],
      );
      setCfg(saved);
      setDraft((d) => ({ ...d, api_key: "" }));
      setTestResult(null);
      fb.success(saved.ready ? "已接入外部记忆服务" : "已保存（还没填地址或没打开开关）");
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      setTestResult(await api.testExternalMemory());
    } catch (e) {
      setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      const saved = await api.saveExternalMemory({ api_key: "" });
      setCfg(saved);
      fb.success("已清除密钥");
    } catch (e) {
      fb.error("清除失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mb-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[var(--color-muted)]">{open ? "▾" : "▸"}</span>
        <span className="text-[13px] font-medium">外部记忆服务</span>
        {loaded ? (
          cfg.ready ? (
            <Chip tone="ok">已接入</Chip>
          ) : (
            <Chip tone="muted">未接入</Chip>
          )
        ) : null}
        <span className="text-[11.5px] text-[var(--color-muted)]">
          {cfg.ready ? cfg.base_url : "把你自己已有的记忆库接进来（与内置记忆可混用）"}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            />
            <span className="text-[12.5px]">
              启用外部记忆（关掉只是不启用，配置会留着）
              <span className="block text-[11.5px] text-[var(--color-muted)]">
                启用后还要在「助手 → 记忆 → 高级设置 → 记忆从哪来」里选它才会真正用上。
              </span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label">服务地址</label>
              <input
                className="input"
                placeholder="http://192.168.2.11:9000"
                value={draft.base_url}
                onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label">
                访问密钥
                {cfg.has_api_key ? (
                  <span className="ml-2 font-normal text-[var(--color-muted)]">
                    已配置（留空则不改）
                    <button
                      type="button"
                      className="ml-2 text-[var(--color-danger)] underline"
                      onClick={() => void clearKey()}
                      disabled={busy}
                    >
                      清除
                    </button>
                  </span>
                ) : (
                  <span className="ml-2 font-normal text-[var(--color-muted)]">没配就不带鉴权头</span>
                )}
              </label>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder={cfg.has_api_key ? "••••••（留空保持不变）" : "可选"}
                value={draft.api_key}
                onChange={(e) => setDraft((d) => ({ ...d, api_key: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">搜索路径</label>
              <input
                className="input mono"
                value={draft.search_path}
                onChange={(e) => setDraft((d) => ({ ...d, search_path: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">写入路径</label>
              <input
                className="input mono"
                value={draft.add_path}
                onChange={(e) => setDraft((d) => ({ ...d, add_path: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">超时（秒）</label>
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                value={draft.timeout_s}
                onChange={(e) => setDraft((d) => ({ ...d, timeout_s: Number(e.target.value) }))}
              />
            </div>
          </div>

          <details className="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[11.5px] text-[var(--color-muted)]">
            <summary data-tap-lg className="min-h-[36px] cursor-pointer py-2">对方要实现的两个接口（很简单）</summary>
            <pre className="mt-1.5 whitespace-pre-wrap break-all leading-[1.6]">
{`搜索  POST {地址}{搜索路径}
      请求 {"query": "...", "top_k": 5, "agent_id": "..."}
      响应 {"results": [{"content": "...", "score": 0.8, "id": "m1"}]}
            （results 也可以直接是字符串数组）
新增  POST {地址}{写入路径}
      请求 {"content": "...", "tags": ["x"], "agent_id": "..."}
      响应 2xx 即可`}
            </pre>
          </details>

          {/* 接口字段映射（高级）——默认收起：标准契约开箱可用，只有对方字段名不一样才需要 */}
          <details className="rounded-[8px] border border-[var(--color-border)]">
            <summary data-tap-lg className="min-h-[36px] cursor-pointer px-3 py-2 text-[12.5px]">
              接口字段映射（高级）
              <span className="ml-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
                对方字段名跟标准契约不一样时才填
              </span>
            </summary>
            <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: "var(--color-border)" }}>
              <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                留空 = 用标准契约：搜索发 <code>{"{query, top_k, agent_id}"}</code>、写入发{" "}
                <code>{"{content, tags, agent_id}"}</code>、结果取 <code>results</code> 数组。
                填了就按下面的来 —— 占位符 <code>{"{query} {top_k} {agent_id} {content} {tags}"}</code>
                会被替换（整个值就是占位符时保留原类型，比如 limit 仍是数字）。
              </p>
              <div>
                <label className="label">结果数组的点路径（可留空）</label>
                <input
                  className="input mono"
                  placeholder="例如 data.items"
                  value={draft.results_path}
                  disabled={busy}
                  onChange={(e) => setDraft((d) => ({ ...d, results_path: e.target.value }))}
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <div>
                  <label className="label">额外请求头（JSON）</label>
                  <textarea
                    className="input mono"
                    rows={4}
                    placeholder={'{"x-tdai-service-id": "default"}'}
                    value={draft.extra_headers}
                    disabled={busy}
                    onChange={(e) => setDraft((d) => ({ ...d, extra_headers: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">搜索请求体（JSON 模板）</label>
                  <textarea
                    className="input mono"
                    rows={4}
                    placeholder={'{"team_id":"default","query":"{query}","limit":"{top_k}"}'}
                    value={draft.search_body}
                    disabled={busy}
                    onChange={(e) => setDraft((d) => ({ ...d, search_body: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">写入请求体（JSON 模板）</label>
                  <textarea
                    className="input mono"
                    rows={4}
                    placeholder={'{"content":"{content}","tags":"{tags}"}'}
                    value={draft.add_body}
                    disabled={busy}
                    onChange={(e) => setDraft((d) => ({ ...d, add_body: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </button>
            <button className="btn" onClick={() => void test()} disabled={testing || !cfg.base_url}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            {testResult ? (
              <span
                className="text-[12px]"
                style={{ color: testResult.ok ? "var(--color-ok)" : "var(--color-danger)" }}
              >
                {testResult.ok ? "✓ " : "✕ "}
                {testResult.detail}
                {testResult.ms != null ? `（${testResult.ms}ms）` : ""}
              </span>
            ) : null}
          </div>
          {!cfg.ready ? (
            <p className="text-[11.5px] text-[var(--color-muted)]">
              提示：「测试连接」用的是**已保存**的配置 —— 改完先点保存，再测试。
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
