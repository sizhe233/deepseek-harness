#!/usr/bin/env node
/** Application-free installed command-line entry for dsh. */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { admitCarrierLaunch, prepareCarrierLaunch } from './carrier.ts'
import { failRuntimeCarrier } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import type { RunCliOptions } from './cli-options.ts'

export type { RunCliOptions } from './cli-options.ts'

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns completion of the selected command mode.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const launch = await admitCarrierLaunch(prepareCarrierLaunch({ carrier: 'cli', entryUrl: import.meta.url,
    manageDesktopProfile: options.manageDesktopProfile }))
  try {
    const { runCli: runCommand } = await import('./cli-main.ts')
    await runCommand(launch, options)
  } catch (error) { await failRuntimeCarrier(launch.admission, error) }
}

if (import.meta.main) await runCli()
