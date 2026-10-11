---
description: "Private byte storage for Host library consumers requiring retained Windows NTFS handles, exact owner-only security, atomic publication receipts and process-owned writer leases."
kind: "package-library"
---

# @deepseek-ai/dsh-private-storage

English | [中文](README.zh.md)

## Summary

`dsh-private-storage` provides synchronous private byte reads, atomic whole-file publication, private directory creation and process-owned writer leases. Host libraries and external extensions can use its opaque directory capabilities without importing a sandbox or Session package. It admits literal local NTFS locations on Windows x64 with an exact protected TokenUser-only DACL. Consumers own record formats, text decoding and crash-recovery decisions. It registers no Cordis service, model tool or application launcher.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Call `capabilities()` before choosing a platform backend. Its availability and native binary digest describe this process; they do not admit a filesystem or replace artifact acceptance evidence. Non-Windows hosts and untested architectures report unavailable without loading Windows DLLs.

### Directory and byte operations

`openPrivateDirectory(path, { create })` walks literal drive-rooted components and retains ancestor guards. Existing roots must already have the exact private descriptor; the library does not repair permissions. Missing levels are published individually when `create` is true, with separate `publications` receipts. The caller must trust ancestor owners and must not supply a home or workspace junction expecting it to be followed.

`openPrivateChild` and `createPrivateChild` return independently closable directory capabilities. Relative names are one literal component: separators, alternate streams, reserved-device aliases, malformed UTF-16, trailing dots/spaces, short-name aliases and case-only alternative spellings are rejected. Case-sensitive directories and all reparse tags are unsupported.

`readPrivateFile` requires an explicit byte limit up to 64 MiB and returns uninterpreted bytes. It denies write sharing and checks identity, size, change markers and privacy on the same handle before and after bounded reads. Files must have exactly one hard link. `createPrivateFileExclusive` publishes fully initialized bytes without replacement; `replacePrivateFile` replaces only an admitted private regular file or an absent entry. There is no in-place overwrite or path-based fallback. A live publishing source permits compatible read-only inspection but denies independent data-write and DELETE opens; its own retained handle performs publication and unpublished cleanup.

### Publication and recovery

Every publication receipt independently reports `publication` (`not-published`, `published`, `indeterminate`), `durability` (`synced`, `unconfirmed`, `unsupported`), full source/parent identities, phase, native status and cleanup. A failed post-rename flush remains `published/unconfirmed`. An uncertain rename is reconciled read-only; unresolved ambiguity withholds deletion. Cleanup marked `delete-pending` is a handle disposition request, not proof that every other open handle has closed.

`PrivateStorageError.receipt` preserves late publication outcomes. A final source-close error keeps established `published/synced` facts, while `cleanup: 'failed'` and `cleanupFailed: true` report unconfirmed release. These fields do not establish that a handle remains live; the implementation never retries that internal handle. `directoryPublications` records already-published ancestor levels when a later root-opening step fails. In-memory receipts do not survive process death: durable transaction records and restart recovery remain consumer responsibilities. Atomic replacement provides no hostile-writer compare-and-swap guarantee.

`synced` is scoped to the documented Windows/NTFS write-through metadata and full-file flush behavior on a conforming trusted storage stack. Regular files are flushed before and after a retained write-through source-handle rename. Empty directories are published by their write-through handles before any descendants are opened; their namespace completion does not claim POSIX directory-fsync semantics. Process-kill tests do not establish empirical power-loss survival.

### Leases, audit and cleanup

The actual writer acquires `acquirePrivateWriterLease(root, fixedName)` before application writes and retains the returned capability for its entire write lifetime. Contention fails immediately. Kernel ownership ends when that writer releases the lease or exits; a monitor cannot release another process's lock. Keep the fixed lock file in place. PID text, age, semaphore counts and deleting/recreating a lock file are not ownership mechanisms.

`auditPrivateTree` requires a live root lease and explicit aggregate entry/depth limits. Every descendant is opened and checked through retained parents; directories are reopened with enumeration rights and identity-bound before traversal. Enumeration is not a snapshot or a permanent attestation. `removeOwnedEntry` validates an expected full identity and deletes through that exact handle, with no recursive/pathname cleanup and no separate crash-durable deletion promise.

Close capabilities explicitly. Close/release is idempotent; operations after close reject. Children and leases retain the ancestors they need independently. Finalizers only release owned resources and never publish or delete. Capabilities cannot be forged, transferred between workers or converted into Node file descriptors.

The root and forwarding `./streams` entry share one installed provider. Streaming publication uses 1 MiB chunks and a separate 1 GiB ceiling; the byte API stays limited to 64 MiB. Source capabilities admit ordinary shared permissions and multiple links without granting private destination authority. `openSourceFileReader` requires an independently expected digest; `readSourceDocument` computes an observed document digest up to 64 MiB. `openObservedSourceFileReader` streams up to 1 GiB from exact provisional facts and returns `verification: 'observed'` only after EOF, unchanged observations, a computed digest and confirmed release.

`openPrivateStreamRoot` reports the actual retained parent and creation receipts. It creates only the final component beneath an existing parent, preserving parent security. Existing-root durability is `not-attempted`; new-root durability requires the provider's actual namespace synchronization. Windows publication identities must match the retained root and parent before binding verification succeeds. `openSourceChild` and `listSourceDirectory` retain source authority and report every bounded name. `inspectSourceLink` returns complete no-follow symbolic-link observations and the literal target; callers must independently admit targets. Linux reads the retained link descriptor; Darwin requires `freadlink` on macOS 13 or later; Windows rejects unsupported reparse tags. Enumeration and repeated observations never promise an immutable snapshot.

## Understand the implementation

Windows operations use the environment-owned Node-API 8 payload in `node-addon-system` 0.1.3. Handles, token resources and transient buffers are acquired and registered before JavaScript exposure. The retained operations include `NtCreateFile`, `NtSetInformationFile`, security queries and `LockFileEx`; Koffi 3.1.1 remains pinned for independent native fixtures. Unexpected unconfirmed completion quarantines its resources and refuses further operations. No token privileges are enabled. Actual abrupt Worker termination while the process survives remains a required native acceptance test. POSIX streams use the separate retained native payload from the same versioned package family.

- [`src/index.ts`](src/index.ts): opaque lifecycle, bounded operations and publication/reconciliation state
- [`src/native.ts`](src/native.ts): lazy native payload selection and retained-handle calls
- [`src/policy.ts`](src/policy.ts): literal names and bounded exact security-descriptor decoding
- [`tests/native/acceptance.mjs`](tests/native/acceptance.mjs): independent SDK oracle and packed-artifact acceptance

## Further Exploration

- [Storage subsystem](../../../docs/subsystems/storage.md): domain storage ownership
- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile): native relative opens and creation descriptors
- [NTFS caching behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior): scoped write-through metadata behavior

## Model Experience

None, as this byte-oriented Host library registers no model-facing content.

#### KV Cache effect

The library does not assemble or send model requests. Its callers own any use of stored bytes in a request prefix.

## Known Limitations and Deferred Work

- Windows x64 and local persistent writable NTFS are the implementation scope. the additive macOS/Linux stream providers have separate native acceptance requirements; Windows ARM64 is unavailable until independently tested. Remote, virtual, read-only, write-once, WebDAV, Terminal Services, FAT/exFAT, ReFS and unknown backends are rejected.
- The owning user, trusted ancestor owners, administrators, SYSTEM, the kernel and conforming storage drivers remain trusted. The library cannot certify every minifilter or hardware cache. Impersonating and restricted process tokens are rejected.
- This API is exclusively for exact owner-only private state. Preserving deliberately shared installed-file ACLs is a different capability; callers must not relax this admission policy to edit such files.
- Acceptance uses one fixed archive closure with install scripts disabled, pinned Koffi/platform archives and actual loaded native-binary digests. Synthetic FFI coverage, blocked native cases and unexecuted platforms never substitute for native acceptance.

### Dev Note

None.
