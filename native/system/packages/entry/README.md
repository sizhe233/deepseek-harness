---
description: "JavaScript entry for the prebuilt Landlock launcher and asynchronous POSIX flock."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` entry exports `tryLockExclusive(fd): Promise<void>`; importing either entry does not load `system.node`. The package has no root export.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

Optional OS/CPU platform packages carry the binaries. Their `~x.y.z` dependency ranges allow later patches within the same minor version. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS has `bin/system.node`. Missing or unloadable flock bindings reject acquisition, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

The declared native C sources ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).

The separate `./private-storage` entry exports `loadPosixStoragePrimitives()` and opaque directory/file types. Import is lazy; the explicit loader requires the new platform-specific `private-storage.node` and never substitutes `system.node`. Source admission, private policy, environment-owned descriptor release and unfinished native acceptance are described in the [review handoff](../../docs/private-storage-review.md). No raw descriptor is accepted or returned by that capability.

The additive `./windows-private-owner` entry exports `loadWindowsPrivateOwner()` and `inspectWindowsPrivateOwnerRuntime()`. Its Windows x64 successor payload owns all native file/token/security/I/O resources before JavaScript exposure, including Worker environment cleanup. Returned files are opaque capabilities with no HANDLE accessor. Import alone does not load a binary. Runtime identity observations do not establish native acceptance; missing or mismatched successor bytes refuse.
