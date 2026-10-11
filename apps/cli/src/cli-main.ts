/** Business command dispatch, loaded only after the installed carrier resolves its invocation. */

import { loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import type { CliCarrierLaunch } from './carrier.ts'
import type { RunCliOptions } from './cli-options.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'

/**
 * Run the already parsed command selected by an installed carrier.
 * @param launch - Application-free descriptor prepared by the carrier.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @param applicationEntry - Fixed business-entry URL supplied by a packaged carrier.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(
  launch: CliCarrierLaunch, options: RunCliOptions = {}, applicationEntry = import.meta.url,
): Promise<void> {
  const { invocation, runtimeVersion: version, home } = launch
  const profileOptions = { packageManager: options.packageManager }

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          applicationEntry,
          ...(launch.admission === undefined ? {} : { admission: launch.admission }),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home, version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}
