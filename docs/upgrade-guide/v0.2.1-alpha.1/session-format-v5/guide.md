---
kind: upgrade-guide
description: "Session V5 stores native opaque Responses compaction blocks that V4 readers cannot consume."
---

# Session V5 preserves opaque Responses checkpoints

English | [中文](guide.zh.md)

## Change

The checkout writer advances from Session format 4 to 5. Native Responses compaction adds a mandatory `compaction` content-block variant with losslessly preserved provider data. This widens persisted message payloads beyond the accepted V4 schema; an older reader cannot safely ignore the checkpoint or reconstruct it from text.

The adjacent V4-to-V5 migration retains event coordinates and ordinary payloads. It promotes only a validated `plugin:compaction` checkpoint to the native variant. Earlier generations use the existing adjacent chain. Original generation files remain unchanged, and the newer writer does not provide downgrade conversion. The [persistence acknowledgement](../../../persistence-changes/2026-10-06-session-format-v5.md) records the type changes; the [migration package](../../../../packages/session/session-format-v4-to-v5/README.md) owns conversion and refusal rules.

## Migration

1. Stop processes sharing the Session directory and retain a backup before upgrading. Validate the candidate against an isolated copy before changing a production installation.
2. Upgrade the Host and its Session-format catalog together. Custom integrations must include `@deepseek-ai/dsh-session-format-v4-to-v5` through the catalog rather than combining a V5 writer with a V4-only reader.
3. For a contributor corpus trial, run `pnpm run migrate:sessions --sessions-dir /path/to/sessions-copy --jobs 1` and inspect its summary. The historical `migrate:sessions-to-v4` command refuses this V5 checkout before accessing the corpus. See the [migration procedure](../../../cookbook/adding-a-session-format-version.md#corpus-migration).
4. Open existing Sessions through normal persistence APIs. Read-only opens prepare supported historical data in memory; a write open validates and publishes a distinct V5 successor before appending. Do not rename historical files or edit their version headers.
5. Confirm the original generation files are unchanged, reopen the selected V5 successor, and verify opaque checkpoints remain intact. A malformed or unsupported selected generation must fail instead of falling back to an older file. Rollback requires the preserved predecessor and must keep V5 data separate; it does not merge new messages into an older generation.
