/** Application-free Desktop Host carrier; startup failures retain Electron's IPC diagnostics. */

import { inspect } from 'node:util'
import { failRuntimeCarrier } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { admitCarrierLaunch, prepareCarrierLaunch } from '@deepseek-ai/dsh/lib/carrier.js'

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  void (async () => {
    const launch = await admitCarrierLaunch(prepareCarrierLaunch({ carrier: 'desktop-host', entryUrl: import.meta.url }))
    try {
      const { runDesktopHost } = await import('./host-main.ts')
      await runDesktopHost(launch)
    } catch (error) { await failRuntimeCarrier(launch.admission, error) }
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
