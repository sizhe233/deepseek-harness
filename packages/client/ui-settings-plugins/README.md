---
description: "Built-in plugins settings section for the dsh web client: the Settings navigation entry and the tab chrome that feature-owned tabs register into."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugins

English | [中文](README.zh.md)

## Summary

Use the **Built-in plugins** settings section to inspect the plugins this deployment ships. The section is a shell: it owns the navigation entry and the tab row, and exposes `settings.plugins.tab` for feature-owned pages. This package contributes an editable MCP tab when the Host provides its configuration Remote; the read-only inventory contributes another tab. Configuring a built-in plugin happens on the sidebar's Plugins page, where each official plugin's own companion package registers its page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Built-in plugins** in Settings. [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.md) contributes the inventory tab. The MCP tab edits configured bridge entries when `remote.mcpConfiguration` is available. One registered tab is shown as the page itself; multiple contributions show a tab row. A deployment whose composition contributes no tab shows the section's empty line.

To contribute a tab, register into `settings.plugins.tab` with an `id`, an `order`, and a localized `label`; the section renders the entries in order and mounts a tab on its first selection. Feature copy stays in the registering plugin's dictionary.

### MCP configuration

Expand the MCP group and select an entry to edit its transport, server name, command and arguments or HTTP endpoint, tool-call timeout, enabled state, and reconnect policy. **Save** sends only changed fields and reloads that connection; **Discard** restores the last Host projection. A failed save retains the draft. Existing environment-variable and request-header values are write-only: a blank value keeps the stored value, and removing its row clears it. Read-only deployments disable edits.

The controller retains the last loaded entries while reconnecting and exposes a retry action after a failed read. Updates run serially with the current configuration revision; the Host decides whether to accept them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The section declares `settings.plugins.tab`, a root list slot whose labels become ordered tabs; a lone contribution renders as the page itself, and a tab stays mounted after its first selection so search and the inventory snapshot survive switching. The section's `inject` projects the slot's ledger into ordered rows whose labels follow the active locale, cached until the ledger version or the locale revision moves. The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.md) — the read-only inventory tab.
- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section`.
- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page where official plugins are configured.
- [ui-settings-shell](../ui-settings-shell/README.md), [ui-settings-agent-loop](../ui-settings-agent-loop/README.md), [ui-settings-subagent](../ui-settings-subagent/README.md), [ui-settings-web-search](../ui-settings-web-search/README.md) — the official configuration pages, one companion package each.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Existing entries only** — the MCP editor updates configured bridge entries; adding or deleting Loader entries remains a profile-configuration operation. Deployments without the MCP configuration Remote omit that tab.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
