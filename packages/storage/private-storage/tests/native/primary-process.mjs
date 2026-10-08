/** Primary-matrix adapter for the reviewed bounded native child protocol. */
import { startChild } from './boundary-support.mjs'

/** Preserve primary fixtures' close-line protocol and sticky uncertainty without unbounded close waits. */
export function startPrimaryProcess(command, args, env, { onUncertain = () => {}, closeTimeoutMs = 30_000 } = {}) {
  const controller = startChild(command, args, env, { closeTimeoutMs })
  async function teardown(operation) {
    try { return await operation() }
    catch (error) { if (!controller.settled) onUncertain(); throw error }
  }
  return {
    child: controller.child,
    exited: controller.exited,
    processExit: controller.processExit,
    get settled() { return controller.settled },
    next(timeoutMs = 30_000) { return controller.next(timeoutMs) },
    close() {
      return teardown(async () => {
        const child = controller.child
        if (!child.stdin.destroyed && !child.stdin.writableEnded && child.exitCode === null && child.signalCode === null) child.stdin.end('close\n')
        await controller.complete()
      })
    },
    kill() { return teardown(() => controller.kill()) },
  }
}
