---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-session-format-v5

English | [中文](2026-10-06-session-format-v5.zh.md)

## Summary

Advances SessionHeader.version from 4 to 5 and adds the native opaque Responses compaction content-block variant to persisted messages and stream blocks. The transition retains the separately acknowledged working-directory attribution, PTC operation metadata, and title reasoning effort. The shared declaration changes every event root that embeds that content.

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
    previous: "2026-10-05-working-directory-attribution"
    after: "83d1743a79d39f517d2196d55da9860b7c9f242462b52bcb2f8c9a84b61a51b8"
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
    previous: "2026-10-05-working-directory-attribution"
    after: "be8c43c808b75ed4e56d628393cba9a4090155d0bcba8c16a5e992e824009214"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "6e746cd01f86d49fa500c476fd1a1eceb7a1e9f481aea30d45098517967bfb68"
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
    previous: "2026-10-05-ptc-operation-metadata"
    after: "f3de47f1abd23f3babc92edcea774329feb156753831a7c4dea7e483f1652cc0"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "61d50361466a7d392e274ff6f611c1d196378dbbebe50d0b90dc6061b784bb70"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "7dea6f8360f4e8e670565c293e3c409bba1e4141077b327b9b88f3c0fb101fbf"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The added union variant requires this record's own 4-to-5 header transition. The V4-to-V5 stage preserves event coordinates and ordinary payloads, promoting only a plugin:compaction block with exactly the type and item fields and a valid compaction or compaction_summary item carrying nonempty encrypted_content. Provider item metadata is retained losslessly. Invalid plugin-prefixed extensions stay opaque; malformed native compaction is refused. Working-directory attribution and its JSON metadata, mid-conversation system and developer tool updates, optional title reasoning effort, PTC operation metadata, and unknown ignorable plugin records retain their existing meaning. Released conversion semantics and accepted V4 records are unchanged. Read-only restoration does not publish; write opening creates a distinct V5 successor, preserving predecessor bytes and filesystem identity. Older readers refuse V5; unsupported or corrupt selected generations do not fall back. This record makes no claim about live provider acceptance.

<a id="verification"></a>
## Verification

The integration run using node node_modules/vitest/vitest.mjs run over session-format-v4-to-v5/tests/migration.spec.ts, session-persistence-jsonl/tests/{v5-checkpoints,v5-upstream-compatibility,native-source-admission,native-developer-admission}.spec.ts, working-directory/tests, and session-title-llm/tests under packages/session passed 135 tests in eight files. The mixed-feature cases verify exact restored events and model-visible order for V4 migration and native V5 reopening, including attribution metadata, prompt/tool updates, title effort, checkpoint promotion, unknown ignorable records, read-only non-publication, and unchanged predecessor bytes, inode, device, size, and modification/change timestamps. Existing admission and checkpoint cases verify malformed-data refusal and old-reader refusal without fallback. Focused run-oxlint passed for the new compatibility test.

<a id="dev-note"></a>
## Dev Note

None.
