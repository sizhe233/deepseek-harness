/** Desktop command dependencies, loaded after its application-free carrier descriptor. */

import { delimiter, join } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/cli-main.js'
import type { CliCarrierLaunch } from '@deepseek-ai/dsh/lib/carrier.js'
import { installOfficeEngineResolution } from './office-engine.ts'

/**
 * Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
 * @param launch - Command parsed once by the Desktop carrier.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing pnpm.
 * @param installSignals - Install native console signals for the executable entry.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(
  launch: CliCarrierLaunch, runtimeDir: string, supportDir: string, installSignals: boolean,
): Promise<void> {
  const resources = launch.admission?.status === 'managed' ? launch.admission.carrierResources : undefined
  if (installSignals && process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  if (launch.admission?.status !== 'managed') installOfficeEngineResolution(runtimeDir)
  await runCli(launch, {
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', resources?.packageManagerPath ?? join(supportDir, 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${resources?.commandPath ?? join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  }, import.meta.url)
}
