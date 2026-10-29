"use client";

/**
 * 工具检索（tool_search）配置卡。
 *
 * 背景：agent-studio 的工具懒加载用 tool_search → tool_describe → tool_call
 * 三步取用。检索引擎是 BM25 稀疏路 + 向量稠密路 + RRF 融合（MCP Gateway,
 * ATC 2026）。BM25 路零配置总能工作；稠密路需要一个 embeddings 端点
 * （OpenAI 兼容 /v1/embeddings），没配时静默降级 —— 这张卡就是那个开关。
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Hint } from "@/components/ui/hint";
import { useFeedback } from "@/components/ui/feedback";

type EmbedConf = { base_url: string; api_key: string; model: string };
/** 表单态：api_key 输入框是草稿（留空=保持原值），保存时才并进去 */
type EmbedForm = EmbedConf & { _draft_key?: string };

const EMPTY: EmbedConf = { base_url: "", api_key: "", model: "" };

export function ToolSearchCard() {
  const fb = useFeedback();
  const [conf, setConf] = useState<EmbedForm>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    api
      .appSetting("toolsearch_embedding")
      .then((v: { value?: unknown }) => {
        // 后端只回 api_key_set/api_key_masked（密文落库，明文/密文都不出接口）；
        // 输入框是草稿（留空=保持原值）
        const val = (v.value || {}) as Record<string, unknown>;
        setConf({
          ...EMPTY,
          base_url: (val.base_url as string) || "",
          model: (val.model as string) || "",
          api_key: val.api_key_set ? "__set__" : "",
        });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async (next: EmbedConf) => {
    setBusy(true);
    try {
      await api.setAppSetting("toolsearch_embedding", next);
      setConf(next);
      fb.success("已保存", "下一次 tool_search 生效");
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(null);
    const draftKey = conf._draft_key?.trim() || "";
    const hasKey = draftKey || conf.api_key === "__set__";
    if (!conf.base_url || !hasKey || !conf.model) {
      setTesting("三项都要填");
      return;
    }
    setTesting("测试中…");
    try {
      const base = conf.base_url.replace(/\/+$/, "");
      // 测试直接用草稿 key（未保存也能测）；已配置但没填草稿时无法在本端测——
      // 明文只在后端，前端不持有（提示去保存后用运行时验证）
      if (!draftKey) {
        setTesting("已保存的密钥不回显明文——改动 base_url/model 后请先保存，由运行时验证连通");
        return;
      }
      const resp = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${draftKey}` },
        body: JSON.stringify({ model: conf.model, input: ["连接测试"] }),
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          detail += `：${j?.error?.message || j?.detail || ""}`.trimEnd();
        } catch { /* 无 body 就只报状态码 */ }
        setTesting(`失败：${detail}`);
        return;
      }
      const data = await resp.json();
      const dim = (data.data?.[0]?.embedding || []).length;
      setTesting(`连通，向量维度 ${dim}`);
    } catch (e) {
      setTesting(`失败：${e instanceof Error ? e.message : "网络错误"}`);
    }
  };

  if (!loaded) return null;

  const enabled = Boolean(conf.base_url && (conf._draft_key?.trim() || conf.api_key === "__set__") && conf.model);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <div className="label mb-1.5">Base URL</div>
          <input
            className="input text-[13px] mono"
            placeholder="https://.../v1"
            value={conf.base_url}
            disabled={busy}
            onChange={(e) => setConf((f) => ({ ...f, base_url: e.target.value }))}
          />
        </div>
        <div>
          <div className="label mb-1.5">
            API Key <Hint text="保存后 Fernet 加密落库，明文/密文都不回显；界面留空 = 保持原值" />
          </div>
          <input
            className="input text-[13px] mono"
            type="password"
            placeholder={conf.api_key === "__set__" ? "已配置（留空保持）" : "sk-…"}
            value={conf._draft_key ?? ""}
            disabled={busy}
            onChange={(e) => setConf((f) => ({ ...f, _draft_key: e.target.value } as EmbedForm))}
          />
        </div>
        <div>
          <div className="label mb-1.5">模型</div>
          <input
            className="input text-[13px] mono"
            placeholder="text-embedding-v4"
            value={conf.model}
            disabled={busy}
            onChange={(e) => setConf((f) => ({ ...f, model: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            save({
              base_url: conf.base_url.trim(),
              // 留空 = 保持原密钥（后端 merge 原密文）
              api_key: conf._draft_key?.trim() || "",
              model: conf.model.trim(),
            } as EmbedForm)
          }
        >
          {busy ? "保存中…" : enabled ? "保存修改" : "启用稠密检索"}
        </button>
        {enabled && (
          <>
            <button className="btn" disabled={busy} onClick={() => void save({ ...EMPTY })}>
              停用（回纯 BM25）
            </button>
            <button className="btn" disabled={busy || testing === "测试中…"} onClick={() => void test()}>
              测试连通
            </button>
          </>
        )}
        {testing && (
          <span className="text-[12px]" style={{ color: testing.startsWith("失败") || testing === "三项都要填" ? "var(--color-err)" : "var(--color-muted)" }}>
            {testing}
          </span>
        )}
      </div>

      <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
        tool_search 默认用词面检索（BM25），不依赖任何端点。配上 embeddings
        后加一路语义检索（换说法也能命中），两路融合。停用即回纯词面检索。
        <Hint text="检索机制对应 MCP Gateway（ATC 2026）的 ToolSearch：稀疏 BM25 + 稠密向量 + RRF 名次融合" />
      </p>
    </div>
  );
}
