---
kind: upgrade-guide
description: "MCP configuration overrides move from settings.yaml to the control-plane profile entry."
---

# MCP configuration in profile patches

English | [中文](guide.zh.md)

## Change

The MCP editor persists overrides in the volatile `entries` field of the standalone `@deepseek-ai/dsh-mcp-client/configuration` plugin. The Web bundle names this entry `mcp-configuration`. Settings imports the former `mcp-client` section from `settings.yaml` once and preserves the original file as `settings.yaml.imported`.

Supported profile composition automatically converts `@deepseek-ai/dsh-mcp-client` rows with `mode: configuration` to the standalone module, preserving ids, overrides, secrets, and unrelated configuration. Raw Loader compositions do not perform this migration and report an explicit error for that mode.

## Migration

1. Standard Web profiles need no manual change. Start the profile and check the MCP tab in Settings → Built-in plugins. Built-in Shell, Agent loop, Subagent, and Web search configuration remains on the sidebar's Plugins page.
2. In custom raw Loader configurations, change only the control-plane row's module to `@deepseek-ai/dsh-mcp-client/configuration` and remove `config.mode`. Keep its id and all other configuration. Normal stdio and HTTP bridge rows keep their existing module.
3. Confirm that saved MCP values reappear after restart. If a legacy settings section was rejected, inspect the warning and retained `settings.yaml.imported` before moving that section into the appropriate active profile entry; do not delete the retained file until the values are verified.
