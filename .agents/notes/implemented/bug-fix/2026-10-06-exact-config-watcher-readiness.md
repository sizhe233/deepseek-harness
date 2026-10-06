# Agent Note: Exact config watchers preserve native readiness outside macOS

Status: implemented

English | [中文](2026-10-06-exact-config-watcher-readiness.zh.md)

## Problem

The fork forces every exact config watch into polling to retain macOS rapid-replacement behavior. On Linux, config creation immediately after registration can be lost, including creation below a missing parent. Chokidar installs its `fs.watchFile` poller after scanning the parent and emits `ready` without awaiting Node’s asynchronous initial polling baseline. The [user-patch delivery decision](../testing/2026-09-09-user-patch-hmr-test-delivery.md) records this limitation. Waiting longer after a missed event cannot recover it.

The disposal test also waits a fixed 250 ms before closing the watcher. That interval does not establish whether a second filesystem event reached HMR while the first refresh was blocked.

## Decision

Exact config watches force polling only on macOS. Other platforms use native watching unless the caller explicitly requests polling. The retained missing-parent depth and 50 ms polling interval preserve the macOS workaround; the ordinary module watcher is unchanged. Polling readiness remains limited to Chokidar’s initial scan, rather than promising completion of Node’s polling baseline.

The [HMR config tests](../../../../packages/boot/app-boot/tests/hmr-config.spec.ts) retain real filesystem watchers and add explicit backend-selection assertions. The disposal case waits for the exact watcher’s `change` listener registered after HMR’s listener, proving the second refresh has been queued before disposal. Context cleanup runs before temporary-root removal, including when setup fails.

## Alternatives considered

**Keep forced polling on every platform.** Rejected because the workaround introduces the polling-startup gap on platforms whose native watcher is already attached when Chokidar publishes readiness.

**Remove polling everywhere.** Rejected because that retires the fork’s macOS rapid-replacement workaround without macOS behavior evidence.

**Increase settling sleeps or repeat writes.** Rejected because elapsed time does not acknowledge watcher startup or queued refreshes, and repeated writes obscure a missed single edit.

**Mock native delivery in the HMR config suite.** Rejected because this suite owns real filesystem delivery; the separate user-patch transaction tests already control delivery while keeping HMR and Include real.

## Consequences

Linux config creation and disposal assertions depend on observable native readiness and event delivery. Negative controls reject unconditional polling and a dropped queued refresh. Independent concurrent processes exercise per-test directory and watcher ownership. Linux validation does not establish macOS or Windows delivery guarantees; their existing behavior remains subject to those platform lanes. No Session, model output, dependency version, or public API changes.
