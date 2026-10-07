# Native directory and cleanup-return fixtures

This test-only reference covers the supplemental directory/cleanup matrix. It operates only on fresh synthetic paths, the installed public packed entry, and Koffi 3.1.1. It does not change production code, install dependencies, enable privileges or change security settings. [The native acceptance reference](README.md) owns offline consumer materialization and the existing Windows SDK oracle build.

## Invocation and evidence

```powershell
$env:CANDIDATE_SHA = $verifiedCandidateCommit
node packages/storage/private-storage/tests/native/directory-boundary-matrix.mjs `
  --entry $consumerEntry `
  --oracle $oracle `
  --output (Join-Path $env:RUNNER_TEMP 'directory-boundary.json')
```

All three paths must be absolute. The entry must be the materializer's public `node_modules/@deepseek-ai/dsh-private-storage/lib/index.js`, with `consumer-inventory.json` present. The oracle requires its matching `oracle-build.json` and `compiler.log`; its recorded C-source and executable hashes must match. The report binds the installed entry, package manifest, consumer inventory, recorded archive, selected Koffi native payload, SDK executable/source/compiler log, fixture source bytes and supplied candidate commit. The enclosing immutable artifact runner remains responsible for verifying the candidate commit and archive before materialization; this supplemental command does not independently reconstruct that archive or claim checkout isolation.

Exit 1 means a failed row, 2 means blocked required work, and 0 requires every required row to pass. Non-Windows or non-x64 execution emits the complete blocked inventory with zero native passes. The two unestablished cleanup scenarios retain explicit blocked raw rows, so this standalone expanded matrix does not return complete acceptance. `cases` and `blockedCases` in `directory-boundary-support.mjs` define the exact report inventory for runner integration. The packed composite preserves every row when replacing the older combined directory/cleanup placeholder and applies only the [explicit declared-profile mapping](README.md#declared-acceptance-scope); nearby passing rows cannot remove an applicable obligation.

## Observations and safety

Each case starts a separately owned subprocess with a scrubbed environment, bounded JSON output and a 30-second result/teardown budget. The worker imports no production source, mocks no platform and forwards every ordinary call to the installed native library. The independent SDK process inspects original and final identities, ownership and protected descriptors; ordinary OS reads compare synthetic bytes. After actual worker exit the controller renames the root and reacquires the unchanged fixed lease, establishing that retained guards and locks no longer prevent access.

Malformed directory pages cover short headers, excessive returned lengths, odd/empty/overrunning names and truncated, overlapping, unaligned or excessive next offsets. Native enumeration error/warning and pending-status returns are injected after a real synchronous query. Pending completion uncertainty retains exactly two backing allocations until process exit and rejects another operation before any native call or allocation. A bounded zero-time kernel wait observes the already completed synchronous request; these cases do not establish that a real asynchronous operation became pending.

The entry limit uses actual unmodified native enumeration. The total-query case supplies repeated dot-only pages after forwarded queries and allows the backend at most 64 query calls. Attempting call 65 emits a distinct budget event and parks the child for controller termination. This is a failed backend bound, never a pass credited to the wrapper. The source now counts every scanned record, including dot entries, with the caller entry allowance plus two dot records. This gives a finite query/work bound when each native call returns; it does not introduce a wall-clock timeout. Windows execution must establish the corresponding result for the packed candidate.

Cleanup cases forward a real successful token/file/directory close, lease unlock, descriptor release or staging deletion disposition, then inject the failure return seen by the public API. The trace records both returns and actual release. Staging cases additionally inject a pre-publication write failure, require a not-published/unconfirmed receipt with failed cleanup accounting, and independently verify unchanged original files and no surviving staging file. All released resources are removed from ownership tracking before the injected failure; a repeated native close/free is rejected before reaching the kernel and remains a sticky protocol failure even if production catches the exception. Further handle opens after an injected cleanup return are rejected, preventing numeric reuse from hiding a stale close. Repeated public lease/directory closes must make zero native calls.

A failure return substituted after successful cleanup demonstrates error handling, not a genuine OS release failure or storage failure. Genuine cleanup refusal remains an unestablished conditional scenario until an adopted safe fixture or declared environment requires it. Koffi `free` has no recoverable failure return for a valid owned allocation; that retained raw row is N/A in the declared profile and contributes zero passes. Throwing around it cannot demonstrate allocator failure, and the fixture never double-frees an uncertain pointer. Actual allocation/view ownership and every modeled cleanup-return case remain mandatory.

## Portable validation

```sh
node --test packages/storage/private-storage/tests/native/directory-boundary-harness.test.mjs
```

The portable suite validates bounded protocol behavior, malformed-record construction, exact source/binary report bindings, missing/duplicate events, quarantine accounting, report negatives and non-native refusal. None contributes a Windows native pass. No Windows compiler or native execution is available on Linux; syntax/protocol success does not close that gap.
