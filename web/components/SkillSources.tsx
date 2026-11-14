"use client";

/**
 * 仓库来源 / 更新 —— Skills 页的两个入口共用这一个对话框。
 *
 * 为什么做成对话框而不是新页面：来源是"技能的出处"，配置一次就不常动；
 * 而检查更新是随手动作。两者都属于 Skills 页，不该再占一个一级菜单。
 *
 * 口径（与设置页一致）：一行一个来源、动作常驻可见、破坏性动作红色靠右；
 * 令牌输入一次即加密存库，回显只说"已保存"，永远不回传明文。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RemoteSettings, SkillSource, SkillUpdate } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { DLG_BACKDROP, DLG_CARD, Empty, Row, RowList, Segmented, Switch } from "@/components/ui/kit";
import { IconLink, IconPlus, IconRefresh, IconTrash } from "@/components/ui/icons";

type Tab = "sources" | "updates";

const KIND_LABEL: Record<string, string> = {
  git: "Git 仓库",
  archive: "归档地址",
  local: "本地目录",
  index: "索引文件",
};

export function SkillSourcesDialog({
  initialTab = "sources",
  onClose,
  onInstalled,
}: {
  initialTab?: Tab;
  onClose: () => void;
  onInstalled?: () => void;
}) {
  const fb = useFeedback();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [items, setItems] = useState<SkillSource[]>([]);
  const [settings, setSettings] = useState<RemoteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 新增表单
  const [addr, setAddr] = useState("");
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("100");
  const [token, setToken] = useState("");
  const [showForm, setShowForm] = useState(false);

  // 行内展开：测试结果 / 浏览结果
  const [probe, setProbe] = useState<Record<string, { step: string; ok: boolean; ms?: number; detail?: string; message?: string }[]>>({});
  const [browse, setBrowse] = useState<Record<string, { name: string; description: string }[]>>({});

  const [updates, setUpdates] = useState<SkillUpdate[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, cfg] = await Promise.all([api.skillSources(), api.remoteSettings()]);
      setItems(s);
      setSettings(cfg);
    } catch (e) {
      fb.error("读取来源失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fb]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!addr.trim()) return;
    setBusy(true);
    try {
      await api.createSkillSource({
        address: addr.trim(),
        name: name.trim(),
        priority: Number(priority) || 100,
        token: token.trim() || undefined,
      } as Partial<SkillSource> & { address: string; token?: string });
      setAddr("");
      setName("");
      setToken("");
      setShowForm(false);
      await load();
      fb.success("来源已登记", "现在可以浏览它里面的技能，或直接按名字安装");
    } catch (e) {
      fb.error("登记失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: SkillSource) => {
    try {
      await api.updateSkillSource(s.id, {
        address: s.address,
        name: s.name,
        enabled: !s.enabled,
        priority: s.priority,
      });
      await load();
    } catch (e) {
      fb.error("切换失败", e instanceof Error ? e.message : String(e));
    }
  };

  const del = async (s: SkillSource) => {
    const ok = await fb.confirm({
      title: `删除来源「${s.name}」？`,
      description: "只删这一条登记，已装上的技能不受影响。",
      danger: true,
      confirmText: "删除来源",
    });
    if (!ok) return;
    try {
      await api.deleteSkillSource(s.id);
      await load();
      fb.success("已删除来源");
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  const test = async (s: SkillSource) => {
    setBusy(true);
    try {
      const r = await api.testSkillSource(s.id);
      setProbe((p) => ({ ...p, [s.id]: r.steps }));
    } catch (e) {
      fb.error("测试失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const look = async (s: SkillSource) => {
    setBusy(true);
    try {
      const r = await api.browseSkillSource(s.id);
      setBrowse((b) => ({ ...b, [s.id]: r.skills }));
    } catch (e) {
      fb.error("浏览失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async (s: SkillSource, skill: string) => {
    setBusy(true);
    try {
      const r = await api.remoteInstall({ ref: s.address, skills: [skill] });
      fb.success(`已安装 ${skill}`, `经由 ${String((r.meta as Record<string, unknown>)?.via ?? "来源")}`);
      onInstalled?.();
    } catch (e) {
      fb.error("安装失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkAll = async (force = true) => {
    setBusy(true);
    try {
      const r = await api.skillUpdates(force);
      setUpdates(r.items);
      const n = r.has_updates.length;
      fb.success(n ? `${n} 个技能有更新` : "都是最新的", `模式：${r.mode}`);
    } catch (e) {
      fb.error("检查失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyUpdate = async (u: SkillUpdate) => {
    setBusy(true);
    try {
      await api.updateSkillNow(u.id);
      await checkAll(false);
      onInstalled?.();
      fb.success(`已更新「${u.name}」`);
    } catch (e) {
      fb.error("更新失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveMode = async (mode: RemoteSettings["mode"]) => {
    try {
      const r = await api.saveRemoteSettings({ mode });
      setSettings(r);
      fb.success(`模式：${mode}`, r.effective_mode?.[1] || "");
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} w-full max-w-3xl p-5 max-h-[86vh] overflow-auto`}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-medium">技能来源与更新</h2>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">
              登记一个来源后可浏览、安装、批量检查更新；技能仍然经导入管线校验后原子安装。
            </p>
          </div>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            value={tab}
            onChange={(v) => {
              setTab(v as Tab);
              if (v === "updates" && updates.length === 0) void checkAll(false);
            }}
            options={[
              { key: "sources", label: `来源（${items.length}）` },
              { key: "updates", label: "检查更新" },
            ]}
          />
          {settings && (
            <span className="text-[12px] text-[var(--color-muted)]">
              模式：{settings.effective_mode?.[0]}（{settings.effective_mode?.[1]}）·
              npx {settings.env.npx ? "可用" : "未安装"} · git {settings.env.git ? "可用" : "未安装"}
            </span>
          )}
          <button className="btn ml-auto" disabled={busy} onClick={() => void checkAll(true)}>
            <IconRefresh size={14} />
            检查更新
          </button>
        </div>

        {tab === "sources" ? (
          <>
            <div className="mb-3 rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 flex items-center gap-2 text-[12.5px]">
                <IconLink size={14} />
                使用哪种方式取内容
                <select
                  className="input"
                  value={settings?.mode ?? "auto"}
                  onChange={(e) => void saveMode(e.target.value as RemoteSettings["mode"])}
                >
                  <option value="auto">自动（有可用的 npx 就用它）</option>
                  <option value="npx">始终用 skills CLI</option>
                  <option value="native">始终用内置实现</option>
                </select>
                <span className="ml-auto text-[11px] text-[var(--color-muted)]">
                  {settings?.npx_pin ? `固定版本 ${settings.npx_pin}` : "未固定 CLI 版本 → 默认走内置实现"}
                </span>
              </div>
            </div>

            {!showForm ? (
              <button className="btn btn-primary mb-3" onClick={() => setShowForm(true)}>
                <IconPlus size={14} />
                新增来源
              </button>
            ) : (
              <div className="mb-3 space-y-2 rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
                <input
                  className="input w-full"
                  placeholder="地址：owner/repo、https://gitlab.corp/team/skills、/srv/skills、ssh://git@host/..."
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <input className="input flex-1" placeholder="名称（列表里显示）" value={name} onChange={(e) => setName(e.target.value)} />
                  <input className="input w-24" placeholder="优先级" value={priority} onChange={(e) => setPriority(e.target.value)} />
                  <input className="input flex-1" placeholder="令牌（私有仓库才需要，加密保存）" value={token} onChange={(e) => setToken(e.target.value)} type="password" />
                </div>
                <p className="text-[11px] text-[var(--color-warn)]">
                  来源里的技能是文本指令，也可能带脚本 —— 只添加你信任的来源。
                </p>
                <div className="flex gap-2">
                  <button className="btn btn-primary" disabled={busy} onClick={() => void add()}>
                    保存来源
                  </button>
                  <button className="btn" onClick={() => setShowForm(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <p className="text-[12px] text-[var(--color-muted)]">读取中…</p>
            ) : items.length === 0 ? (
              <Empty title="还没有登记来源" hint="登记后可以浏览里面的技能、装完再批量检查更新。" />
            ) : (
              <RowList>
                {items.map((s) => (
                  <Row key={s.id}>
                    <div className="flex flex-col gap-2 py-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px]">{s.name}</span>
                        <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }}>
                          {KIND_LABEL[s.kind] ?? s.kind}
                        </span>
                        <span className="text-[11px] text-[var(--color-muted)]">优先级 {s.priority}</span>
                        {s.has_token && <span className="text-[11px] text-[var(--color-muted)]">已存令牌</span>}
                        <span className="ml-auto flex items-center gap-1.5">
                          <Switch checked={s.enabled} onChange={() => void toggle(s)} />
                          <button className="btn" disabled={busy} onClick={() => void test(s)}>
                            测试
                          </button>
                          <button className="btn" disabled={busy} onClick={() => void look(s)}>
                            浏览
                          </button>
                          <button className="btn" disabled={busy} onClick={() => void del(s)} style={{ color: "var(--color-danger)" }}>
                            <IconTrash size={13} />
                          </button>
                        </span>
                      </div>
                      <div className="mono text-[11.5px] text-[var(--color-muted)] break-all">{s.address}</div>

                      {probe[s.id] && (
                        <div className="rounded border p-2 text-[11.5px]" style={{ borderColor: "var(--color-border)" }}>
                          {probe[s.id].map((st) => (
                            <div key={st.step} className="flex items-center gap-2">
                              <span style={{ color: st.ok ? "var(--color-ok)" : "var(--color-danger)" }}>{st.ok ? "✓" : "✕"}</span>
                              <span className="mono">{st.step}</span>
                              {st.ms != null && <span className="text-[var(--color-muted)]">{st.ms}ms</span>}
                              <span className="text-[var(--color-muted)]">{st.detail || st.message || ""}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {browse[s.id] && (
                        <div className="rounded border p-2" style={{ borderColor: "var(--color-border)" }}>
                          {browse[s.id].length === 0 ? (
                            <p className="text-[11.5px] text-[var(--color-muted)]">这里面没找到技能</p>
                          ) : (
                            browse[s.id].map((k) => (
                              <div key={k.name} className="flex items-start gap-2 py-0.5">
                                <span className="text-[12.5px]">{k.name}</span>
                                <span className="flex-1 truncate text-[11.5px] text-[var(--color-muted)]">{k.description}</span>
                                <button className="btn" disabled={busy} onClick={() => void install(s, k.name)}>
                                  安装
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </Row>
                ))}
              </RowList>
            )}
          </>
        ) : (
          <>
            <p className="mb-2 text-[12px] text-[var(--color-muted)]">
              两级判断：先看提交有没有变，再看技能目录内容哈希有没有变 —— 仓库改别的文件不会误报。
            </p>
            {updates.length === 0 ? (
              <Empty title="还没检查过" hint="点右上「检查更新」；结果会缓存，默认 6 小时一次。" />
            ) : (
              <RowList>
                {updates.map((u) => (
                  <Row key={u.id}>
                    <div className="flex items-center gap-2 py-1">
                      <span className="text-[13px]">{u.name}</span>
                      <span
                        className="text-[11.5px]"
                        style={{ color: u.has_update ? "var(--color-warn)" : "var(--color-muted)" }}
                      >
                        {u.has_update ? `有更新 · ${u.latest_commit?.slice(0, 7) ?? ""}` : u.status === "cached" ? "已是最新（缓存）" : "已是最新"}
                      </span>
                      {u.message && <span className="text-[11px] text-[var(--color-danger)]">{u.message}</span>}
                      {u.has_update && (
                        <button className="btn ml-auto" disabled={busy} onClick={() => void applyUpdate(u)}>
                          更新
                        </button>
                      )}
                    </div>
                  </Row>
                ))}
              </RowList>
            )}
          </>
        )}
      </div>
    </div>
  );
}
