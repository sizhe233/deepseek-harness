/** Application-free installed Desktop command carrier. */

import { basename, dirname, join, resolve } from 'node:path'
import { failRuntimeCarrier } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { admitCarrierLaunch, prepareCarrierLaunch } from '@deepseek-ai/dsh/lib/carrier.js'

async function startDesktopCli(runtimeDir: string, supportDir: string, installSignals: boolean): Promise<void> {
  const launch = await admitCarrierLaunch(prepareCarrierLaunch({ carrier: 'desktop-cli', entryUrl: import.meta.url, manageDesktopProfile: true }))
  try {
    const { runDesktopCli: runCommand } = await import('./cli-main.ts')
    await runCommand(launch, runtimeDir, supportDir, installSignals)
  } catch (error) { await failRuntimeCarrier(launch.admission, error) }
}

/**
 * Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing pnpm.
 * @returns completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string, supportDir: string): Promise<void> {
  await startDesktopCli(runtimeDir, supportDir, false)
}

if (import.meta.main) {
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  const parent = dirname(runtimeDir)
  const installationDir = basename(parent) === 'app.asar' ? dirname(parent) : parent
  await startDesktopCli(runtimeDir, join(installationDir, 'runtime'), true)
}
