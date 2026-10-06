---
kind: upgrade-guide
description: "Session V5 保存 V4 读取器无法消费的原生不透明 Responses 压缩块。"
---

# Session V5 保留不透明 Responses 检查点

[English](guide.md) | 中文

## 变更

工作树写入版本从 Session 格式 4 提升至 5。原生 Responses 压缩新增必需的 `compaction` 内容块变体，并无损保留提供方数据。这会使持久化消息载荷超出已接受的 V4 schema；旧读取器无法安全地忽略检查点，也无法从文本重建它。

相邻 V4-to-V5 迁移保留事件坐标和普通载荷。它仅将通过校验的 `plugin:compaction` 检查点提升为原生变体。更早的代次沿用既有相邻迁移链。原始代次文件保持不变，新写入器不提供降级转换。[持久化确认记录](../../../persistence-changes/2026-10-06-session-format-v5.zh.md)记录类型变化；[迁移包](../../../../packages/session/session-format-v4-to-v5/README.zh.md)拥有转换与拒绝规则。

## 迁移

1. 停止共享 Session 目录的进程，并在升级前保留备份。修改生产安装前，先针对隔离副本验证候选。
2. 同时升级 Host 及其 Session 格式目录。自定义集成必须通过目录包含 `@deepseek-ai/dsh-session-format-v4-to-v5`，不能把 V5 写入器与仅支持 V4 的读取器混用。
3. 贡献者日志集试迁移可运行 `pnpm run migrate:sessions --sessions-dir /path/to/sessions-copy --jobs 1`，并检查其摘要。历史 `migrate:sessions-to-v4` 命令会在访问日志集前拒绝此 V5 工作区。参见[迁移流程](../../../cookbook/adding-a-session-format-version.zh.md#corpus-migration)。
4. 通过普通持久化 API 打开已有 Session。只读打开会在内存中准备受支持的历史数据；写入打开会在追加前校验并发布独立的 V5 后继文件。不要重命名历史文件或编辑其版本头。
5. 确认原始代次文件未变，重新打开选中的 V5 后继文件，并验证不透明检查点保持完整。选中的代次畸形或不受支持时必须失败，而不是回退到旧文件。回滚需要保留的前驱并将 V5 数据单独保存；它不会将新消息合并到较早代次。
