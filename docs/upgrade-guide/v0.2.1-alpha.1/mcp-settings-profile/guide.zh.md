---
kind: upgrade-guide
description: "MCP 配置覆盖值从 settings.yaml 迁移到控制平面的 profile 条目。"
---

# Profile patch 中的 MCP 配置

[English](guide.md) | 中文

## 变更

MCP 编辑器把覆盖配置保存在独立插件 `@deepseek-ai/dsh-mcp-client/configuration` 的 volatile `entries` 字段。Web bundle 中该条目的 id 为 `mcp-configuration`。Settings 会一次性导入 `settings.yaml` 中原有的 `mcp-client` 分区，并把原文件保留为 `settings.yaml.imported`。

支持的 profile 组合会自动把带有 `mode: configuration` 的 `@deepseek-ai/dsh-mcp-client` 条目转换为独立模块，保留 id、覆盖值、秘密值及无关配置。直接使用 Loader 的组合不会执行此迁移，并会针对该模式给出明确错误。

## 迁移

1. 标准 Web profile 无需手动修改。启动后查看设置 → 内置插件中的 MCP 标签页。Shell、Agent 循环、Subagent 和网页搜索的内置配置仍位于侧栏的插件页。
2. 对于直接使用 Loader 的自定义配置，仅把控制平面条目的模块改为 `@deepseek-ai/dsh-mcp-client/configuration`，并移除 `config.mode`。保留 id 和其他配置。普通 stdio 和 HTTP 桥接条目继续使用原模块。
3. 重启后确认已保存的 MCP 值仍然存在。如果旧 settings 分区被拒绝，先查看警告及保留的 `settings.yaml.imported`，再把该分区迁移到相应的活动 profile 条目；确认所有值之前不要删除保留文件。
