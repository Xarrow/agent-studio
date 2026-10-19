import test from "node:test";
import assert from "node:assert/strict";
import { INTERRUPTED_NOTICE, humanizeAssistantText } from "./messages.ts";

test("框架那句『我注意到中断了』要换成人能看懂的中文", () => {
  for (const raw of [
    "I notice the interruption. How can I help you?",
    "  i notice the interruption. how can i help you?  ",
    "I notice the interruption.",
  ]) {
    const out = humanizeAssistantText(raw);
    assert.equal(out, INTERRUPTED_NOTICE, raw);
    assert.equal(/interruption/i.test(out), false, "换完之后不该再出现英文原句");
    assert.equal(/[A-Za-z]{4,}/.test(out), false, "不该夹生英文");
  }
});

test("正常回答一个字都不动", () => {
  const ok = "文件已创建：`result.md`（27B）";
  assert.equal(humanizeAssistantText(ok), ok);
  // 正文里引用这个短语（长回答）不动 —— 只换"整条就是那句话"的
  const quoted = "用户提到 I notice the interruption 这句话，我们把它换成了中文。".repeat(3);
  assert.equal(humanizeAssistantText(quoted), quoted);
  assert.equal(humanizeAssistantText(""), "");
});
