/**
 * 护栏：画布上的"说人话"小函数。
 *
 * 挑两个真出过问题的钉：
 *   · tailOf —— 运行中卡上显示的片段。事件是**流式 delta**（每次几个字），
 *     所以必须按"末尾连续同类型"回卷拼接；只取最后一个 delta 会显示成半句话。
 *   · hitlText —— 待确认提示。input 既可能是对象、也可能是 JSON **字符串**
 *     （AgentScope 两种都给过），解析不出来时要原样显示而不是崩掉。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { blurbOf, clip, hitlText, liveLabel, recScore, tailOf } from "./agent-text.ts";

import type { Agent } from "@/lib/types";

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "ag1",
    name: "编排者",
    description: "",
    definition: {
      system_prompt: "你是一个负责统筹的编排者。先拆任务，再分派。",
      tools: [],
      skills: [],
    },
    ...over,
  }) as unknown as Agent;

test("一句话职责：description 优先；空则去掉套话取提示词里那句实质的", () => {
  assert.equal(blurbOf(agent({ description: "负责统筹" })), "负责统筹");

  // 提示词里的"你是一个负责统筹的编排者。"整段是套话 —— 要丢掉，
  // 留下真正说明"它干什么"的那句（这是助手栏那一行摘要的来源）
  const guess = blurbOf(agent());
  assert.ok(!guess.includes("你是一个"), `别把套话当职责：${guess}`);
  assert.equal(guess, "先拆任务，再分派");

  // 没有套话就直接用提示词第一句
  assert.equal(blurbOf(agent({ definition: { system_prompt: "把长文档拆成要点。其余忽略。", tools: [], skills: [] } as never })), "把长文档拆成要点");
  // 什么都没有 → 空串（界面据此显示占位，而不是显示一个字面量"undefined"）
  assert.equal(blurbOf(agent({ definition: { system_prompt: "", tools: [], skills: [] } as never })), "");
});

test("推荐打分：任务命中名字/职责/工具时分数更高，任务太短不给分", () => {
  const tools = { t1: "read_file" };
  const hit = agent({ name: "报销助手", description: "处理发票与报销" });
  const miss = agent({ name: "天气助手", description: "查天气" });
  assert.equal(recScore(hit, "帮我看下发票报销", tools) > recScore(miss, "帮我看下发票报销", tools), true);
  assert.equal(recScore(hit, "", tools), 0, "空任务不打分（避免乱推荐）");
});

test("运行中状态：说人话且尽量带出工具名", () => {
  const text = liveLabel("tool", "调用 read_file 读取配置");
  assert.ok(text.includes("read_file") || text.length > 0, text);
  assert.equal(typeof liveLabel("output", "正在写"), "string");
});

test("tailOf：流式 delta 要拼起来（否则卡上只有半句话）", () => {
  const events = [
    { type: "text_delta", payload: { delta: "结论" } },
    { type: "text_delta", payload: { delta: "是：先拆" } },
    { type: "text_delta", payload: { delta: "任务再分派。" } },
  ];
  const lines = tailOf(events as never);
  const out = lines.find((l) => l.kind === "output");
  assert.ok(out, "要有 output 那一行");
  assert.ok(out.text.includes("先拆") && out.text.includes("分派"), `delta 没拼起来：${out.text}`);
});

test("tailOf：工具调用与返回分成两行（不同颜色）", () => {
  const events = [
    { type: "tool_call_start", payload: { tool_call_name: "read_file" } },
    { type: "tool_call_args", payload: { delta: '{"path":"a.md"}' } },
    { type: "tool_result_delta", payload: { delta: "第一行内容\n第二行" } },
  ];
  const lines = tailOf(events as never);
  const kinds = lines.map((l) => l.kind);
  assert.ok(kinds.includes("tool"), kinds.join(","));
  assert.ok(kinds.includes("tool_response"), kinds.join(","));
  assert.ok(lines.find((l) => l.kind === "tool_response")?.text.includes("第一行"));
});

test("待确认提示：对象 / JSON 字符串两种 input 都要认，且优先显示关键字段", () => {
  assert.equal(hitlText(null), "（等待确认）");
  assert.equal(hitlText({ tool_calls: [] }), "（等待确认）");
  assert.ok(
    hitlText({ tool_calls: [{ name: "bash", input: { command: "ls -la" } }] }).includes("ls -la"),
    "命令要露出来（用户是据此决定同不同意的）",
  );
  assert.ok(
    hitlText({ tool_calls: [{ name: "read_file", input: '{"path":"/tmp/a.md"}' }] }).includes("/tmp/a.md"),
    "input 是 JSON 字符串时也要解析出来",
  );
  assert.ok(hitlText({ tool_calls: [{ name: "bash", input: "not json" }] }).includes("not json"));
});

test("clip：压成一行并截断", () => {
  assert.equal(clip("a\nb   c", 20), "a b c");
  assert.equal(clip("x".repeat(30), 10), `${"x".repeat(10)}…`);
});
