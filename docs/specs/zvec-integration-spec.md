# zvec 接入知识库检索 —— 任务拆解（规格 + 里程碑）

目标：把 `knowledge_search` 从 `LIKE %q%` 换成 zvec 的「BM25 全文 + 向量 + RRF 融合」，索引与正文分离、可重建、可回退，并给出可复算的召回率。

## 一、已实测事实（M0 之前拿到的，不要再验）

- `zvec 0.8.1`：wheel 17.8MB，唯一依赖 `numpy>=1.23`（项目 venv 已有 2.5.3）；cp312/313 + linux x86_64/aarch64 + macos arm64 轮子齐全。
- 写入：2 万条 768 维插入 1.2s；单批上限 1024 条（超过报 `Too many docs`）。
- 查询：HNSW topk=5 3.4ms；带 `filter="doc_id = 'x'"` 2.1ms。
- 磁盘：2 万 × 768 fp32 → 64.6MB（≈ 原始向量大小 + 6%）。
- 原生 BM25：`FtsIndexParam(tokenizer_name="standard")` + `Fts(match_string=...)`，中文「付款期限」命中排序正确（2.38 / 1.13 / 0.13）。
- 融合：`RrfReRanker(rank_constant=60)`，一次 query 传 `[向量查询, FTS 查询]` 直接出融合结果。
- 嵌入接法：`QwenDenseEmbedding(dimension, model="text-embedding-v4", api_key)`、`OpenAIDenseEmbedding(model, base_url, api_key)`（可接任意 OpenAI 兼容端点）、`DefaultLocalDenseEmbedding`（需 torch，重）。DeepSeek 无 embedding 接口。

## 二、默认决策

- **D1 索引不是真源**：正文/元数据永远以 SQLite `doc_chunk` 为准；zvec 只做索引。任何时刻必须能从 SQLite 全量重建（`scripts/rebuild_index.py`）。
- **D2 双引擎可回退**：`setting.search_engine = zvec | sql`（默认 zvec）。zvec 导入失败、索引损坏、集合缺失 → 自动降级到 SQL 检索并写 `warning` 日志 + `/api/health` 暴露 `index.status=degraded`。禁止静默降级。
- **D3 集合粒度按工作区**：`data/work/zvec/<workspace_id>/`，一个 collection；集合名 `kb`。进备份清单（与 studio.db 同批）。
- **D4 主键可推导**：zvec doc id = `"{doc_id}:{ver}:{ord}"`，写入幂等（重复写覆盖同 id），删除按 `doc_id` 前缀 + `ver` 或 filter 表达式。
- **D5 向量维度固定、模型记名**：集合建时固定 `dim`，并把 `embedding_model` / `dim` 写进 collection 旁的 `meta.json`；换模型 = 新集合 + 全量重建，不允许混写。
- **D6 一期先 FTS，不接 dense**：M1 只用 BM25 全文（零外部凭据），dense 在 M3 接（DashScope v4 / 火山 OpenAI 兼容二选一，按届时凭据定）。
- **D7 检索返回契约不变**：仍是 `[{id, name, snippet, page, sheet}]`，新增可选 `matched_path: fts|vector|both` 与 `score`，供前端标注命中原因、`recall_log` 统计。
- **D8 本期不做**：多向量字段、混合索引分片、稀疏 SPLADE、rerank 模型、多租户物理隔离、跨工作区联邦检索。

## 三、M0 探针结果（已跑，结论如下）

| 探针 | 结果 |
|---|---|
| 1 无向量字段建集合 | **可以**。M1 不必占位 `emb` 字段 |
| 2 删除 | `delete([ids])` 与 `delete_by_filter(expr)` 都可用 |
| 3 数组字段过滤 | `ARRAY_STRING` 能建，但 `contain(...)` / `contain_any(...)` / `tag_ids contain 'x'` 全部语法错（SQL 引擎只认比较运算）→ **不用数组字段**，标签过滤改成「SQL 先查 doc_id 列表 → zvec 带 `doc_id in ('a','b')` 过滤」 |
| 4 过滤表达式 | 已验证可用：`doc_id in ('d1','d3')`、`doc_id = 'd2'`、`(doc_id='d1') or (doc_id='d2')`；**不可用**：方括号 `in ['d1']` |
| 5 alter 加向量列 | `add_column(FieldSchema(dimension=...))` 报 TypeError → 加向量必须重建集合（与 D5 一致） |

未完成、留到 M1 首日验证的两项：中文 FTS 用真实长文档（>100 块）的 top3 合理性；后台写入 + 前台查询并发安全。

产出 `docs/reports/zvec-probe.md`（把上表 + 反例日志贴进去）。

## 四、里程碑

### M1 引擎抽象 + BM25 上线（不依赖任何 embedding 凭据）

步骤：
1. `pip install zvec==0.8.1` 写进 `pyproject`，锁定版本；离线包脚本加 wheel（+18MB）。
2. 新增 `src/agent_studio/knowledge/index.py`：`SearchEngine` 协议（`upsert(chunks)` / `delete(doc_id, ver?)` / `search(q, top_k, filters)` / `rebuild()` / `status()`）+ `SqlEngine`（旧逻辑搬进来）+ `ZvecEngine`。
3. 解析完成处（`knowledge/service.py` 解析收尾）调 `index.upsert`；删除文档、换版本处调 `index.delete`。
4. `knowledge_search` 工具与 `/api/knowledge/search` 改走 `SearchEngine`；返回加 `matched_path`。
5. `scripts/rebuild_index.py --workspace ws_default [--drop]`；`/api/knowledge/index/status` 返回文档/块数、集合大小、是否 degraded。
6. `setting.search_engine` 开关 + 自动降级路径。

验收（必须全绿才进 M2）：
- 3 份真实文档可检索，命中路径标 `fts`；同一 query 在 `sql` 引擎下的结果作对照表写入报告。
- 召回率基线（文档自召回 / 标签召回）在两种引擎下各算一遍，数字进 `docs/reports/m1.md`。
- 性能：写入 1 万块 ≤ 10s；查询 P95 ≤ 50ms（1 万块，本机）；索引目录 ≤ 2× 向量原始大小。
- 停机演练：删掉 zvec 目录 → 服务不报错、自动降级 SQL、`/api/health` 显示 degraded → 跑 rebuild 恢复。

### M2 元数据与标签过滤

1. `tag_ids`（或 `tag_csv`）写入；`filter` 表达式支持按标签、按状态、按分类过滤。
2. `knowledge_search` 支持 `tags`/`category` 参数（Agent 侧可选传，默认不过滤）。
3. 验收：挂同一标签的 3 份文档，按标签过滤查询只返回这 3 份；过滤 + 全文组合 P95 ≤ 60ms。

### M3 向量接入（凭据定了才做）

1. `embedding.py`：批量 embed（batch 32），`sha256(chunk_text) → vector` 本地缓存（SQLite 表 `chunk_vec_cache`），避免重复计费。
2. 写入路径改成「文本 + 向量」双写；集合按 `meta.json` 的 `dim` 建。
3. 查询改双路：`[Query(emb), Query(text, fts)]` + `RrfReRanker()`；`matched_path` 标 `both`。
4. 降级：embedding 调用失败 → 自动退化为 FTS-only 并告警。
5. 验收：真实 20 条问句，FTS-only 与 hybrid 的 top3 命中率对照表；embedding 成本（token 数 × 单价）写进报告。

### M4 召回率面板 + 调优

1. `recall_log` 落库（surface、query、hit_count、matched_path、latency、agent_id）。
2. `GET /api/knowledge/recall` 返回四个数（文档自召回 / 标签召回 / 助手命中 / 记忆自召回）+ 未召回清单（≤20 条）。
3. 前端「知识关系」段显示四张卡 + 清单。
4. 用 M1/M3 的数据调 topk、chunk 大小、RRF 常数；调优前后各一组数字。

### M5 交付

1. 备份/迁移：`backup.sh` 加 zvec 目录；`restore` 后索引缺 → 自动 rebuild。
2. 离线包：bundle 里带 zvec wheel（三平台），`verify-bundle.sh` 加一项 `import zvec` 冒烟。
3. 文档：`docs/specs/zvec-integration-spec.md` + 运行手册（重建/回退/换模型）。
4. 部署：本机重启验收 → 东京部署 → `/api/knowledge/index/status` 两端一致。

## 五、风险与回退

| 风险 | 表现 | 处置 |
|---|---|---|
| zvec 在东京/ARM 环境 import 失败 | 启动即报错 | 引擎抽象让 SQL 兜底；离线包冒烟测试；必要时 pin 低版本 |
| 索引与正文不一致 | 检索到已删文档 | upsert/delete 全部走 service 层单一入口；每日 `--verify` 对账（块数、doc_id 集合） |
| 换 embedding 模型混写 | 余弦距离无意义、无报错 | 维度+模型名写 `meta.json`；不一致拒写并要求重建 |
| 长文档写入超时 | 解析卡在写入 | 分批 512 条、超时重试一次；失败标 `index=failed` 但文档仍 `ready`（降级 SQL） |
| 磁盘增长 | 索引随文档线性涨 | 面板显示索引大小；旧版本向量保留 2 个版本上限 |

## 六、禁止事项

- 不得把 zvec 当唯一真源（正文/元数据必须在 SQLite）。
- 不得跳过 rebuild 路径（任何新集合都必须能被重建）。
- 不得在 embedding 模型/维度变化后继续写同一集合。
- 不得静默降级到 SQL 而不留 `warning` 与 health 标记。
- 不得把密钥写进 `meta.json`、日志或 `recall_log`。
- 不得为了"跑通"跳过 M1 的停机演练与 M0 的 5 个探针。
- 不得顺手改无关模块（A2A、编排画布、记忆写入策略）。
