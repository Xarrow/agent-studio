"use client";

/**
 * 环境配置 —— 选择平台把数据存在哪里。
 *
 * 交互上的几个取舍
 * ----------------
 * 1. **当前状态摆在最上面**：先让用户看清"现在用的是哪个库、多少张表、通不通"，
 *    再谈切换。很多人打开这页只是想确认状态，不是真要改。
 * 2. **必须先测试成功才允许切换**：切换会重启服务，测都没测就切是拿生产当赌注。
 * 3. **明确说清"数据不会自动搬"**：这是最容易被误解的地方 —— 切过去是新库、
 *    空表，老数据还躺在原来那个库里（切回来就还在）。
 * 4. **切换后轮询等它回来**：服务要重启，页面会短暂失联，得给个明确交代。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, Section } from "@/components/ui/kit";
import { api } from "@/lib/api";
import type { DbDriver, DbDriverInfo, DbStatus, DbTestResult , UploadConfigRead } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { BackupRestore } from "@/components/BackupRestore";
import { StoragePanel } from "@/components/StoragePanel";
import { RuntimeCard } from "@/components/RuntimeCard";

/** 表单字段（SQLite 只用 path，其余是网络库的连接参数） */
type Form = {
  sqlite_path: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  charset: string;
  ssl: boolean;
};

const EMPTY: Form = {
  sqlite_path: "",
  host: "",
  port: "",
  user: "",
  password: "",
  database: "",
  charset: "utf8mb4",
  ssl: false,
};

export default function EnvironmentPage() {
  const fb = useFeedback();

  const [status, setStatus] = useState<DbStatus | null>(null);
  const [drivers, setDrivers] = useState<DbDriverInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [driver, setDriver] = useState<DbDriver>("sqlite");
  const [form, setForm] = useState<Form>(EMPTY);
  const [test, setTest] = useState<DbTestResult | null>(null);
  const [busy, setBusy] = useState<"test" | "switch" | null>(null);
  const [switching, setSwitching] = useState(false);
  /* 上传目录（Playground 任务卡的附件存这里）—— 跟数据库配置互不相干，单独一块。
     后端已带"可写探测"：改完立刻告诉你这个目录到底能不能用，不用等上传失败才发现。 */
  const [upDir, setUpDir] = useState("");
  const [upCfg, setUpCfg] = useState<UploadConfigRead | null>(null);
  const [upDirty, setUpDirty] = useState(false);
  const [upBusy, setUpBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  /* ------------------------------ 载入 ------------------------------ */
  const load = useCallback(async () => {
    try {
      const [st, dr] = await Promise.all([api.database(), api.databaseDrivers()]);
      setStatus(st);
      setDrivers(dr.drivers);
      setDriver(st.config.driver);
      setForm({
        sqlite_path: st.config.sqlite_path,
        host: st.config.host,
        port: st.config.port ? String(st.config.port) : "",
        user: st.config.user,
        password: "", // 已保存的密码不回显，留空即"不修改"
        database: st.config.database,
        charset: st.config.charset || "utf8mb4",
        ssl: st.config.ssl,
      });
    } catch (e) {
      fb.error("加载失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fb]);

  /* 上传目录：单独拉一次，失败不影响页面主流程（它只是个可选项） */
  useEffect(() => {
    void api
      .uploadConfig()
      .then((c) => {
        setUpCfg(c);
        setUpDir(c.is_default ? "" : c.dir);
      })
      .catch(() => setUpCfg(null));
  }, []);

  const saveUploadDir = async (dir: string) => {
    setUpBusy(true);
    try {
      const c = await api.setUploadConfig(dir);
      setUpCfg(c);
      setUpDir(c.is_default ? "" : c.dir);
      setUpDirty(false);
      fb.success("已保存上传目录", c.dir);
    } catch (e) {
      fb.error("这个目录不能用", e instanceof Error ? e.message : String(e));
    } finally {
      setUpBusy(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [load]);

  /* ------------------------------ 提交体 ------------------------------ */
  const payload = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      driver,
      sqlite_path: form.sqlite_path,
      host: form.host,
      port: form.port ? Number(form.port) : 0,
      user: form.user,
      password: form.password, // 空字符串 = 沿用已保存的
      database: form.database,
      charset: form.charset,
      ssl: form.ssl,
      ...extra,
    }),
    [driver, form],
  );

  const runTest = useCallback(
    async (createDb: boolean, silent = false) => {
      setBusy("test");
      if (!silent) setTest(null);
      try {
        const r = await api.databaseTest(payload({ create_database: createDb }));
        setTest(r);
        if (!silent) {
          if (r.ok) {
            fb.success(
              "连接成功",
              `${r.table_count} 张表就绪${r.created_database ? "（库是刚自动创建的）" : ""}`,
            );
          } else {
            fb.error("连接失败", r.error ?? r.problems.join("；"));
          }
        }
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTest({ ok: false, stage: "error", problems: [], error: msg });
        if (!silent) fb.error("测试出错", msg);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [payload, fb],
  );

  const doSwitch = useCallback(async () => {
    // ① 先测试（建库建表也会在这一步完成），失败就不允许切
    const r = await runTest(true);
    if (!r?.ok) {
      fb.warn("没有切换", "先让连接测试通过 —— 现在切换只会把服务弄坏。");
      return;
    }

    const target =
      driver === "sqlite"
        ? "本地 SQLite 文件"
        : `${driver === "mysql" ? "MySQL" : "PostgreSQL"} @ ${form.host}:${form.port || "默认"}/${form.database}`;

    const okToGo = await fb.confirm({
      title: `确认切换到 ${target}？`,
      description: "原库里的数据不会自动搬过去 —— 新库的表会自动建好，但里面是空的。",
      details: [
        "服务会重启几秒，正在跑的 Agent 任务会被中断",
        "老数据仍留在原库，想换回来随时可以切回去",
        "连接测试已通过，目标库和表都已就绪",
      ],
      confirmText: "切换",
      danger: true,
      armDelayMs: 800,
    });
    if (!okToGo) return;

    setBusy("switch");
    try {
      const res = await api.databaseSwitch(payload({ create_database: true }));
      setSwitching(true);
      fb.success(
        "已切换",
        res.note + (res.created_database ? "（目标库是刚自动创建的）" : ""),
      );

      // ② 轮询等它回来
      let tries = 0;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        tries += 1;
        try {
          await api.databaseHealth();
          // 回来了：确认驱动真的换了
          const st = await api.database();
          setStatus(st);
          setSwitching(false);
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          fb.success("已恢复", `现在使用的是 ${st.runtime.describe}`);
        } catch {
          if (tries > 40) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setSwitching(false);
            fb.error("服务没有回来", "请到服务器上查看 agent-studio-api 的日志");
          }
        }
      }, 1500);
    } catch (e) {
      fb.error("切换失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [runTest, driver, form, payload, fb]);

  /* ------------------------------ 渲染 ------------------------------ */
  if (loading) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  const info = drivers.find((d) => d.key === driver);
  const isFile = driver === "sqlite";
  const isNet = !isFile;
  const sameDriver = status?.config.driver === driver;
  // 换驱动时密码必填（同一驱动留空表示不改）
  const passwordReady = isFile || !!form.password || (sameDriver && !!status?.config.has_password);
  const canSubmit =
    !busy && !switching && !!test?.ok && passwordReady && (isFile || (!!form.host && !!form.user && !!form.database));

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 md:p-6 lg:p-7">
      <PageHead
        title="环境配置"
        desc="平台把数据存在哪里。本地开发用默认的 SQLite 就够了；要多人共用或跑在服务器上，可以切到自己的 MySQL / PostgreSQL。"
      />

      {/* ── 运行环境：这台机器有什么、缺了能装 ─────────────── */}
      <Section
        title="运行环境"
        desc="检测这台机器上的 Python 与 Node.js。缺了可以一键装到平台自己的目录 —— 不动系统、不改 PATH，只走国内镜像，下载校验 sha256、装完真跑一次版本号才算成功"
      >
        <RuntimeCard />
      </Section>

      {/* ── 当前使用 ─────────────────────────────────────────── */}
      <Section
        title="当前使用"
        desc="平台此刻真正的数据落点 —— 下面「切换」改的是下一份配置，改完要重启才生效"
      >
        {status && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-[10.5px] px-1.5 py-0.5 rounded"
                style={{
                  background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                  color: "var(--color-accent)",
                }}
              >
                生效中
              </span>
              <span className="text-[13.5px] font-medium">{status.config.driver_label}</span>
              <span
                className="text-[11.5px]"
                style={{ color: status.reachable ? "var(--color-ok)" : "var(--color-err)" }}
              >
                {status.reachable ? "● 连接正常" : "✕ 连不上"}
              </span>
            </div>

            <div className="mono text-[12px] text-[var(--color-muted)] mt-2 break-all">
              {status.runtime.describe}
            </div>

            <div className="flex items-center gap-4 mt-2 flex-wrap text-[11.5px] text-[var(--color-muted)]">
              <span>{status.table_count} 张表</span>
              <span>配置文件：{status.config_path}</span>
            </div>

            {status.error && (
              <p className="text-[11.5px] mt-2" style={{ color: "var(--color-err)" }}>
                {status.error}
              </p>
            )}
            {status.pending_restart && (
              <p className="text-[11.5px] mt-2" style={{ color: "var(--color-warn)" }}>
                配置已改动但还没生效 —— 重启服务后才会用新库。
              </p>
            )}
          </>
        )}
      </Section>

      {/* ── 切换 ─────────────────────────────────────────────── */}
      <Section
        title="切换到其他数据库"
        desc="换到自己的 MySQL / PostgreSQL：新库的表会自动建好，但里面是空的（旧库数据不动，切回来还能看到）"
      >

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          {drivers.map((d) => {
            const on = driver === d.key;
            const inUse = status?.config.driver === d.key;
            return (
              <button
                key={d.key}
                disabled={switching}
                onClick={() => {
                  setDriver(d.key);
                  setTest(null);
                  setForm((f) => ({ ...f, port: f.port || String(d.default_port || "") }));
                }}
                className="text-left rounded-lg p-2.5 transition-colors"
                style={{
                  background: on
                    ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                    : "var(--color-surface-2)",
                  border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                <div
                  className="text-[13px] font-medium mb-0.5 flex items-center gap-1.5"
                  style={{ color: on ? "var(--color-accent)" : "var(--color-text)" }}
                >
                  {d.label}
                  {inUse && (
                    <span className="text-[10px] text-[var(--color-muted)] font-normal">在用</span>
                  )}
                </div>
                <div className="text-[11.5px] leading-snug text-[var(--color-muted)]">{d.hint}</div>
              </button>
            );
          })}
        </div>

        {/* 连接表单 */}
        <div className="space-y-3">
          {isFile ? (
            <div>
              <div className="label mb-1.5">数据库文件路径</div>
              <input
                className="input text-[13px] mono"
                placeholder="留空则用默认：<项目>/data/studio.db"
                value={form.sqlite_path}
                disabled={switching}
                onChange={(e) => {
                  setForm((f) => ({ ...f, sqlite_path: e.target.value }));
                  setTest(null);
                }}
              />
              <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                一个文件就是整个数据库，不需要额外服务。适合本地开发和单机使用。
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <div className="label mb-1.5">主机地址</div>
                  <input
                    className="input text-[13px] mono"
                    placeholder={driver === "mysql" ? "127.0.0.1" : "127.0.0.1"}
                    value={form.host}
                    disabled={switching}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, host: e.target.value }));
                      setTest(null);
                    }}
                  />
                </div>
                <div>
                  <div className="label mb-1.5">端口</div>
                  <input
                    className="input text-[13px] mono"
                    placeholder={String(info?.default_port ?? "")}
                    value={form.port}
                    disabled={switching}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, port: e.target.value }));
                      setTest(null);
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="label mb-1.5">用户名</div>
                  <input
                    className="input text-[13px] mono"
                    value={form.user}
                    disabled={switching}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, user: e.target.value }));
                      setTest(null);
                    }}
                  />
                </div>
                <div>
                  <div className="label mb-1.5">密码</div>
                  <input
                    className="input text-[13px]"
                    type="password"
                    placeholder={sameDriver && status?.config.has_password ? "留空 = 不修改" : ""}
                    value={form.password}
                    disabled={switching}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, password: e.target.value }));
                      setTest(null);
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <div className="label mb-1.5">数据库名</div>
                  <input
                    className="input text-[13px] mono"
                    placeholder="agent_studio"
                    value={form.database}
                    disabled={switching}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, database: e.target.value }));
                      setTest(null);
                    }}
                  />
                  <p className="text-[11px] text-[var(--color-muted)] mt-1">不存在会自动创建</p>
                </div>
                {driver === "mysql" && (
                  <div>
                    <div className="label mb-1.5">字符集</div>
                    <input
                      className="input text-[13px] mono"
                      value={form.charset}
                      disabled={switching}
                      onChange={(e) => {
                        setForm((f) => ({ ...f, charset: e.target.value }));
                        setTest(null);
                      }}
                    />
                  </div>
                )}
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)] cursor-pointer pb-2">
                    <input
                      type="checkbox"
                      checked={form.ssl}
                      disabled={switching}
                      onChange={(e) => {
                        setForm((f) => ({ ...f, ssl: e.target.checked }));
                        setTest(null);
                      }}
                    />
                    启用 TLS 加密连接
                  </label>
                </div>
              </div>

              {!passwordReady && (
                <p className="text-[11.5px]" style={{ color: "var(--color-warn)" }}>
                  切到另一个驱动需要重新填密码（密码不会跨驱动沿用）。
                </p>
              )}
            </>
          )}
        </div>

        {/* 测试结果 */}
        {test && (
          <div
            className="rounded-lg p-3 mt-4"
            style={{
              background: "var(--color-surface-2)",
              border: `1px solid ${test.ok ? "var(--color-ok)" : "var(--color-err)"}`,
            }}
          >
            <div className="text-[12.5px] font-medium mb-1.5" style={{ color: test.ok ? "var(--color-ok)" : "var(--color-err)" }}>
              {test.ok ? "✓ 测试通过" : "✕ 测试未通过"}
            </div>
            {test.ok ? (
              <ul className="text-[11.5px] text-[var(--color-muted)] space-y-0.5">
                <li>目标：{test.target}</li>
                <li>
                  表：{test.table_count} 张{test.created_database ? "（数据库是本次自动创建的）" : ""}
                </li>
                {test.server_version && <li className="mono break-all">{test.server_version}</li>}
              </ul>
            ) : (
              <div className="text-[11.5px] text-[var(--color-muted)] space-y-1">
                {test.problems.length > 0 && (
                  <ul className="list-disc pl-4">
                    {test.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {test.error && <div className="mono break-all">{test.error}</div>}
              </div>
            )}
          </div>
        )}

        {/* 操作 */}
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <button
            className="btn"
            disabled={!!busy || switching}
            onClick={() => void runTest(true)}
          >
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void doSwitch()}>
            {busy === "switch" || switching ? "切换中…" : "保存并切换"}
          </button>
          {!test?.ok && (
            <span className="text-[11.5px] text-[var(--color-muted)]">
              先测试通过才能切换（避免把服务切坏）
            </span>
          )}
        </div>
      </Section>

      {/* ── 上传目录 ─────────────────────────────────────────── */}
      <Section
        title="上传目录"
        desc={
          <>
            对话与任务里上传的图片/文件存到这个目录；留空 = 用默认目录
            {upCfg && <span className="mono"> （{upCfg.default_dir}）</span>}。
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input mono min-w-[260px] flex-1"
            value={upDir}
            onChange={(e) => {
              setUpDir(e.target.value);
              setUpDirty(true);
            }}
            placeholder="留空 = 默认目录"
            title="填绝对路径，例如 /srv/agent-uploads"
          />
          <button
            className="btn"
            disabled={upBusy || !upDirty}
            onClick={() => void saveUploadDir(upDir.trim())}
          >
            {upBusy ? "保存中…" : "保存"}
          </button>
          <button
            className="btn"
            disabled={upBusy || !upCfg || upCfg.is_default}
            onClick={() => void saveUploadDir("")}
            title="回到默认目录（data/uploads）"
          >
            用默认
          </button>
        </div>
        {upCfg && (
          <p
            className="mt-2 text-[12px]"
            style={{ color: upCfg.writable ? "var(--color-ok)" : "var(--color-err)" }}
          >
            {upCfg.writable ? "✓ 目录可用（已存在且可写）" : `✗ 不可写：${upCfg.error || "未知原因"}`}
            {upCfg.is_default ? " · 当前用默认目录" : ""}
          </p>
        )}
      </Section>

      {/* 配置导入导出：数据能带走。放在"数据存哪"下面 —— 同一件事的两面：
          存在哪 / 怎么拿走。按功能分区，能只导助手、只导流程。 */}
      <StoragePanel />

      <Section
        title="配置导入导出"
        desc="助手 / 自定义工具 / 技能 / 编排流程 / 记忆策略 / 长期记忆 / 模型单价 / LLM 配置，可以按功能单独导出，也可以一键全量；导入只新增、不覆盖"
      >
        <BackupRestore />
      </Section>

      {/* ── 说明 ─────────────────────────────────────────────── */}
      <Section
        title="几点说明"
        desc="切换数据库的真实行为：数据不搬、服务会重启、密码加密保存、切错会自动退回"
      >
        <ul className="text-[12.5px] text-[var(--color-muted)] space-y-1.5 leading-relaxed">
          <li>
            <b>数据不会自动搬过去。</b>切到新库后表会自动建好，但里面是空的 ——
            原来的数据还在旧库里。切回来就能看到。
          </li>
          <li>
            <b>切换会重启服务</b>（几秒钟）。正在跑的 Agent 任务会被中断。
          </li>
          <li>
            <b>密码加密保存</b>，与 LLM 密钥同一套主密钥；界面上不回显。
          </li>
          <li>
            <b>切错了也不怕</b>：连不上或建表失败时，配置根本不会被写入，现有环境不受影响。
            万一新库起来后有问题，服务会自动退回 SQLite。
          </li>
        </ul>
      </Section>
    </div>
  );
}
