---
description: "Restore opaque Responses checkpoints through Session V4-to-V5 migration while preserving prior generations."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Restore supported V4 Sessions as V5 while retaining opaque Responses checkpoints for subsequent model requests. This adjacent migration preserves event identities and coordinates, promotes the audited historical checkpoint extension, and validates native encrypted items. It never reads or rewrites files; JSONL persistence publishes a separate current-generation successor.

## Table of Contents

- [Use this package](#use-this-package)
- [V4-to-V5 specification](#v4-to-v5-specification)
- [Native V5 admission](#native-v5-admission)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Use the [static catalog](../session-format-catalog/README.md) for complete restoration. Direct exports serve catalog assembly and tests; the package has no Cordis mount configuration. Header-only migration changes `version: 4` to `5` while retaining all other validated metadata. It does not inspect event bodies or publish files.

A complete restore streams every row through an independent stage and calls `finish()`. Partial output is not a successful migration. JSONL read access may return the converted artifact without publishing; write access verifies and exclusively creates the current successor beside unchanged predecessors.

<a id="v4-to-v5-specification"></a>
## V4-to-V5 specification

The edge preserves admitted event names, ids, ordering, timestamps, references, surface operations, and inherited cuts. It adds no events. Earlier formats first traverse their existing adjacent edges; V3-to-V4 retains its accepted namespacing of an unrecognized `compaction` block as `plugin:compaction`.

The sole content conversion changes `plugin:compaction` to `compaction` when the block has only `type` and `item`, and the item has type `compaction` or `compaction_summary` with nonempty string `encrypted_content`. Every item field, including unknown nested metadata, is retained unchanged. Nonmatching prefixed extensions remain opaque; malformed native `compaction` blocks refuse rather than acquire guessed meaning. Already-valid native checkpoints remain unchanged.

Only these declared content locations are visited:

- `user/message.data.content`
- `data.message.content` in `system/message`, `developer/message`, `assistant/message`, `tool/result`, and `team/message/queued`
- Each message's content in `agent/inbox/spliced.data.inserted` and `session/title-llm-request.data.messages`
- `compaction/summary.data.summary` and optional `rawOutput`
- `tool/ptc-dispatch.data.content`
- Complete `block-end` values in embedded assistant message/attempt streams; their matching `block-start` tags change together

Tool arguments, replay metadata, tool schemas, nested extension values, and unrelated event payloads are not traversed. Unknown required events are rejected by target restoration; unknown ignorable events retain their payloads. No plugin execution or provider request occurs during conversion.

Source events must be dense. A seeded artifact's final inherited `session/end-seed` marker determines its cut, which must match a supplied source cut; unseeded artifacts cannot contain that marker. Independent stages share no counters or mutable state.

Source V4 delivery markers retain their generation and must name the owning Session unless they lie inside its inherited parent prefix. A source V4 marker claiming target generation V5 refuses, preventing a header change from activating an unaudited watermark. Native V5 ownership checks apply to generation V5 markers; older markers remain historical.

<a id="native-v5-admission"></a>
## Native V5 admission

The V5 codec delegates unchanged row framing and native body restrictions to the V4 codec. It validates known opaque checkpoint payloads before recoverable-tail handling, so empty ciphertext or an unknown native item tag cannot be discarded as an interrupted tail. As in V4, an ignorable developer payload is deferred until the installed reader's event vocabulary is known.

Complete restoration retains V4 lifecycle, source, tool-role, system-message, catalog, and reference validation, with delivery ownership tied to the V5 header. Installed current Session validation supplies ordinary envelope and message checks. Native readers do not promote prefixed extensions; that operation belongs only to the adjacent migration.

A V4 reader rejects a V5 header. Preserved predecessors provide rollback material in an explicitly isolated older-runtime copy; they do not authorize ignoring the selected higher generation or downgrading current files. New V5 writes are absent from those predecessor files. A malformed or future selected generation never triggers fallback.

<a id="understand-the-implementation"></a>
## Understand the implementation

The migration copies only changed checkpoint wrappers. Opaque items and unrelated values retain their identities. Header, codec, content, and stage validation have separate owners in [src](src/index.ts); V4 body checks remain shared without changing their original generation's interpretation.

<a id="further-exploration"></a>
## Further Exploration

- [Session format protocol](../session-format/README.md) defines streaming stages and failure propagation.
- [V3-to-V4 migration](../session-format-v3-to-v4/README.md) owns tool-role and producer-source conversion.
- [JSONL persistence](../session-persistence-jsonl/README.md) owns immutable successor publication and generation selection.
- [LLM streaming](../../../docs/subsystems/llm-streaming.md#native-responses-compaction) defines the opaque checkpoint item.

<a id="model-experience"></a>
## Model Experience

### Checkpoint replay

#### What the model sees

A supported Responses route receives the original `compaction` or `compaction_summary` item, including `encrypted_content`, instead of textual checkpoint framing. The migration supplies no prompt text and does not interpret the encrypted content.

#### Token effect

Migration makes no model call. The provider determines the input cost of the retained opaque item when it is replayed.

#### KV Cache effect

Migration preserves the provider item and conversation order; it does not generate or modify cache credentials. Actual provider cache reuse remains route-dependent.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the documented checkpoint representation is promoted; unrelated opaque extensions remain uninterpreted.
- The library supplies no downgrade path or decryption, and unsupported model routes continue to reject native Responses checkpoints.

<a id="dev-note"></a>
### Dev Note

None.
