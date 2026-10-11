/** The installed CLI uses the shared pnpm distribution after fixed-carrier admission. */

import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli } from '@deepseek-ai/dsh/lib/cli-main.js'
import { admitCarrierLaunch, prepareCarrierLaunch, type CliCarrierLaunch } from '@deepseek-ai/dsh/lib/carrier.js'
import { runDesktopCli } from '../../desktop-host/src/cli.ts'
import { installOfficeEngineResolution } from '../../desktop-host/src/office-engine.ts'

vi.mock('@deepseek-ai/dsh/lib/cli-main.js', () => ({ runCli: vi.fn() }))
const carrier = vi.hoisted(() => ({ prepareCarrierLaunch: vi.fn(), admitCarrierLaunch: vi.fn() }))
vi.mock('@deepseek-ai/dsh/lib/carrier.js', () => carrier)
vi.mock('../../desktop-host/src/office-engine.ts', () => ({ installOfficeEngineResolution: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['system-bin', undefined])('dispatches with bundled pnpm when PATH is %s', async (path) => {
  vi.stubEnv('PATH', path)
  const runtime = join('Application 中文 with spaces', 'resources', 'app.asar', 'dsh')
  const support = join('Application 中文 with spaces', 'resources', 'runtime')
  const launch: CliCarrierLaunch = {
    carrier: 'desktop-cli', entryUrl: new URL('../../desktop-host/src/cli.ts', import.meta.url).href,
    home: '/fixture-home', runtimeVersion: '1.0.0',
    invocation: { mode: 'profile', profile: 'desktop', patches: [], args: [] },
    admission: { status: 'unenrolled' },
  }
  carrier.prepareCarrierLaunch.mockReturnValue(launch)
  carrier.admitCarrierLaunch.mockResolvedValue(launch)

  await runDesktopCli(runtime, support)

  expect(prepareCarrierLaunch).toHaveBeenCalledExactlyOnceWith({
    carrier: 'desktop-cli', entryUrl: launch.entryUrl, manageDesktopProfile: true,
  })
  expect(admitCarrierLaunch).toHaveBeenCalledExactlyOnceWith(launch)
  expect(installOfficeEngineResolution).toHaveBeenCalledExactlyOnceWith(runtime)
  expect(runCli).toHaveBeenCalledExactlyOnceWith(launch, {
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(support, 'bin')}${delimiter}${path ?? ''}`,
      },
    },
  }, new URL('../../desktop-host/src/cli-main.ts', import.meta.url).href)
})
