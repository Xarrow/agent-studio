# 远程技能来源：总报告

## 1. 结论

技能管理现在支持「远程仓库来源」的完整链路：**识别来源 → 下载 → 发现技能 → 经导入管线安装 → 记录来源 → 检查更新 → 更新**，并提供来源登记（SourceDef）、网络策略（代理/证书/镜像/重定向安全）、诊断与 CLI。

两种模式语义一致：**native（默认）** 用内置实现；**npx** 委托官方 `skills` CLI（白名单参数 + 隔离目录 + 收成产物后仍走同一导入管线）。默认选择 native 的理由是实测：CLI 会写真实用户技能目录，`HOME` 覆盖无效（见 audit §2.3）。

## 2. 验证汇总

| 项 | 结果 |
|---|---|
| 解析器用例 | 64 passed（含"不得联网"断言） |
| 发现/哈希/歧义 | 13 passed |
| 网络（代理/证书/重定向） | 23 passed（代理日志、407、自签名 CA、跨主机脱敏、用户配置零改动） |
| 取回（git vs 归档） | 11 passed（两路内容哈希一致；恶意包四种全拒） |
| 接口层（来源 CRUD/安装/更新/设置） | 11 passed |
| **新增合计** | **122 passed** |
| 后端全量 | **1192 passed, 2 skipped**（160s） |
| 前端单测 | **192 passed** |
| 构建 | 树外 build exit=0，产物同步并重启 API |
| 真机（真实仓库） | `emilkowalski/skills` → `via=archive`、`commit=0f2e23b3…`、安装 `animate` 成功 |
| 真机（界面） | 新增来源 `/tmp/qa-source` → 浏览 → 安装 → 落库 + 落盘 |

## 3. 未核实项的最终结论

| 项 | 结论 |
|---|---|
| CLI 遥测开关 | 未找到公开开关；用三个环境变量兜底，**未验证生效**，界面在委托模式下提示 |
| CLI 更新判定依据 | 实测用 `skillFolderHash`（目录内容哈希），非提交 ID |
| 锁文件 | 实测 `~/.agents/.skill-lock.json` v3，字段见 audit；本项目不读写（decisions/lockfile） |
| 临时 HOME 隔离 | **实测无效**（写入真实 home）→ 默认 native |
| socks 代理 | 代码路径支持，但**未夹具验证** → 界面不宣称支持 |
| PAC/WPAD | 不做（decisions/pac.md） |

## 4. 默认决策索引

| 决策 | 文件 |
|---|---|
| 默认 native，npx 需固定版本 | docs/decisions/remote-skills-mode.md |
| `@` = 技能名，`#` = ref | docs/decisions/remote-skills-at-sign.md |
| 不读写官方锁文件 | docs/decisions/remote-skills-lockfile.md |
| 镜像只取内容，提交 ID 以原始主机为准 | docs/decisions/remote-skills-mirror.md |
| 不做 PAC/WPAD | docs/decisions/pac.md |

## 5. 已知限制

1. **委托模式没有强制沙箱**：`mode=npx` 需要用户自行承担"CLI 写真实目录"的风险；默认 native 规避。
2. **索引来源（JSON 目录）与离线来源包**未实现：`kind=index` 留位；导出/导入"来源包"未做。
3. **无逐文件 diff 预览**：检查更新只给"有更新"，更新是整技能替换（经导入管线，失败不影响旧版本）。
4. **设置界面的网络表单**未做：策略可通过 `PUT /api/skills/remote/settings` 写入，界面只暴露模式与版本。
5. **回滚**：依赖导入管线现状（覆盖安装 + 备份文件在会话工作目录），没有"一键回滚到上一版技能内容"。

## 6. 需要实机确认的项

- 真实企业代理（含认证）与自签 CA 环境：夹具已覆盖，但企业代理的 PAC/系统设置分支需要实机确认；
- 东京节点（无 node/npm）上的行为：应始终 native，诊断里应显示 npx 未安装 —— 已部署待点验。

## 7. 回滚方式

- 代码：`git revert <本次提交>`；新表 `skill_source` 可直接删除，不影响既有技能。
- 行为：`skills_mode` 设回 auto/native 即回到纯内置实现；已装技能与来源记录互不依赖。
