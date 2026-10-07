---
description: "Save active profile configuration and apply it through Loader."
kind: "package-reference"
---

# @deepseek-ai/dsh-config-editor

English | [中文](README.zh.md)

## Summary

Save plugin configuration in the active profile’s patch and apply it immediately. Writes validate the complete candidate before touching disk and serialize with profile changes and HMR. Invalid values and higher-layer overrides leave the file unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this service in a profile application with Loader and `profileContext`. It has no configuration fields.

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
```

Use [settings](../../settings/settings/README.md) for forms restricted to live fields. Callers that edit complete configuration can use `ctx.configEditor.edit()`; ordinary fields retain Loader’s normal lifecycle.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [editor](src/index.ts) reconciles external changes before deriving a candidate, locks the profile manifest alongside other profile operations, and atomically replaces its config override. It preserves YAML comments and `!!js` expressions outside replaced values. A failed reconciliation restores the prior document and reloads the prior patches.

Configuration reads share one composition for entries without profile config overrides. Overridden entries are composed separately with only their own override removed; profile inserts and other entries' overrides remain effective. Returned configs are detached, and compositions are not cached between reads.

For a launcher-bound `profileDocuments` authority, `editWithReceipt()` validates and publishes through the native document lease, and `reverseEdit()` inspects retained before/after versions to reverse only still-matching owned raw fields. Unrelated changes survive; changed owned fields refuse reversal. An originally absent document is restored to explicit absence only while its complete published raw contents still match; concurrent document content remains. A retained override includes inherited values when necessary to preserve whole-config replacement semantics. Publication, durability and Loader application remain separate facts; late or unconfirmed publication outcomes require inspection. Ordinary unenrolled edits keep their file-backed behavior.

`createDocumentDerivation()` composes bounded edits and receipted reversals into one raw candidate under the provider’s write snapshot. It validates through the actual active plugin fibers without publishing or applying that candidate. An empty or oversized batch, stale entry, changed owned field, or a target removed by the batch rejects before publication. Retained raw-document history can cross code activations without admitting an earlier code or package graph.

`createOfflineConfigurationEditor()` uses the same retained-version and owned-field reversal with launcher-supplied native validators. Its declarations contain no Loader fibers, and its receipts explicitly report offline publication. It neither mounts plugins nor acknowledges live application.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Profile loading](../app-boot/README.md) — patch composition.
- [HMR](../hmr/README.md) — reload coordination.
- [Settings](../../settings/settings/README.md) — schema-derived forms.

<a id="model-experience"></a>
## Model Experience

Indirectly, through configuration values consumed by model-facing plugins.

#### KV Cache effect

Consumers that change request prefixes determine cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Edits target the active profile patch. Home patches and command-line overlays are read for precedence but are not write targets.
- A complete config override preserves ordinary fields but pins their current raw values at the profile layer.
- Only uniquely addressed entries owned by the profile’s root Include are editable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
