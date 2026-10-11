---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-session-format-v5

[English](2026-10-06-session-format-v5.md) | 中文

## 概述

将 SessionHeader.version 从 4 升至 5，并在持久化消息和流块中加入原生不透明 Responses 压缩内容块变体。此转换保留已单独确认的工作目录归因、PTC 操作元数据和标题推理强度。共享声明会改变所有嵌入该内容的事件根。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "83d1743a79d39f517d2196d55da9860b7c9f242462b52bcb2f8c9a84b61a51b8"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "e8f686365b1839416c342885502c6d1f5f596f4260d87336e23c0a96d88cadb6"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "c445d9bd32d173f38ecb3d1d62da033a2c33466115d9ce39680a97eb3a523d9d"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "fb45d537653625c53ca7ee2df82a8c56f6182842d61efb147a52447bb257d2ec"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "be8c43c808b75ed4e56d628393cba9a4090155d0bcba8c16a5e992e824009214"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "6e746cd01f86d49fa500c476fd1a1eceb7a1e9f481aea30d45098517967bfb68"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "42e1b7bcd6942ff85c30efcbfdea977230ac7f323c3ced3dedcac686dcba495e"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-16-session-format-v4"
    after: "c3e2cce41a77e380c2118838f7eb0b53e06b80e8e696a462dd98fd2fd863dfe6"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-10-05-ptc-operation-metadata"
    after: "f3de47f1abd23f3babc92edcea774329feb156753831a7c4dea7e483f1652cc0"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "61d50361466a7d392e274ff6f611c1d196378dbbebe50d0b90dc6061b784bb70"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "7dea6f8360f4e8e670565c293e3c409bba1e4141077b327b9b88f3c0fb101fbf"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

新增的联合类型变体要求本记录包含自身的 4 到 5 版本头转换。V4 到 V5 阶段保留事件坐标和普通载荷，仅提升恰好含有 type 与 item 字段，且 item 为有效 compaction 或 compaction_summary、encrypted_content 为非空字符串的 plugin:compaction 块。提供方项目的元数据无损保留。不匹配的插件前缀扩展保持不透明；畸形原生 compaction 会被拒绝。工作目录归因及其 JSON 元数据、会话中途的系统提示和开发者工具更新、可选标题推理强度、PTC 操作元数据以及未知的可忽略插件记录均保留原有含义。已发布转换语义和已接受的 V4 记录不变。只读恢复不会发布文件；写入打开会创建独立的 V5 后继代，同时保留前代字节和文件系统身份。旧读取器拒绝 V5；所选代不受支持或损坏时不会回退。本记录不声明在线提供方的验收结果。

<a id="verification"></a>
## 验证

集成检查通过 node node_modules/vitest/vitest.mjs run 运行 packages/session 下的 session-format-v4-to-v5/tests/migration.spec.ts、session-persistence-jsonl/tests/{v5-checkpoints,v5-upstream-compatibility,native-source-admission,native-developer-admission}.spec.ts、working-directory/tests 和 session-title-llm/tests，八个文件中的 135 个测试全部通过。混合功能用例验证 V4 迁移和原生 V5 重新打开后的完整事件及模型可见顺序，包括归因元数据、提示与工具更新、标题推理强度、检查点提升、未知可忽略记录、只读不发布，以及前代字节、inode、设备、大小和修改／变更时间戳不变。已有准入与检查点用例验证畸形数据拒绝、旧读取器拒绝以及不回退。新增兼容性测试的定向 run-oxlint 检查通过。

<a id="dev-note"></a>
## 开发备注

无。
