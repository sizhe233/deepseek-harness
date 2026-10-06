# Agent Note: Preserve Workbench behavior across upstream APIs

Status: implemented

English | [中文](2026-10-06-workbench-upstream-compatibility.zh.md)

## Problem

The maintained fork extends the official Host with durable Responses checkpoints, optional external plugin entry points, editable MCP configuration and process-lifecycle fixes. Upstream changes the Session writer, settings persistence, HMR ownership and SDK interfaces. A clean textual merge cannot establish that those behaviors survive.

## Decision

The fork merges official history and keeps a per-path compatibility inventory in [workbench](../../../../workbench/upstream-compatibility.json). Provider-native compaction follows the prepared adapter generation and preserves opaque checkpoint fields through historical Session conversion. Modern tool messages and image-offload projection use the upstream representations. Foreign-route adapters refuse unsupported checkpoints rather than flattening or discarding them. Opaque checkpoint blocks widen existing persisted message unions, so the fork uses a [V5 successor](../../../../docs/upgrade-guide/v0.2.1-alpha.1/session-format-v5/guide.md) rather than changing the accepted V4 meaning. The V4-to-V5 edge preserves ordinary payloads and promotes only validated historical checkpoint extensions; accepted V4 history remains unchanged.

MCP editing uses the current Config-derived forms and profile persistence. Secret values remain write-only, revision checks reject stale saves, and a failed persistence step restores runtime configuration and enablement. The Client keeps a dedicated MCP tab beside upstream feature-owned settings. Legacy control rows and stored namespace keys have narrow migrations.

Exact configuration watches belong to `dsh-hmr`; the fork retains file-depth and platform-readiness behavior, relative-path registration and failure notifications. Linux cancellation combines upstream control-pipe and direct-process settlement with process-count observations taken after establishment. PowerShell startup requires the acknowledged controlled prompt, including when custom arguments select stdin bootstrap.

The opt-in E2B family retains ordinary filesystem, shell, PTY and LSP behavior. Its SDK cannot provide the new independent subprocess control channel, so that request fails before allocating remote work. Terminal resizing uses the SDK; unsupported activity observations remain unknown. Live provider acceptance is a separate credentialed check.

Inherited workflows retain their exact upstream event conditions inside an official-repository guard. Fork CI runs with read-only repository permissions, packages candidates and never deploys. Post-build restart admission and image relay remain optional, hash-bound bridges; unknown bundles fail before any write. External plugin acceptance must use those same candidate bytes.

The real PowerShell encoding fixture reads child-produced scrollback after its independent file barrier, rather than treating a settled viewport as command completion. It verifies UTF-8 output and process teardown without changing product timing. A dedicated CI configuration requires those real PowerShell PTY cases on Linux, macOS and Windows, independently of the upstream Windows exclusions, and fails if PowerShell is unavailable. Its directory-change fixture uses the actual filesystem root so the same assertion applies to POSIX roots and Windows drives. The [reviewed repair](https://github.com/sizhe233/deepseek-harness/pull/4) records its deterministic controls.

## Alternatives considered

**Reset the fork to upstream.** This loses local behavior and removes the evidence needed to decide whether a patch has an equivalent replacement.

**Keep the previous runtime beside new packages.** Mixed service identities and Session APIs conceal incompatibility and do not produce a reproducible candidate.

**Treat compilation or Host CI as plugin acceptance.** Neither exercises independently maintained Client code, stored settings migrations, optional runtime bridges or real provider behavior.

## Consequences

Each retained or adapted patch needs focused behavioral evidence and an integrated candidate check. Released Session generations remain immutable. Candidate artifacts and test results identify exact source revisions; the repository-reference check permits full commit identities only in reviewed fields of the three versioned Workbench machine records, while prose continues to use release tags and PR references; skipped or unexecuted checks stay explicit. Production installation, user data migration and paid-provider probes require their own authorization.
