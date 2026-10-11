/** Desktop Host preserves transport selection and reports readiness after managed admission. */
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ManagedRuntimeAdmission } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import type { DesktopHostLaunch } from '@deepseek-ai/dsh/lib/carrier.js'
import { runDesktopHost } from '../src/host-main.ts'

const boot = vi.hoisted(() => ({
  runProfile: vi.fn(), loadLayeredEnv: vi.fn(), loadProfileDirectory: vi.fn(), reportSkippedBundles: vi.fn(),
  installOfficeEngineResolution: vi.fn(), installPlatformSessionPublisher: vi.fn(),
}))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadLayeredEnv: boot.loadLayeredEnv, loadProfileDirectory: boot.loadProfileDirectory,
  reportSkippedBundles: boot.reportSkippedBundles,
}))
vi.mock('@deepseek-ai/dsh/profile-boot', () => ({ runProfile: boot.runProfile }))
vi.mock('../src/office.ts', () => ({ name: 'desktop-office', apply: vi.fn() }))
vi.mock('../src/office-engine.ts', () => ({ installOfficeEngineResolution: boot.installOfficeEngineResolution }))
vi.mock('../src/update-tasks.ts', () => ({ installDesktopUpdateTaskControl: () => async () => false }))
vi.mock('../src/quit-inspection.ts', () => ({ installDesktopQuitInspection: () => async () => ({ activeTasks: false, scheduledTasks: false }) }))
vi.mock('../src/platform-session.ts', () => ({ installPlatformSessionPublisher: boot.installPlatformSessionPublisher }))

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

function fixture(protocol: 'http:' | 'https:') {
  const messages: unknown[] = []
  const send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    messages.push(message)
    callback?.(null)
    return true
  })
  const descriptors = Object.fromEntries(['connected', 'send'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  const listeners = { message: process.listeners('message'), disconnect: process.listeners('disconnect') }
  onTestFinished(() => {
    for (const listener of process.listeners('message')) {
      if (!listeners.message.includes(listener)) process.removeListener('message', listener)
    }
    for (const listener of process.listeners('disconnect')) {
      if (!listeners.disconnect.includes(listener)) process.removeListener('disconnect', listener)
    }
    for (const key of ['connected', 'send'] as const) {
      const descriptor = descriptors[key]
      if (descriptor === undefined) Reflect.deleteProperty(process, key)
      else Object.defineProperty(process, key, descriptor)
    }
  })
  Object.defineProperty(process, 'connected', { configurable: true, value: true })
  Object.defineProperty(process, 'send', { configurable: true, value: send })
  const ctx = {
    plugin: vi.fn(async () => {}),
    connection: { authenticatedUrl: vi.fn((url: string) => `${url}/?token=fixture`) },
    webServer: { protocol, port: 3080, collectIndexInjections: vi.fn(() => ({ fixture: 'injection' })) },
  }
  boot.runProfile.mockResolvedValue({ ctx, shutdown: { shutdown: vi.fn(async () => {}) } })
  const launch: DesktopHostLaunch = {
    carrier: 'desktop-host', entryUrl: 'file:///carrier/index.js', runtimeVersion: '1.0.0',
    home: '/fixture-home', profile: 'desktop', runtimeDir: '/runtime', projectDir: '/profile',
    officeSource: '/office', packageManagerPath: '/pnpm.mjs', commandPath: '/command-bin',
    admission: { status: 'unenrolled' },
  }
  return { ctx, launch, messages }
}

function managedAdmission(launch: DesktopHostLaunch): ManagedRuntimeAdmission {
  const selection: ManagedRuntimeAdmission['documents']['selection'] = {
    home: launch.home, profileDir: launch.projectDir,
    codeBinding: brandString<ManagedRuntimeAdmission['documents']['selection']['codeBinding']>('fixture-code'),
    packageDocuments: brandString<ManagedRuntimeAdmission['documents']['selection']['packageDocuments']>('fixture-packages'),
  }
  return {
    status: 'managed', bindingId: selection.codeBinding,
    request: { carrier: launch.carrier, entryUrl: launch.entryUrl, home: launch.home, profile: launch.profile, mode: 'application' },
    profile: { name: 'desktop', dir: launch.projectDir, patchPath: '/profile/cordis.patch.yml', patches: [], layers: [], skippedBundles: [] },
    installAnchor: '/admitted/package.json',
    carrierResources: { runtimeDir: '/admitted/runtime', supportDir: '/admitted/support', officeSource: '/admitted/office',
      packageManagerPath: '/admitted/pnpm.mjs', commandPath: '/admitted/bin' },
    documents: {
      selection, domainId: brandString<ManagedRuntimeAdmission['documents']['domainId']>('fixture-documents'),
      current() { throw new Error('The Host must forward the already admitted profile') },
      async refresh() { throw new Error('The Host must forward the already admitted profile') },
      async readView() { throw new Error('The Host must forward the already admitted profile') },
      bundleLayers() { throw new Error('The Host must forward the already admitted profile') },
      async withWriteSnapshot() { throw new Error('The Host must not publish profile documents') },
      inspectOperation: async () => undefined, subscribe: () => () => {},
    },
    packages: { resolution: { profilesDir: '/profiles', profileDir: launch.projectDir, localPackageNames: [], entries: [], linkedRoots: [] },
      packageOf: () => undefined },
    installResolution() {}, provideServices() {}, ready: vi.fn(async () => {}), failed: vi.fn(),
  }
}

it.each(['http:', 'https:'] as const)('binds loopback and publishes the configured %s URL', async (protocol) => {
  const { ctx, launch, messages } = fixture(protocol)
  const profile = { name: 'desktop', dir: launch.projectDir }
  boot.loadProfileDirectory.mockReturnValue(profile)
  await runDesktopHost(launch)
  expect(boot.runProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    resolvedProfile: { profile, installAnchor: join(launch.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') },
  }))
  expect(boot.installOfficeEngineResolution).toHaveBeenCalledExactlyOnceWith(launch.runtimeDir)
  expect(ctx.connection.authenticatedUrl).toHaveBeenCalledExactlyOnceWith(`${protocol}//127.0.0.1:3080`)
  expect(messages).toEqual([{ type: 'ready', url: `${protocol}//127.0.0.1:3080/?token=fixture`, injections: { fixture: 'injection' } }])
})

it('uses admitted Desktop resources and waits for managed readiness before publishing the URL', async () => {
  vi.stubEnv('PATH', 'original-path')
  const { ctx, launch, messages } = fixture('https:')
  const admission = managedAdmission(launch)
  const admitted = Promise.withResolvers<undefined>()
  const reached = Promise.withResolvers<undefined>()
  const ready = vi.fn(() => { reached.resolve(undefined); return admitted.promise })
  admission.ready = ready
  const starting = runDesktopHost({ ...launch, admission })
  try {
    await reached.promise
    expect(messages).toEqual([])
    expect(boot.loadProfileDirectory).not.toHaveBeenCalled()
    expect(boot.installOfficeEngineResolution).not.toHaveBeenCalled()
    expect(boot.runProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      admission, deferAdmissionReady: true,
      resolvedProfile: { profile: admission.profile, installAnchor: admission.installAnchor },
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
      packageManager: {
        command: process.execPath, args: ['--expose-internals', '/admitted/pnpm.mjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `/admitted/bin${delimiter}original-path` },
      },
    }))
    expect(ctx.plugin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'desktop-office' }), {
      runtimeDir: '/admitted/runtime', source: '/admitted/office', root: join(launch.home, 'dsh-runtimes', 'dsh-primary-runtime'),
    })
    admitted.resolve(undefined)
    await starting
    expect(ready).toHaveBeenCalledExactlyOnceWith({ carrier: 'desktop-host', applicationEntry: new URL('../src/host-main.ts', import.meta.url).href })
    expect(messages).toEqual([{ type: 'ready', url: 'https://127.0.0.1:3080/?token=fixture', injections: { fixture: 'injection' } }])
  } finally { admitted.resolve(undefined); await starting }
})
