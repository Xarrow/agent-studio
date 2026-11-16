# 知识中心流程规格（从零设计，不迁就现有实现）

你是资深知识库/AI 平台工程师（精通 Python/FastAPI、SQLite/Postgres、文档解析 pipeline、BM25 检索、React 单页交互）。
请按本规格实现，不要向我提问。目标是让「文档 → 关键词标签 → Skill → Agent」成为一条用户走得通、数据可回溯的链路，并给出可量化召回率。

## 一、背景与判断（现象，带量级）

1. 现有知识中心把"整理"做成一键黑箱：用户点「让助手整理」，得到分类/标签/摘要三类草稿混在一起，无法只生标签。
2. 标签只能由模型产出后逐条采纳；用户想手动补一个标签，入口埋在别处（要跨页签）。
3. Skill 生成是"选文档 → 提炼"，与标签无关；同一主题的多份文档无法一键聚成一份技能。
4. 图谱只画 doc→category / skill→doc / agent→skill，缺标签层，用户看不到"哪些标签把文档聚成了技能"。
5. 没有任何召回度量：无法回答"知识库里的东西，助手到底查得到多少"。
6. 文档没有版本概念：改一份文档只能删了重传，历史内容不可回溯。

## 二、默认决策（直接采用，不再确认）

- **D1 更新=新版本**：改文档内容走"上传新版本"，版本号 +1，旧版保留可下载/可回滚；改名只改元数据不升版本。默认保留最近 10 个版本，超出归档。
- **D2 删除=软删**：进回收站保留 30 天，可从回收站恢复；硬删除需二次确认并记审计。删除文档不删标签定义，只断开 `document_tag`。
- **D3 标签一套表、两种来源**：`tag.kind = model | user`，同一 `document_tag` 上记 `source + confidence`。模型标签默认 `candidate`，用户可一键全部接受。
- **D4 解析模型可选**：上传/重解析时用下拉选解析模型（来自 LLM 配置，默认=平台默认模型）；解析结果记录 `parse.model`，可对同一文档用另一模型重跑并比较（只保留最后一次为有效版本）。
- **D5 Skill 粒度默认标签级**：选中一个标签 → 生成一份 Skill（覆盖该标签下全部文档）；也支持选中若干文档生成（文档级）。两种来源都写进 `skill.source_doc_ids` 与新增的 `source_tag_ids`。
- **D6 Skill 必须先草稿后发布**：生成只产 `skill_draft`（含 SKILL.md 全文预览、来源清单、模型），人工改名字/描述后点「发布」才进 workspace 命名空间、才可被 Agent 挂载。
- **D7 图谱只画真实引用**：标签↔文档、文档↔Skill、Skill↔Agent；不画相似度线。一篇文档多条标签边是正常的。
- **D8 召回率定义**（面板直接显示这四个数，算法见 §五）：
  - 文档自召回率 = 能检索到自己的文档 / 已就绪文档
  - 标签召回率 = 挂该标签且被检索到的文档 / 该标签应有文档
  - 助手命中率 = 真实检索请求中命中次数 / 总检索次数（来自 `recall_log`）
  - 记忆自召回率 = 能召回自己的活跃记忆 / 活跃记忆
- **D9 检索先 BM25 后向量**：一期用 BM25（中文 bigram + 词命中，复用 memory 模块实现），`embedding_status` 字段预留；不引向量库。
- **D10 检索结果必须标注命中路径**：`文件名 / 正文 / 标签` 三者其一或组合，用户一眼知道为什么这条出现。
- **D11 权限按工作区**：所有知识对象带 `workspace_id`；助手调用检索时按它可见的标签/分类过滤（一期全可见，但接口必须留 `scope` 参数）。
- **D12 本期不做**：多人协作与评论、文档内问答（RAG 对话）、PDF 高亮标注、OCR（扫描件如实报"需要 OCR"）、向量检索、跨工作区共享。

## 三、数据模型（最小但够用）

```
document(id, workspace_id, name, ext, mime, size, sha256, version,
         storage_id, storage_key, snapshot_key,           -- snapshot_key 显式字段，不再靠命名约定
         status: queued|parsing|ready|failed, parse{model, parser_version, pages, text_length, ms},
         title_hint, deleted_at, created_at, updated_at)
document_version(id, doc_id, version, sha256, storage_key, size, created_at)
document_chunk(id, doc_id, ord, text, page, sheet)          -- 已存在，保留
tag(id, workspace_id, name, slug, kind: model|user, usage_count, created_at)
document_tag(doc_id, tag_id, source: model|user, confidence, status: candidate|accepted, created_at)
skill(id, workspace_id, name, slug, ns, body, source_doc_ids[], source_tag_ids[],
      generated_from_hash, status: draft|published, created_at)
skill_draft(id, tag_id?, doc_ids[], model, body, name, description, created_at)   -- 生成后待人工确认
agent_skill(agent_id, skill_id)                              -- 现有绑定关系，图谱读它
recall_log(id, surface: search|agent|graph, query, hit_count, top_doc_id,
           matched_path: name|body|tag, latency_ms, agent_id?, ts)
```

## 四、流程（每条都要：位置 + 行为 + 状态 + 边界 + 回退）

### A 文档管理

- **A1 上传**：页头主按钮 + 整页拖拽（拖拽区不再固定在列表底部）。支持 PDF/DOCX/XLSX/PPTX/MD/TXT/HTML，单文件 ≤100MB，一次 ≤20 份。上传即建记录（`queued`），列表立刻出现，3 秒内转为 `parsing`。
- **A2 解析**：上传后弹一行"解析方式"（模型下拉 + 开始），默认用平台默认模型且可跳过（跳过=只存原件不解析）。解析产出：正文分块、`parse.*`、3–8 个候选关键词标签（`document_tag.status=candidate, source=model, confidence`）。
- **A3 查看**：一行一份文档，点行就地展开：元数据（大小/页数/字数/解析模型/存储位置/sha256）+ 正文前两段（可"看全部 N 段"，PDF 按页显示页码）+ 标签区 + 版本区 + 动作区。
- **A4 查询**：顶部搜索框（文件名即时筛 + 正文/标签服务端命中，300ms 防抖），每条结果标命中路径；支持按标签、状态、时间筛选；空结果给"清空筛选"。
- **A5 更新**：详情内「上传新版本」→ 新版本入库、重跑解析、标签重新候选（旧标签保留但标 `stale`）；版本区列出历史版本可下载、可"回滚到此版本"（回滚不删之后的版本）。
- **A6 删除**：软删进回收站；回收站页可恢复/彻底删除；彻底删除需输入文档名前 4 个字确认（不用 confirm 弹窗）。

### B 标签

- **B1 模型标签**：解析完成后在详情里以候选形式出现（浅底 + 置信度），支持单条接受/忽略与「全部接受」；未接受的候选不参与检索过滤。
- **B2 自定义标签**：详情内联输入，输入时联想已有标签（避免"合同/合同书"分裂）；回车即加，来源记 `user`。
- **B3 标签页**：按使用数排序的标签列表（名称 + 文档数 + 模型/用户来源），点标签进入"该标签下的文档"，可直接「生成 Skill」；支持重命名（全局改）、合并到另一个标签（`document_tag` 重指向）。

### C 生成 Skills

- **C1 两个入口**：标签行右侧「生成 Skill」；文档批量条「生成 Skill（选中文档）」。
- **C2 前置校验**：来源文档必须全部 `ready`；不足 1 份禁用并说明原因。
- **C3 草稿**：提交后进队列，产出 `skill_draft`（SKILL.md 全文 + 建议名字 + 描述 + 来源清单 + 用的模型）。列表顶部一行提示"3 份草稿待发布"，可预览/改名/发布/丢弃。
- **C4 发布**：发布时落 `skill`（`status=published`、`ns=workspace`）、写 `source_doc_ids`/`source_tag_ids`、落盘 SKILL.md；发布后 Skills 页立刻可见、Agent 配置页可挂载。
- **C5 过期提示**：来源文档新增版本或标签集合变化 → Skill 行显示"来源已变化，可重新生成"，重新生成产新草稿，不覆盖已发布版本（除非用户选"覆盖"）。

### D 图谱与召回

- **D1 图谱四列**：标签 → 文档 → Skill → Agent。列内节点按度数排序，超 60 个折叠为"还有 N 个"。
- **D2 交互**：悬停/点节点高亮邻接；点文档节点打开文档详情；点 Agent 显示它挂的 Skill 清单。手机端改为"分组列表 + 选中高亮"，不做缩小画布。
- **D3 召回面板**：图谱上方一行四张数字卡（文档自召回率 / 标签召回率 / 助手命中率 / 记忆自召回率），每张卡可展开看"未召回清单"（最多 20 条，可点进去补标签或改标题）。

## 五、召回率算法（必须可复算）

- **文档自召回**：取每份 `ready` 文档，查询 = 文档名去扩展名 + 首块前 40 字的关键词（去停用词，取 5 个）；检索 top5，命中自己记 1。抽样上限 200 份。
- **标签召回**：对每个文档数 ≥1 的标签，查询 = 标签名；检索 top10 取回文档集合，与该标签应有文档集合求交；recall = |交| / min(|应有|, 10)。
- **助手命中率**：`recall_log` 中 `surface=agent` 的 7 日聚合：hit_count>0 的比例；同时给平均命中条数。
- **记忆自召回**：每条形如 active 记忆取最长词/短语作查询，调记忆召回 top5，命中自己记 1，抽样 200 条。
- 每次检索写 `recall_log`（含 latency、matched_path），面板 7 日窗口。

## 六、安全与稳健（每条可断言）

1. 上传只接受白名单扩展名，解压后大小与声明一致（防 zip 炸弹：单文档解压上限 200MB）。
2. 解析出的文本一律作为纯文本渲染，不注入 HTML；链接抓取继续走 SSRF 四道闸。
3. 删除默认软删；任何硬删写审计表（who/when/what）。
4. 模型产出的标签名长度 ≤ 20 字、去掉控制字符与换行。
5. Skill 发布前必须人工点确认（接口层拒绝无人确认的自动发布）。
6. 检索接口带 `scope` 参数，越权标签/文档不返回。
7. `recall_log` 不记录文档正文，只记 doc_id、命中路径、长度类指标。

## 七、验证（数字取自本规格）

1. 静态：tsc 零输出；构建无 type check 失败；pytest 全绿。
2. 上传 → `ready` 的 P95 ≤ 30 秒（10 页 PDF，本机）。
3. 1000 份文档时列表首屏 ≤ 300ms；搜索 P95 ≤ 200ms（1 万段落）。
4. 文档自召回率 ≥ 90%、标签召回率 ≥ 95%（不达标则先补 BM25 分词再交付，并给出未达标清单）。
5. 手机 390×844：横向溢出 0；完成"上传→改标签→生成 Skill"≤ 6 次点击。
6. 版本：更新后旧版本仍可下载；回滚后 `document.version` 与正文一致。
7. 软删：删除后列表中不可见、回收站可见、恢复后标签与版本完好。

## 八、里程碑（连续执行，每站写 docs/reports/mN.md）

- **M0 取证与基线**：跑现有召回率（文档/标签/记忆），把数字写进 `docs/reports/knowledge-audit.md`；确认解析 pipeline 与 LLM 配置现状。
- **M1 数据层**：`tag`/`document_tag`/`document_version`/`skill_draft`/`recall_log` 建表与迁移；`snapshot_key` 显式字段。
- **M2 文档管理**：上传（整页拖拽）、多模型解析、版本、软删回收站、命中路径标注的搜索。
- **M3 标签**：模型候选标签 + 一键接受、内联自定义 + 联想、标签页（重命名/合并/进入文档）。
- **M4 Skill**：标签级与文档级两入口、草稿预览改名、发布落盘、来源变化提示。
- **M5 图谱与召回面板**：四列图谱、四张数字卡、未召回清单、`recall_log` 聚合。
- **M6 打磨**：手机端、空态/失败态、性能（列表虚拟化阈值 500 项）。

## 九、禁止事项

- 不得自动发布 Skill（必须人工确认）；不得把模型标签写成 `source=user`。
- 不得物理删除文档（除回收站彻底删除流程）；不得删除标签定义时连带删文档。
- 不得在解析未完成时允许生成 Skill；不得用相似度连线冒充真实引用。
- 不得把密钥、正文写入日志/`recall_log`。
- 不得用"看起来可以"代替 §七 的量化验收；未达标项必须列清单而不是省略。
- 不得顺手重构与本流程无关的模块（A2A、编排画布、记忆写入策略）。
