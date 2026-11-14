# 远程技能来源：第 0 步取证报告

日期：2026-11-14　执行环境：本机（Linux，root），Node/npm/npx 均可用。

## 1. 本机可用性

| 工具 | 路径 | 版本 |
|---|---|---|
| npx | /root/.local/bin/npx | 随 node 22 |
| npm | /root/.local/bin/npm | — |
| node | /root/.local/bin/node | — |
| git | /usr/bin/git | 可 ls-remote |

`npx --yes skills@1.8.1 --version` → `1.8.1`（实测可用，非推断）。

## 2. CLI 行为实测（skills@1.8.1）

在 `HOME=/tmp/audit-home`、`cwd=/tmp/audit-work` 的隔离目录下执行：

### 2.1 子命令面

```
add (a) | use | remove | list (ls) | find | update (upgrade)
experimental_install (install, i) | init | experimental_sync (sync)
```

未被文档提到的：`use`（不安装、只生成使用提示）、`init`（本地起一个 SKILL.md 骨架）、`experimental_sync`（把 node_modules 里的技能同步进 agent 目录）。

### 2.2 `--list`（只列不装）

```
npx skills add emilkowalski/skills --list
→ ◇ Source: https://github.com/emilkowalski/skills.git
→ ◇ Repository cloned
→ ◇ Found 19 skills
→ Available Skills: animate / animate-expo / animation-performance / animation-vocabulary / apple-design ...
```

- 简写 `owner/repo` 确实被映射成 `https://github.com/<owner>/<repo>.git`；
- 克隆是**深克隆到临时/npm 缓存目录**，不是 tarball；
- `--list` 也会完整克隆仓库（不是轻量 API 查询）；
- 本机 agent 自动探测结果为 `hermes-agent`（"Agent detected — installing non-interactively"）。

### 2.3 真实安装（-g -a hermes-agent -y）

```
npx skills add emilkowalski/skills --skill animate -g -a hermes-agent -y
→ ✓ animate (copied) → /root/.hermes/skills/animate
```

**关键安全发现**：即使 `HOME=/tmp/audit-home`，目标目录仍是 **真实用户主目录**下的
`/root/.hermes/skills/animate`。说明 CLI 用 **进程 uid 的 home / 已探测的 agent 目录**解析
安装位置，而不是 `$HOME`。推论：

- "在临时 HOME 中运行 + 收获产物"这条隔离策略**不足以防止写进用户技能目录**；
- 委托模式必须在更强的隔离里跑（bwrap/容器/独立 uid），或只用它的 `--list`（只读）；
- 因此本项目默认模式 = `native`，`npx` 模式要求（a）显式配固定版本（b）沙箱可用；
  没有 `--json` 只读探测就没有"安全委托"。

审计产生的 `/root/.hermes/skills/animate` 已识别为副作用，待清理（保留待用户确认删除方式）。

### 2.4 锁文件（实测格式）

位置：`~/.agents/.skill-lock.json`（项目级则是 `<project>/.agents/.skill-lock.json`）

```json
{
  "version": 3,
  "skills": {
    "animate": {
      "source": "emilkowalski/skills",
      "sourceType": "github",
      "sourceUrl": "https://github.com/emilkowalski/skills.git",
      "skillPath": "skills/animate/SKILL.md",
      "skillFolderHash": "6a0393c04fe65ec31746b67956c5d7775a8b9dec",
      "installedAt": "2026-11-14T07:52:08.997Z",
      "updatedAt": "2026-11-14T07:52:08.997Z"
    }
  },
  "dismissed": {}
}
```

- 更新判定依据：`skillFolderHash`（40 位，目录内容哈希）+ `sourceUrl` 重新解析；
- 没有独立 `check` 子命令：`update` 自己判断；
- `generate-lock` 不存在（用 `experimental_install` 反向从锁文件恢复）。

### 2.5 遥测

`--help` 未暴露遥测开关，也没有独立文档位；本实现只用环境变量 `DO_NOT_TRACK=1`、
`SKILLS_TELEMETRY=0`、`CI=1` 三重尝试，**未验证**其是否生效（无可见上报端点，
无法在离线环境下断言）。→ 记入"未核实项"，界面在启用委托时明示"CLI 可能上报匿名使用数据"。

## 3. 项目现有能力盘点

| 能力 | 现状 | 位置 |
|---|---|---|
| 技能导入管线 | 已有：`_upsert_skill`（按名字幂等）+ `_materialize`（原子落盘） | `src/agent_studio/api/skills.py` |
| 技能库（中心库） | 已有：`skill` 表，`source` JSON 记录来源 | `models.py` |
| 启用语义 | 已有：助手 `definition.skills` 引用 + 运行时 loader | `runtimes/agentscope_rt` |
| 仓库安装（tarball） | 已有：`parse_repo_ref` / `fetch_repo_tarball` / `scan_tarball` | `skills_repo.py` |
| 环境探测 | 无（本次新增 `probe_environment`） | `skill_sources/service.py` |
| 网络/代理配置 | 无（本次新增 `NetPolicy`） | `skill_sources/netpolicy.py` |
| CLI | 无（本次新增 `cli_skills`） | `src/agent_studio/cli_skills.py` |

## 4. 来源写法 → 行为对照（实现后的契约）

| 输入 | kind | 解析结果 | 取回路径 |
|---|---|---|---|
| `o/r` | github | host=github.com | 归档（codeload）优先，无则 git |
| `o/r/skills/x` | github | subpath=skills/x | 同上 |
| `o/r@name` | github | skill=name（歧义记 notes） | 同上 |
| `o/r#main` | github | ref=main | 同上 |
| `https://gitlab.com/g/s/r/-/tree/dev/skills/x` | gitlab | owner=g/s, subpath=skills/x, ref=dev | gitlab 归档模板 |
| `git@host:o/r.git` | git/github | ssh 形式 | **仅 git**（归档不支持 SSH） |
| `/abs/dir`、`./dir`、`~/dir` | local | 只读 | 直接扫盘 |
| `来源名:技能` | 继承来源 | source_id 绑定 | 该来源策略 + 凭据 |

## 5. 未核实项与处置

| 项 | 结论 | 处置 |
|---|---|---|
| CLI 是否有一处遥测开关 | 未核实 | 三环境变量兜底 + 界面提示；默认 native |
| CLI `update` 是否用 commit 还是内容哈希 | 实测为 `skillFolderHash` | 本项目两级判断（commit + 目录哈希），与它兼容但不共用锁文件 |
| 临时 HOME 是否能隔离写入 | **实测否** | 委托模式需沙箱；默认 native |
| socks 代理支持 | httpx 支持；git 需 `http.proxy=socks5h://` | 现状：HTTP(S) 代理已夹具验证；socks 未夹具验证 → 界面标注"未验证" |
| PAC/WPAD | 未做，评估结论见 `docs/decisions/pac.md` | 不做 |
