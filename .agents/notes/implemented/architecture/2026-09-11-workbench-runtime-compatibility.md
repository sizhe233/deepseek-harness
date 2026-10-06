# Agent Note: Workbench runtime compatibility

Status: implemented

English | [中文](2026-09-11-workbench-runtime-compatibility.zh.md)

## Problem

The Workbench deployment carries Session-routed OpenCode requests, opaque Responses compaction and historical logs that the official 0.1.5-rc.1 distribution cannot consume unchanged. Its file-preview plugin also participates in Chat file opening. Losing these capabilities breaks existing conversations even when the main application boots.

## Decision

The local runtime uses the official `dsh-v0.1.5-rc.1` dependency closure and applies source-owned compatibility changes to that version only. The Workbench patch manifest records original and replacement SHA-256 hashes. An unknown runtime or artifact refuses patching.

The pi-ai adapter derives `x-opencode-session` from the actual Session, preserves structured stream errors and prepares foreign tool history with the required reasoning text. The LLM and compaction packages retain native Responses compaction and its opaque replay items. These transport details do not add a new agent framework or change delegation policy.

The format readers retain every original message, tool result, usage sample and timed chunk. Compatible one-shot descriptors gain the current structural version. Obsolete continuable descriptors remain historical records: migration does not invent missing persona or tool restrictions and does not grant restoration authority.

Chat delegates ordinary files to the native Sidebar and permits the existing preview provider to handle structured tables and capability-checked external files. A provider refusal remains a refusal. Dedicated Connection RPC handlers resolve the shared web-server carrier through their owning context and retain caller-owned disposal.

## Alternatives considered

**An unmodified package upgrade.** The isolated corpus and plugin composition expose migration failures and the sibling-context RPC carrier failure. Boot success alone does not preserve the installed behavior.

**A fallback directory containing old Host packages.** Mixed service identities and event contracts would make the candidate irreproducible. The installation contains one exact Host generation.

**Promoting every old subagent descriptor.** Continuable records lack the persisted authority required by the current schema. Preserving their history without inventing authority keeps the previous restoration boundary.

## Consequences

The deployment owns a small source fork and immutable compiled patches. Its coordinator switches runtime, Profile, sessions, configuration and derived caches together. Rollback retains new V3 data separately because the predecessor cannot read it.

Focused model, migration and RPC suites, the GUI suite and the recorded Web suite exercise the changed boundaries. The private Workbench acceptance verifies all 1036 copied sessions and minimal real CPA/OpenCode requests. Performance measurements compare cold session opening separately from provider inference latency.
