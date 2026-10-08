# Windows native private-storage acceptance

English | [中文](README.zh.md)

These fixtures are test-only, generic and synthetic. They never enable privileges, change system security settings, create accounts, register services, compile a runtime addon or claim a power-cut test. Run them only in a unique temporary root. Matrix setup resolves only its newly allocated temporary root with native `realpath` and records both spellings; the product still rejects short-name and case aliases. A failed admission name check retains read-only ancestor-prefix diagnostics without discharging the failed row. `acceptance.mjs` allocates its own root and isolated Home; the individual oracle and worker commands require caller-owned synthetic paths.

## Build the SDK oracle

Use the existing public Windows x64 runner, native PowerShell, Node 24 and the installed Microsoft C compiler. No WDK or toolchain download is required. Fixture-local JSON helpers avoid Windows SDK type names, including the RPC `boolean` typedef.

```powershell
$oracleDirectory = Join-Path $env:RUNNER_TEMP 'private-storage-oracle'
pwsh -File workbench/private-storage-native.ps1 -OutputDirectory $oracleDirectory
pwsh -File workbench/private-storage-sdk-matrices.ps1 -OutputDirectory $oracleDirectory
$oracle = Join-Path $oracleDirectory 'private-storage-oracle.exe'
& $oracle abi
& $oracle token
```

The builders select the absolute installed x64 compiler and record compiler, developer-script, source, binary and log identities. Each target retains a `.cmd` file beside its compiler log; PowerShell passes only that file path to `cmd.exe`, and developer-environment or compiler failure stops the command file immediately. The primary build records the C source, executable and compiler-log SHA256 values in `oracle-build.json`; `compiler.log` includes `cl /Bv` and Windows SDK settings. `sdk-abi.json` records sizes, alignment, offsets, pointer width and signed NTSTATUS facts. `FILE_RENAME_INFO`, `FILE_BASIC_INFO` and `FILE_STANDARD_INFO` are SDK layout equivalents of the native records. The SDK omits the WDK mode typedef, so the oracle uses its documented single `ULONG Mode` member. This distinction is recorded in the JSON.

```powershell
node packages/storage/private-storage/tests/native/verify-abi.mjs $oracle packages/storage/private-storage/src/abi.ts
```

This command compares the compiled SDK with the actual source FFI offsets. It is a source-plane ABI check; it is not packed-consumer acceptance. The artifact-only toolkit passes its hashed `abi.json` instead; that JSON is generated once from the same built `lib/types/abi.js`, so the Windows consumer does not import Host source.

## Prepare one immutable native closure

The exact registry archives for Koffi 3.1.1 and its Windows x64, macOS arm64/x64 and Linux x64 packages are collected once. The helper verifies each archive against `pnpm-lock.yaml` SHA512, records archive SHA256 and every `.node` SHA256, rejects unsafe archive entries, and never runs an install script or repacks a registry archive.

```sh
node workbench/private-storage-closure-cli.mjs collect REPOSITORY_ROOT CANDIDATE_STAGING_DIRECTORY
```

An optional fourth argument supplies a directory containing the same exact archives, named as recorded by `privateStorageClosurePlan()`. Cached bytes undergo the same integrity verification. `private-storage-native.json` is the closure descriptor for the parent candidate manifest; its platform rows start as `not-run`.

`materializePrivateStorageConsumer()` takes `artifactDirectory`, the storage package's exact candidate record, the closure descriptor, a fresh `destination` outside the checkout, and `additionalPackages`. Supply every required peer and transitive dependency as exact archive records from the same candidate inventory, including the required Cordis peer. A storage/Koffi/platform-only folder does not satisfy the declared dependency graph. Missing or mismatched dependencies fail materialization. No registry, package manager, lifecycle script or developer symlink is used during materialization.

`smokePrivateStorageConsumer(consumer)` runs plain Node in that folder, imports the packed storage export and independently loads Koffi. It requires exactly one selected native binary with the recorded digest. Linux and macOS check import and dependency selection while the Windows-only backend reports unavailable there. This helper prevents checkout dependency links; filesystem hiding of the checkout requires a separate artifact-only CI job and is not claimed by the materializer.

## Run built or packed behavior acceptance

`--entry` must name built JavaScript. For packed acceptance, use the entry returned by the offline materializer, the same storage archive in every OS job, the immutable candidate manifest, and its exact source commit.

```powershell
node packages/storage/private-storage/tests/native/acceptance.mjs `
  --oracle $oracle `
  --entry $consumerEntry `
  --output (Join-Path $env:RUNNER_TEMP 'private-storage-native.json') `
  --candidate-archive $storageArchive `
  --manifest $candidateManifest `
  --source-sha $candidateCommit
```

The report records Node, OS build, architecture, token classification, filesystem facts, candidate/source/manifest/oracle/native-binary identities and individual outcomes. Exit 1 means a failure. Add `--require-complete true` to also exit 2 for any blocked required x64 row. The report retains unperformed power-cut testing and untested ARM64 as `out-of-scope`, and private-plugin composition as a `separate-requirement`; none counts as a pass. Without that flag, a partial report can exit zero, but its blocked rows remain acceptance gaps. A non-Windows run reports `nativeExecution: false`, zero native passes and a blocked native-runtime row. A missing oracle or failed native primitive never becomes a mocked pass.

## Composed artifact-only acceptance

The packed runner invokes loader checks, both Windows SDK oracle builds, official matching Node SDK preparation, the source-owner fixture compiler, independent ABI assertions and four separate behavioral matrices. The hashed artifact contains both Node SDK helper modules and the standalone source-owner validator, so no checkout is needed. It retains every failed or blocked report and attempts each independent admitted matrix even when another fails. Compiler-time rejected artifacts cannot become eligible through a later build; one fixed SDK binary identity spans ABI and all behavioral checks. Inputs are checked before and after each invocation.

- `windows-primary.json`: original byte/ACL/identity/lease/publication matrix, always using `--require-complete true`
- `windows-admission.json`: real conditional ACL, kernel rejection of malformed descriptors, junction/unknown reparse, alias/case, pipe/device and read-only existing-volume admission cases
- `windows-boundary.json`: deterministic retained-handle races, owned process-death phases, SDK inheritance controls and live Worker close/termination
- `windows-owner-faults.json`: [source-instrumented owner faults](owner-fault-README.md), retaining every original directory, cleanup, internal-call and dynamic allocation/exposure requirement ID with `packedProductionBinaryExecution: false`
- `windows-composite.json`: exact subcase mapping, retained original placeholders, raw report bytes, exits, signals, timeouts and missing obligations
- `windows-native-suite.json`: all prerequisite outcomes and the final required-evidence decision

The four matrix budgets are 20, 10, 30 and 30 minutes. Preflight budgets total 27 minutes; the outer 135-minute job allows setup and teardown without truncating these bounded steps. A timeout remains a failure even if an exit code appears successful; interrupted or unclosed-process reports are retained on disk without being accepted. Uncertain descendant teardown withholds recursive synthetic-root cleanup. Empirical power loss, Windows ARM64 and private-plugin composition retain their separate stated scope; no skipped or missing native row becomes a pass.

## Declared acceptance scope

The candidate manifest binds `privateStorageAcceptance.claim` to `ordinary-local-ntfs-private-bytes-v1`: Windows x64 private data on writable, persistent local NTFS. The evaluator checks the independently observed root filesystem/device facts against that claim. Unsupported backing is rejected with its specific diagnostic; the claim does not promise cloud, remote, virtual or other filesystem support. The existing Linux/macOS behavior and private-plugin composition remain separate merge requirements.

The complete expanded inventory remains in `expandedEvidence`, with raw reports, exit codes, missing rows and original blocked placeholders. `expandedComplete` reports that inventory independently. A successful declared-profile result means every applicable requirement passed; `not-required-for-declared-use` and `not-applicable` contribute zero passes. An actual failure, unknown blocked row, invalid report, failed prerequisite or incomplete mandatory case always prevents success. The default strict evaluator without an explicit claim still requires the expanded inventory.

Seven explicit conditions can be activated by the candidate-bound `requiredConditions` list. They cover an available authorized unsupported volume, isolated genuine storage failure, actual volume mount, genuine cloud provider, authorized remote volume, running executable/mapped-image replacement, and a safe genuine kernel-release refusal fixture. Executed conditional cases also activate their requirement. A validated read-only mounted-drive inventory activates an available local unsupported-volume probe; missing or contradictory inventory cannot establish inactivity. Unreadable media and unqueried remote mappings retain their observations and limitations rather than being called absent. No accounts, mounts, privileges, remote authentication or system settings are provisioned automatically.

Restricted primary-token rejection, all ACL/reparse/race/durability/lifetime guarantees, the actual live-Worker termination case and every modeled allocation/call/cleanup fault remain mandatory. Conditional callback ACL tests are mandatory; their name does not make them environmentally conditional. Pinned Koffi `free(value):void` has no recoverable failure result for a valid owned allocation, so that one retained raw row is explicitly N/A. Allocation/view ownership and every ordinal derived from the exact native baselines remain required. Injected failure returns after successful cleanup establish bookkeeping, not genuine kernel refusal. These distinctions do not imply empirical power-loss testing or Windows ARM64 coverage.

## Fault, race and GC workers

`acceptance.mjs` invokes these automatically. They can also be run against a separately prepared synthetic root and built entry for diagnosis.

```powershell
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot short-write record.bin
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot post-flush-failure record.bin
node packages/storage/private-storage/tests/native/fault-worker.mjs $consumerEntry $syntheticRoot rename-return-lost-unqueryable record.bin
node --expose-gc packages/storage/private-storage/tests/native/gc-worker.mjs $consumerEntry $syntheticRoot directories $oracleDirectory
node --expose-gc packages/storage/private-storage/tests/native/gc-worker.mjs $consumerEntry $syntheticRoot leases $oracleDirectory
```

The fault worker wraps the same external Koffi dependency before the package's lazy first call. All ordinary calls reach the real DLL; each injected result or exception is labelled, with whether the native call was forwarded. Scenarios cover creation-before-write inspection, short writes, write/pre-flush/rename/post-flush/verification/close failures and lost rename returns. Read-only reconciliation distinguishes published, not-published and genuinely indeterminate results. Successful and possibly successful renames must never receive deletion disposition. Pre-publication cleanup reports `delete-pending`, not guaranteed disappearance. A final source-close error preserves established `published/synced` facts but reports `cleanup: 'failed'` and `cleanupFailed: true`: release is unconfirmed, not known to have left a live handle. The source handle is never retried. The `close-failure` fixture requires successful real cleanup before substituting a failure return and does not establish genuine kernel refusal.

`creation-barrier` and `root-guard-barrier` emit a JSON event and wait for one byte on stdin. The controller independently inspects the empty created file or tries to rename an otherwise empty guarded directory, then releases the worker. Running either manually without supplying that byte deliberately leaves the worker waiting. The lock-process case verifies that killing a separate monitor does not release the writer's lease, while actual writer exit does; the persistent lock identity is preserved.

The GC worker compares explicit-close controls with 100 dropped directories or leases. It observes real process-handle counts, forwarded open/close calls and allocated/freed backing buffers; forces GC across event-loop turns until observed release or its deadline; forbids namespace calls from finalizers; and reacquires every lease without deleting its lock object. The acceptance controller independently reopens every resulting lock file and checks identity and security.

## Native loader rejection fixtures

```powershell
node packages/storage/private-storage/tests/native/loader-negative.mjs $consumerRoot (Join-Path $env:RUNNER_TEMP 'loader-negative.json')
```

Run this against the verified installed consumer before the main suite, so a blocked behavioral area cannot prevent loader-negative evidence. It clones the consumer for a pristine Windows baseline and four negative cases: missing/corrupt selected binary with a detectable fallback path, and a nested `static.cjs`-level platform shadow that exports another object or throws after a marker write. The real loader must reject every negative case without executing a shadow, Koffi loader entry or fallback marker, and without creating a requested root. The `.node` extension observer forwards actual Node loading; it does not emulate native success. Only the disposable clone is changed. Non-Windows execution is explicitly blocked.

## Fifteen-area evidence ledger

Implementation of a check is not evidence that it ran. The result JSON for the exact candidate is authoritative; retain failed and blocked rows. Implemented fixtures and remaining gaps are listed below. All new Windows fixture execution is still pending; source/portable tests do not satisfy these rows:

1. ABI: compiled SDK versus actual FFI offsets; real source-handle mode and identity observations. Synthetic pending-status tests remain separate from native completion evidence
2. Identity/token: current-user ownership, restart and runner classification; real anonymous foreign-token and same-user restricted-token denial against a matched readable control. The anonymous comparison temporarily grants only traversal on its retained synthetic parent through `NtSetSecurityObject`, retaining descriptor control bits and requiring byte-identical restoration; it never enables privileges. Public API rejection runs under same-user, anonymous and restricted thread impersonation. These cases still require native execution. Restricted primary-process admission remains blocked
3. Creation privacy: broad-parent creation and independent inspection after native create before the first write, plus the same real anonymous/restricted denial checks at that barrier. Alternate-token setup failures remain explicit blocked results
4. DACL: real public, null, empty, inherited, ordered deny, object and callback fixtures retain their creation handle for before/after descriptor and identity inspection. That handle requests no DELETE access; its private ACL is restored only after rejection checks, for cleanup. Windows always sets [SE_DACL_PRESENT on associated objects](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/security-descriptor-control), so the required absent-DACL case modifies only a copy returned by a real native security query. Its report labels `instrumented-descriptor-buffer`, verifies read/replacement refusal and unchanged disk bytes, descriptor, identity and parent entries, and explicitly excludes real disk absent-DACL evidence. Other normalized forms remain blocked. Conditional callbacks and OS rejection of invalid ACL/descriptor submissions run in the admission matrix
5. No-follow: final/intermediate/dangling symlinks and internal/external hard links. Unavailable symlink authority is blocked; junction and unknown-tag admission fixtures are implemented; mounted-volume and cloud reparse fixtures remain missing
6. Races: deterministic empty-parent guard and prewrite barriers. The boundary matrix implements leaf substitution, retained intermediate-parent denial with before/after relocation controls, blocked staging-name substitution with compatible read/SDK inspection, own-handle publication and post-release rename controls, failed-write cleanup, and canonical ACL drift using the oracle's textual SID in SDDL
7. Bounds: empty, exact caller limits, the full 64 MiB ceiling, over-limit and invalid limits. The boundary matrix attempts real growth/truncation/same-size writers at retained-read barriers and separately checks an existing writer. Denied writer acquisition is not a mutable-snapshot claim. Native pipe/device admission is separately exercised
8. Names: path forms, ADS, devices, control characters, malformed UTF-16, case aliases, trailing punctuation and valid Unicode. Existing short-alias and owned case-sensitive-directory fixtures are implemented; unavailable setup remains blocked without enabling filesystem features
9. Publication: exclusive collision, replacement and old/new readers with and without delete sharing. Readonly-target rejection and lease-cooperating publishers are implemented; the executing-image fixture remains missing
10. Durability: observed write-through source, relative native rename, same source identity and both file flushes; labelled real-call fault injection. Supplemental allocation/query/read/pending/lock/directory/cleanup-return fault matrices are implemented. Injected returns are labelled and genuine kernel storage/release failures remain unestablished; this is not a power-cut test
11. Directories: nested fresh roots, private child publication and reopened identity. The exact native sequence must run before a synced receipt is accepted
12. Crash recovery: process-owned lease survival after monitor exit and release after writer exit. Seven real owned-process kill phases cover before/after creation, writing, flush and publication; process death does not establish power-loss durability
13. Resources: explicit close, forged capability rejection and actual GC release use C-owner counts, independently matched SDK HANDLE/full-identity snapshots, process handle counts and reacquired unchanged lock objects. Native metadata and transient allocations must return to their controlled baselines. Actual cross-worker rejection, live Worker close/termination, SDK child inheritance with a positive control, and stale-handle reuse are implemented. Their real Windows outcomes remain mandatory; no lifetime guarantee is inferred from source tests
14. Unsupported environments: observed local filesystem admission. A bounded read-only probe may use an observed already-mounted local unsupported volume. Unavailable environmental cases retain their blocked raw evidence and the explicit applicability decision above
15. Packed consumers: exact archive closure, required dependency/peer validation, independent import and actual selected binary digest. Artifact-only platform jobs must establish final candidate acceptance; source tests do not substitute

Windows arm64 is explicitly untested. No architecture inherits another architecture's result. Linux/macOS regression and consumer jobs remain required outside this Windows-only behavioral suite. Abrupt power loss requires separate suitable infrastructure; no paid or privileged fixture is introduced here.

## Portable harness bookkeeping checks

```sh
node --test packages/storage/private-storage/tests/native/*.test.mjs workbench/private-storage-*.test.mjs
```

These portable tests verify report admission, subcase mapping, argument handling and bounded process ownership. They do not contribute a native pass.
