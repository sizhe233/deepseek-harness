# Support matrix

| Platform package suffix | Builder | Payload |
|---|---|---|
| linux-x64 | ubuntu-24.04 | static Landlock executable; glibc and musl system.node/private-storage.node |
| linux-arm64 | ubuntu-24.04-arm | static Landlock executable; glibc and musl system.node/private-storage.node |
| darwin-x64 | macos-15-intel | system.node and private-storage.node |
| darwin-arm64 | macos-latest | system.node and private-storage.node |
| win32-x64 | windows-2025 | windows-private-owner.node |

The stable Node-API v8 addon is built once per platform/libc and exercised by CI under Node 20, 22, 24, and 26. macOS builds target 11.0 or later. Linux binding selection uses the running Node process's libc; the static launcher serves both libc variants.

Landlock additionally requires an enforcing Linux kernel. The functional probe determines full, partial, or unusable enforcement; kernel version alone is not an availability guarantee.

Windows has neither a Landlock launcher nor the POSIX addons. The separate Windows resource owner uses its own native Node-API8 payload; existing flock consumers retain their Windows semaphore implementation. Other CPU/OS combinations have no published platform package: Landlock probes unusable, and flock acquisition rejects. New platform support requires a native builder and installed-artifact verification.

Matrix metadata declares required payloads; it does not certify that successor binaries have been built or accepted. The retained-storage [review handoff](private-storage-review.md) lists executed and outstanding native rows.
