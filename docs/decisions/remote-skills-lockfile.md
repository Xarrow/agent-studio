# 决策：不读写官方 `skills-lock.json`

## 背景
官方 CLI 使用 `~/.agents/.skill-lock.json`（version 3，字段 source/sourceUrl/skillPath/skillFolderHash/installedAt/updatedAt）
作为更新依据。

## 决策
- 本项目**不写**该文件，也不依赖它；
- 来源记录写在技能自己的 `source` JSON（source_id / commit / content_hash / mode / via / installed_at）；
- 提供"查看"能力：若磁盘上存在 `.agents/.skill-lock.json`，界面只读展示（不修改、不合并）；
- 未来若要兼容导入，读取时必须容忍未知字段、不改写对方文件。

## 理由
两套记录语义不同（我们有 source_id、镜像标注、mode），合并会引入"谁覆盖谁"的隐式规则；
互不覆盖是唯一不会破坏对方的状态。
