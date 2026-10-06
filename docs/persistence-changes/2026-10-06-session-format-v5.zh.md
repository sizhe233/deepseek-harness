---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-session-format-v5

[English](2026-10-06-session-format-v5.md) | 中文

## 概述

将 SessionHeader.version 从 4 提升至 5，并向持久化消息和流块加入原生不透明 Responses 压缩内容块变体。共享声明会改变嵌入该内容的每个事件根类型。

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
    previous: "2026-09-21-user-question-reply"
    after: "7145bda27960b2dc382e9b46165508db9328bd18b2dc035934cb7481bc8f89ff"
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
    previous: "2026-09-21-user-question-reply"
    after: "5d27304b080180e8775dbb52db4a49bd65a1aed81bb726d8aea5a37184a969a6"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "5490c74149c2e5074e3b9a3004678cded6d78901e6eb6476b0abef3dd26981c8"
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
    previous: "2026-09-16-session-format-v4"
    after: "e2599edb69d671749d182b5911e83a9d8fb814c787e684b213aec2ff107b376b"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "61d50361466a7d392e274ff6f611c1d196378dbbebe50d0b90dc6061b784bb70"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "2c305739ba5c0956d7a4221929da2e886c8403553f822dfdccc59e4318f5a40a"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

新增联合变体相对于已最终确认的 V4 基线属于破坏性变化，因此本确认记录包含独立的 4-to-5 版本头转换。V4-to-V5 阶段保留事件坐标和普通载荷，仅提升恰好包含 type 与 item 字段、且 item 为带非空 encrypted_content 的有效 compaction 或 compaction_summary 数据项的 plugin:compaction 块。提供方数据项元数据无损保留。无效的插件前缀扩展保持不透明；畸形的原生 compaction 会被拒绝。已发布的转换语义和已接受的 V4 记录保持不变。只读恢复不会发布文件；写入打开会创建独立的 V5 后继文件，保留前驱字节和文件系统身份。旧读取器拒绝 V5；选中的代次不受支持或损坏时不会回退。本记录不声明真实提供方验收通过。

<a id="verification"></a>
## 验证

V4-to-V5 覆盖率运行通过 32 个文件中的 503 个测试，新迁移包的语句、分支、函数和行覆盖率均为 100%（126 条语句、135 个分支、27 个函数、102 行）。完整 JSONL 回归运行通过 19 个文件中的 754 个测试，保留一个既有跳过项。当前 migrate:sessions 命令通过 27 个真实进程测试。覆盖不透明检查点提升、损坏 JSON 前缀之后仍执行畸形原生内容与历史强制拒绝、确定性的 V3-to-V4-to-V5 恢复、V4 修订与发布不依赖兄弟会话、只读不发布、V5 写入与重新打开、V3/V4 字节及 inode 与时间戳不变、旧读取器拒绝以及不回退。历史 V4 迁移命令会在访问日志集前拒绝 V5 工作区。verify-persistence-formats --write 验证了 V0 至 V5 的六份完整参考。

<a id="dev-note"></a>
## 开发备注

无。
