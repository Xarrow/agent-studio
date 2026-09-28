"use client";

/**
 * 「运行环境」——检测当前机器的 Python / Node.js，缺了可以一键装到平台自己的目录。
 *
 * 三条口径（写在界面上，用户才知道"装到哪了、动没动系统"）：
 *   · 只装到平台目录（<runtime_dir>），**不碰系统、不改 PATH**；
 *   · 只从国内镜像取（这台机器出不去外网）；
 *   · 下载校验 sha256、装完真跑一次 --version 才算成功。
 *
 * 为什么要有这个：换机器/重装之后，"前端构建要 node"这种事最容易卡住，
 * 而报错只有一句 `node: command not found`，用户不知道该装什么、装哪。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { EnvRuntimes, InstallJob } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";

function Badge({ ok, text, pending }: { ok: boolean; text: string; pending?: boolean }) {
  // pending：还没拿到检测结果（后端没起来/正在读）—— 这时**不能**说"没找到"，
  // 那是误导：用户会以为机器上真没有 python。
  const tone = pending ? "var(--color-muted)" : ok ? "var(--color-ok)" : "var(--color-warn)";
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px]"
      style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}
    >
      {text}
    </span>
  );
}

function Row({
  title,
  ok,
  header,
  detail,
  action,
  pending,
}: {
  title: string;
  ok: boolean;
  header: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
  pending?: boolean;
}) {
  return (
    <div
      className="rounded-[8px] border px-3 py-2.5"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-medium">{title}</span>
        <Badge ok={ok} pending={pending} text={pending ? "检测中…" : ok ? "已就绪" : "没找到"} />
        <span className="mono text-[12.5px]">{header}</span>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
        {detail}
      </div>
    </div>
  );
}

export function RuntimeCard() {
  const fb = useFeedback();
  const [info, setInfo] = useState<EnvRuntimes | null>(null);
  const [job, setJob] = useState<InstallJob | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.envRuntimes());
    } catch (e) {
      fb.error("读取运行环境失败", e instanceof Error ? e.message : String(e));
    }
  }, [fb]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load]);

  const poll = useCallback(
    async (jobId: string) => {
      const got = await api.envInstallStatus(jobId);
      setJob(got);
      if (got.status === "running") {
        timer.current = window.setTimeout(() => void poll(jobId), 1200);
      } else {
        setBusy(false);
        await load();
        if (got.ok) fb.success(`${got.target === "node" ? "Node.js" : "Python"} 装好了`, "已切到平台目录，未改动系统");
        else fb.error("安装失败", got.error || "看下面的日志");
      }
    },
    [fb, load],
  );

  const install = async (target: "node" | "python") => {
    setBusy(true);
    setJob(null);
    try {
      const res = await api.installEnvRuntime(target, target === "node" ? info?.default_node_version : undefined);
      void poll(res.job_id);
    } catch (e) {
      setBusy(false);
      fb.error("启动安装失败", e instanceof Error ? e.message : String(e));
    }
  };

  const py = info?.python;
  const node = info?.node;

  return (
    <div className="space-y-2">
      <Row
        title="Python"
        ok={!!py?.found}
        pending={!py}
        header={py ? `${py.version}${py.in_venv ? " · 虚拟环境" : ""}` : "读取中…"}
        detail={
          py ? (
            <div className="space-y-0.5">
              <div className="mono break-all">{py.path}</div>
              <div>
                关键依赖：{Object.entries(py.deps).map(([k, v]) => `${k} ${v ?? "未装"}`).join(" · ")}
                {py.uv ? ` · uv ${py.uv ? "已装" : ""}` : " · uv 未装（装独立解释器时用得到）"}
              </div>
              <div>{py.install_note}</div>
            </div>
          ) : (
            "—"
          )
        }
        action={
          py ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="用 uv 装一个独立解释器（不动平台自身的 Python）"
              onClick={() => void install("python")}
            >
              装一个独立解释器
            </button>
          ) : null
        }
      />

      <Row
        title="Node.js"
        ok={!!node?.found}
        pending={!node}
        header={node ? (node.found ? `${node.version}${node.npm ? ` · npm ${node.npm}` : ""}` : "未安装") : "读取中…"}
        detail={
          node ? (
            <div className="space-y-0.5">
              {node.found ? (
                <>
                  <div className="mono break-all">
                    {node.path}
                    {node.source ? `（来自 ${node.source}）` : ""}
                  </div>
                  <div>平台只在构建前端时需要它。</div>
                </>
              ) : (
                <div>{node.install_note}</div>
              )}
              {info?.runtime_dir ? (
                <div className="mono break-all">安装位置：{info.runtime_dir}/node</div>
              ) : null}
            </div>
          ) : (
            "—"
          )
        }
        action={
          node ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="从 npmmirror 下载并校验后装到平台目录（不动系统、不改 PATH）"
              onClick={() => void install("node")}
            >
              {node.found ? `再装一个 ${info?.default_node_version ?? ""}` : "下载安装"}
            </button>
          ) : null
        }
      />

      {info?.os ? (
        <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          系统：{info.os.system} {info.os.release} · {info.os.machine} · 镜像：{info.mirror}
        </p>
      ) : null}

      {job ? (
        <div
          className="rounded-[8px] border px-3 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium">
              安装 {job.target === "node" ? "Node.js" : "Python"}
              {job.version ? ` ${job.version}` : ""}
            </span>
            <Badge
              ok={job.status === "ok"}
              text={job.status === "running" ? "进行中…" : job.status === "ok" ? "完成" : "失败"}
            />
          </div>
          <pre
            className="mono mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded p-2 text-[12px] leading-relaxed"
            style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
          >
            {job.steps.map((s) => s.line).join("\n") || "启动中…"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
