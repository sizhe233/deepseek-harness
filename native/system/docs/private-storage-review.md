# Retained POSIX storage review handoff

English | [中文](private-storage-review.zh.md)

## Status

The additive `./private-storage` candidate requires independent native source review and actual supported-filesystem acceptance before release. It is separate from the existing flock binding and Landlock launcher; their C sources and behavior remain unchanged. Importing the entry is lazy, and missing successor binaries fail rather than selecting an older package. The candidate package family is version `0.1.3`.

## Review inputs

The native implementation is [private-storage.c](../packages/entry/src/private-storage.c), SHA256 `072847e2fadade42506b2857e180441a31cae9131e236a554f1bfc5b56db7906`. The [typed lazy entry](../packages/entry/src/private-storage.ts) describes its opaque operations. [Native tests](../test/private-storage.test.js) use the [Worker fixture](../test/private-storage-worker.js), a [synthetic read-failure shim](../test/private-storage-read-fault.c), and an [independent syscall oracle](../test/private-storage-syscall-oracle.c). The syscall oracle never reports provider or persistence acceptance. Its Darwin deny-only ancestor fixture uses the public SDK permission `ACL_CHANGE_OWNER`; private leaves still require empty ACLs, and grant or mixed ancestor ACLs remain refused.

Independent review remains required for these areas:

- Resource references, environment cleanup, finalizer ordering, invalidation before close, and descriptor release after GC or Worker termination
- Literal component validation, retained ancestor bindings, no-follow opens, complete observations and distinct readonly-source/private-destination admission
- Same-parent exclusive publication, no ordinary-rename fallback, and identity-checked unpublished cleanup
- Same-parent nonblocking management leases, existing lock-file admission, fully consumed current records and bounded generated-record replacement
- Confirmed partial I/O, terminal failure, publication uncertainty, synchronization and late-release receipts
- Original byte/object/access-policy preservation, with no repair writes or destination links to source objects

## Native operation scope

Directory capabilities retain every admitted ancestor. Source files open readonly; shared readable directories and ordinary source hardlinks are permitted under source policy. Private destinations require current-user ownership, exact owner-only modes, admitted ACL policy and a supported writable persistent filesystem. Existing permissions are never tightened or repaired. `openPrivateRecord` applies private leaf admission to a readonly current-record handle; the higher-level record reader retains the separate 64 MiB ceiling and computes its digest. Shared installed-source streams still require an independently expected digest.

Linux destination observations report the ext filesystem family, XFS or Btrfs. The `0xef53` magic does not distinguish ext2, ext3 and ext4; the receipt never labels it specifically ext4. Actual exclusive-rename and synchronization support is checked by the operation, and an unsupported result fails. Darwin destination support is bounded to APFS with inspected empty extended ACLs. Trusted ancestor ACLs may contain only positively identified deny entries, which cannot grant namespace changes; ownership and mode restrictions still apply. Destination ACLs are never rewritten. Overlayfs and tmpfs can be readonly source filesystems but are refused as private destinations before creation. No diagnostic option weakens that provider policy.

Publication uses Linux `renameat2(RENAME_NOREPLACE)` or Darwin `renameatx_np(RENAME_EXCL)` under the same retained parent. Linux requires file fsync, exclusive rename, parent-directory fsync and final binding verification. Darwin requires file full synchronization, exclusive rename, parent-directory fsync, another full synchronization of the retained file, and final binding verification. A successful syscall sequence is not an empirical power-loss guarantee. Ordinary reads may update atime or emit operating-system audit events; preservation checks do not restore those by writing original files.

POSIX directory descriptors do not prevent an arbitrary same-user actor from renaming a directory. Namespace mutation requires the caller's cooperative management lease and trusted ownership model; the provider checks retained bindings and withholds unsafe cleanup. Close, GC and environment teardown release resources only and never publish, remove a name or select a runtime.

## Executed checks and remaining rows

Linux x64 Node24.19, using stable Node-API v8 and official headers, compiled the new addon with C11, warnings-as-errors and hidden visibility. GCC static analysis and UBSan reported no findings in the exercised checks. The compiled glibc addon SHA256 is `1082d838edf07ed4b530eeb00d962cd430aa9f4cda28669490a40ada072a011e`.

The latest Linux suite and its UBSan repeat each recorded 63 rows: 24 passed and 39 explicitly skipped. Of those skips, 37 require an admitted persistent private destination and two require actual Darwin process-birth behavior. Prior source/storage checkpoints also ran on tmpfs and overlayfs; neither filesystem was admitted as a private destination. Passed rows include readonly/hardlink source preservation, bounded sequential reads, source mutation refusal, no-follow/type checks, retained-parent lifetime, capability isolation, actual GC/Worker descriptor release, close-on-exec behavior, and truthful unsupported-platform process observation. Synthetic fault injection and the independent rename/fsync oracle remain diagnostic only.

The 37 persistent-destination rows remain unexecuted locally. They include empty-child creation/synchronization, exclusive output publication, collision/abort, private-record reads, lease admission/contention/lifetime, creation residue, generated-record replacement and refusals, complete bounded enumeration, output auditing, capacity observations and related mutation/fault cases. Required native CI sets `PRIVATE_STORAGE_REQUIRE_DESTINATION=1`, turning unavailable admission into failure. A skipped row is not an acceptance pass.

The existing flock and package-metadata suites passed 50 tests on the locally built glibc addon. The complete oracle build stopped because `musl-gcc` is unavailable; the glibc oracle was built and used, but musl production/oracle builds remain unexecuted. Linux ARM64, both macOS architectures, actual APFS behavior and all successor packed-consumer rows remain outstanding. Native streaming size maxima, final public artifact closure and all application consumers require their own evidence; these local checks do not close them.

## Bounded materialization and process observations

`openChild`, `createPrivateChild`, `openPrivateOutput`, `listDirectory` and `observeCapacity` preserve retained ancestry and distinct publication/release observations. Listing has a complete 100000-entry ceiling, with zero admitting only an empty directory; mutation and excess refuse instead of truncating. Output audit reads retain the 1 GiB streaming ceiling without granting 64 MiB control-record replacement authority. Capacity reports caller-available filesystem facts, not a global reservation. Consumers must apply bounded accounting and refuse sealing after partial writes or failed audits.

`observeProcessBirth(pid)` is Darwin-only and accepts this process or a kernel-verified direct same-owner child. It returns the raw `ri_proc_start_abstime` plus boot-session UUID after repeated ownership/birth observations. This is an observation, not a retained exit watcher: failure, ESRCH or reuse never becomes an exit-confirmed receipt. Linux returns an explicit unsupported result. Darwin compilation links libproc; actual macOS compilation and runtime remain required. The previous nine storage operation bodies are unchanged from the preserved `3a348e1f…` checkpoint.

## Current-record switching gap

The successor adds `acquireLease` and `replacePrivateRecord`. The former uses a retained private 0600 single-link lock and nonblocking flock; release never unlinks it. The latter requires the same private parent, a live lease, a current private record consumed to EOF with unchanged observations, a synchronized 0600 staging record, and the separate 64 MiB ceiling. It uses relative `renameat2(flags=0)` or `renameatx_np(flags=0)` solely for the generated control record, never for installed code or an original configuration file. The exclusive immutable-artifact publication operation remains unchanged.

Creation errors retain confirmed/indeterminate entry creation, observed object facts, binding checks, actual descriptor release and directory synchronization. No failed-open cleanup removes an unreturned entry. A higher-level generated-record owner binds a fixed name allowlist and checks current full observations, digest and application revision under the caller-owned lease before staging. Its receipt separates replacement facts, content verification, persistence and release. This is cooperative serialized compare-and-swap; it is not protection against a hostile same-user writer.

These primitives do not complete the application transaction. Consumers still need independently reviewed predecessor/operation linkage, current-reference publication ordering and interrupted-publication recovery. Original Profile files remain outside the write authority. Cold/live readers, editor imports, HMR, rollback and packed native acceptance require separate integration evidence.

## Public review delivery

This document and the exact source/test patch can accompany the existing source PR when publication is authorized and verified. A local working-tree path is not a published artifact or a user-accessible PR link. The review status remains pending until a reviewer records findings against the exact published source, and platform acceptance remains pending until the matching native binaries execute every required row.
