---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-session-format-v5

English | [中文](2026-10-06-session-format-v5.zh.md)

## Summary

Advances SessionHeader.version from 4 to 5 and adds the native opaque Responses compaction content-block variant to persisted messages and stream blocks. The shared declaration changes every event root that embeds that content.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The added union variant is a breaking change relative to the finalized V4 baseline, so this acknowledgement contains its own 4-to-5 header transition. The V4-to-V5 stage preserves event coordinates and ordinary payloads, promoting only a plugin:compaction block with exactly the type and item fields and a valid compaction or compaction_summary item carrying nonempty encrypted_content. Provider item metadata is retained losslessly. Invalid plugin-prefixed extensions stay opaque; malformed native compaction is refused. Released conversion semantics and accepted V4 records are unchanged. Read-only restoration does not publish; write opening creates a distinct V5 successor, preserving predecessor bytes and filesystem identity. Older readers refuse V5; unsupported or corrupt selected generations do not fall back. This record makes no claim about live provider acceptance.

<a id="verification"></a>
## Verification

The V4-to-V5 coverage run passed 503 tests across 32 files with 100% statements, branches, functions, and lines in the new migration package (126 statements, 135 branches, 27 functions, 102 lines). The full JSONL regression run passed 754 tests across 19 files with one existing skip. The current migrate:sessions command passed 27 real-process tests. Coverage includes opaque checkpoint promotion, malformed native and historical hard refusals after a corrupt JSON prefix, deterministic V3-to-V4-to-V5 restoration, V4 sibling-independent revisions and publication, read-only non-publication, V5 write and reopen, unchanged V3/V4 bytes, inode and timestamps, old-reader refusal, and no fallback. The historical V4 migration command refuses the V5 checkout before corpus access. verify-persistence-formats --write verified six complete references from V0 through V5.

<a id="dev-note"></a>
## Dev Note

None.
