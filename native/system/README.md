---
description: "Prebuilt system primitives for Linux confinement and POSIX Session write locks."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

## Summary

Use the Linux `landlock-run` executable to confine subprocesses, or the `./flock` entry to acquire a POSIX write lock. Platform packages contain the precompiled binaries; consumer installation never builds native code. Landlock policy and Session lifecycle remain with callers.

## Table of Contents

- [Use](#use)
- [Support](#support)
- [Development](#development)

## Use

`@deepseek-ai/node-addon-system/landlock-run` exports `launcherPath`, `probe`, and `grantArgs` for Landlock. Its executable name, flags, and failure semantics are defined by the [CLI contract](docs/cli-contract.md).

The [flock behavior contract](docs/flock-contract.md) maps descriptor, process, and advisory-lock semantics to independent native tests.

`@deepseek-ai/node-addon-system/flock` exports `tryLockExclusive(fd): Promise<void>`. Keep the descriptor open until completion. Acquisition uses nonblocking exclusive flock; contention rejects with `EAGAIN` or `EWOULDBLOCK`, and closing the final descriptor for the open file description releases the lock. See the [entry README](packages/entry/README.md).

The independent `./private-storage` entry lazily loads `private-storage.node` for retained no-follow source and private-destination primitives. It does not extend flock descriptor ownership or Landlock policy. Its [review handoff](docs/private-storage-review.md) records the supported scope and unfinished native acceptance.

Importing any entry does not load an addon. A missing Landlock executable probes unusable; a missing flock binding rejects acquisition. Neither path compiles or silently grants unsupported behavior.

## Support

Linux x64/arm64 packages contain the static Landlock executable and separate glibc/musl `system.node` and `private-storage.node` files. macOS x64/arm64 packages contain both addons. Landlock additionally needs an enforcing Linux kernel; Windows uses the Harness's existing locking implementation. The [support matrix](docs/support-matrix.md) names builders and verification owners.

## Development

From this directory, `pnpm build:ts` builds the entry, `pnpm build:native` builds the host's declared native payload, and `pnpm build:test-oracle` builds an independent flock syscall fixture. Then `pnpm test` exercises entry, lock, packaging, and available kernel behavior. Linux requires musl-gcc for a complete build; macOS uses cc. The root `pnpm run build:native-system` builds only the current host addon for source tests.

The [architecture](docs/architecture.md), [packaging](docs/packaging.md), and [release procedure](docs/release.md) own implementation and publication details.

### Dev Note

None.


## Windows resource owner (0.1.3 successor)

`@deepseek-ai/node-addon-system/windows-private-owner` lazily loads the exact Windows x64 Node-API8 package. It exposes opaque environment-owned capabilities, never HANDLEs or pointers. Missing successor binaries fail; there is no install-time compiler or fallback to 0.1.2. The old Landlock/flock subpaths retain their behavior. Native Windows compilation and Worker lifetime acceptance remain required; source/format checks are not those results.

Windows builders prepare the current official Node headers and `node.lib` with `node scripts/prepare-windows-node-sdk.mjs`, verifying both against the same release’s official SHA256 list, then invoke `pnpm build:native --node-sdk <verified-directory>` from an x64 Windows SDK compiler environment. The optional build-only `NATIVE_SYSTEM_NODE_SDK` supplies the same directory. No runtime binary selection uses it.

SDK downloads require official HTTPS without redirects and complete within 120 seconds per file. Responses must be nonempty and remain within streamed byte limits (1 MiB for checksums, 32 MiB per artifact); a supplied `Content-Length` must be valid and match the received bytes. Lengthless responses use the same limits and artifact checksum checks.
