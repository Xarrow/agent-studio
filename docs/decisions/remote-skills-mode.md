# 决策：默认模式是 native，npx 委托需要显式解锁

## 背景
实测（见 docs/reports/remote-skills-audit.md §2.3）：`skills@1.8.1` 即使 `HOME` 指向临时目录，
写入目标仍是进程 uid 的真实 home（`/root/.hermes/skills/…`）。也就是说"临时 HOME + 收获"
不能保证不写进用户技能目录。

## 决策
1. 默认 `skills_mode=auto`，但 **auto 在没有配置固定 CLI 版本时选择 native**；
2. `skills_npx_pin` 为空时，即使本机有 npx 也不委托（避免拉到未验证的 CLI 版本）；
3. `skills_mode=npx` 允许强制，但结果里明确标注它是试验性的，且需要外部沙箱；
4. 委托调用只允许白名单子命令/参数，不经 shell，日志流式返回，超时 kill 进程组。

## 后果
- 无 npm 的机器行为完全一致（native）；
- 有 npm 但未固定的机器也走 native —— 对用户是"更慢但可控"；
- 想用官方 CLI 的人显式配版本，且知道自己承担"它会往真实目录写"的风险。

## 回滚
改 `skills_mode` 即可，无需迁移数据；两种模式写库路径相同（同一导入管线）。
