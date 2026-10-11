/** Managed CLI commands reuse opaque carrier admission and leave logical Profile files untouched. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ProfilePackageOperations } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { documentProviderFixture } from '../../../packages/boot/app-boot/tests/document-provider-fixture.ts'

vi.mock('../src/profile-boot.ts', () => ({ INSTALL_ANCHOR: '/installation/package.json' }))

async function fixture() {
  vi.resetModules()
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const native = await import('@deepseek-ai/dsh-app-boot/runtime-admission')
  const { runPlugin } = await import('../src/plugin.ts')
  const home = mkdtempSync(join(tmpdir(), 'cli-managed-package-'))
  vi.stubEnv('DSH_HOME', home)
  const dir = join(home, 'profiles', 'test'), anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"fixture-installation"}')
  boot.initProfile(dir, [])
  const profile = boot.loadProfileDirectory('test', dir, anchor)
  const context: ProfileContext = { name: 'test', dir, home, cwd: home, installAnchor: anchor,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const provider = documentProviderFixture(context, [], { [join(dir, 'package.json')]: readFileSync(join(dir, 'package.json'), 'utf8') })
  const request = { carrier: 'cli' as const, entryUrl: 'file:///installed/bin.js', home, profile: 'test', mode: 'package' as const }
  let packageOperations: ProfilePackageOperations | undefined
  let disposed = 0
  native.installRuntimeAdmissionProvider({ async admit() {
    return { status: 'managed', bindingId: provider.documents.selection.codeBinding, request, profile, installAnchor: anchor,
      documents: provider.documents, packages: { resolution: { profilesDir: join(home, 'profiles'), profileDir: dir,
        localPackageNames: [], entries: [], linkedRoots: [] }, packageOf: () => undefined },
      installResolution() {},
      provideServices(ctx) {
        if (packageOperations !== undefined) ctx.provide('profilePackageOperations', packageOperations)
        ctx.effect(() => () => { disposed++ }, 'test CLI service lifetime')
      }, ready: async () => {}, failed: async () => {},
    }
  } })
  await native.admitRuntimeCarrier(request)
  writeFileSync(join(dir, 'package.json'), 'poisoned original package\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), 'poisoned original patch\n')
  writeFileSync(join(dir, 'compatibility.json'), 'poisoned original compatibility\n')
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  onTestFinished(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
    rmSync(home, { recursive: true, force: true })
  })
  return { runPlugin, home, dir, stdout, stderr, provider, version: boot.getDshRuntimeVersion(),
    bind(value: ProfilePackageOperations) { packageOperations = value }, get disposed() { return disposed } }
}

it('managed version commands preserve consent and original files without package locks or service startup', async () => {
  const f = await fixture()
  const args = ['allow-version', 'example@1.2.3', '--dsh-version', f.version]
  expect(await f.runPlugin('test', args)).toBe(1)
  expect(f.provider.receipts.size).toBe(0)
  expect(await f.runPlugin('test', [...args, '--accept-risk'])).toBe(0)
  expect(f.provider.receipts.size).toBe(1)
  expect(await f.runPlugin('test', ['version-exemptions'])).toBe(0)
  expect(f.stdout).toHaveBeenLastCalledWith(JSON.stringify({ 'example@1.2.3': [f.version] }, undefined, 2) + '\n')
  expect(await f.runPlugin('test', ['revoke-version', 'example@1.2.3', '--dsh-version', f.version])).toBe(0)
  expect(readFileSync(join(f.dir, 'compatibility.json'), 'utf8')).toBe('poisoned original compatibility\n')
  expect(existsSync(join(f.dir, 'package.json.lock'))).toBe(false)
  expect(f.disposed).toBe(0)
})

it('managed CLI forwards raw pnpm arguments and inherited execution policy through the fixed provider', async () => {
  const f = await fixture()
  const argv = ['add', 'first@1', 'second@2', '--ignore-scripts', '--registry=https://private.example/']
  const invocation = { command: process.execPath, args: ['/installed/pnpm.cjs'], env: { DSH_PACKAGE_CONTEXT: 'test' } }
  f.bind({ selection: f.provider.documents.selection, async run(request, policy) {
    expect(request).toMatchObject({ kind: 'command', args: argv, expected: f.provider.documents.current().reference })
    expect(request.operationId).toMatch(/^[a-f0-9]{64}$/)
    expect(policy).toMatchObject({ ...invocation, execution: 'cli', outputBytes: 16384, lockWaitMs: 120000,
      lookupTimeoutMs: 120000, registries: { registry: null, fallbackRegistries: [], resolved: null } })
    expect(policy.idleTimeoutMs).toBeUndefined()
    policy.onOutput?.('native package output', 'stdout')
    return { operationId: request.operationId, changed: true, application: 'restart-required', stage: 'install', target: 'first',
      warnings: ['retained package warning'], packageResult: { exitCode: 0, output: '', truncated: false, logPath: '/native/log' } }
  }, inspectOperation: async () => undefined })
  expect(await f.runPlugin('test', argv, invocation)).toBe(0)
  expect(f.stdout).toHaveBeenCalledWith('native package output')
  expect(f.stderr).toHaveBeenCalledWith('dsh: warning: retained package warning\n')
  expect(f.disposed).toBe(1)
  expect(readFileSync(join(f.dir, 'package.json'), 'utf8')).toBe('poisoned original package\n')
})

it('managed CLI refuses missing or mismatched providers and never initializes another Profile', async () => {
  const f = await fixture()
  expect(await f.runPlugin('test', ['install'])).toBe(1)
  const run = vi.fn()
  f.bind({ selection: { ...f.provider.documents.selection, profileDir: '/another/profile' }, run, inspectOperation: async () => undefined })
  expect(await f.runPlugin('test', ['install'])).toBe(1)
  expect(await f.runPlugin('other', ['install'])).toBe(1)
  expect(run).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'profiles', 'other'))).toBe(false)
  expect(existsSync(join(f.dir, 'package.json.lock'))).toBe(false)
  expect(f.disposed).toBe(2)
})

it.each([0, 9, undefined])('managed CLI rejects failed publication despite package exit %s and reports the operation', async (exitCode) => {
  const f = await fixture()
  f.bind({ selection: f.provider.documents.selection, async run(request) {
    return { operationId: request.operationId, changed: true, application: 'failed', stage: 'install', target: 'example',
      error: { code: 'operation-error', diagnostic: 'native publication unconfirmed' },
      ...exitCode === undefined ? {} : { packageResult: { exitCode, output: '', truncated: false, logPath: '/native/log' } } }
  }, inspectOperation: async () => undefined })
  expect(await f.runPlugin('test', ['install'])).toBe(exitCode || 1)
  expect(f.stderr.mock.calls.map(call => call[0]).join('')).toMatch(/native publication unconfirmed; operation [a-f0-9]{64}/)
  expect(f.disposed).toBe(1)
})

it('managed CLI refuses a mismatched operation receipt', async () => {
  const f = await fixture()
  f.bind({ selection: f.provider.documents.selection, async run() {
    return { changed: false, application: 'applied', stage: 'install', target: 'example' }
  }, inspectOperation: async () => undefined })
  expect(await f.runPlugin('test', ['list'])).toBe(1)
  expect(f.stderr.mock.calls.map(call => call[0]).join('')).toContain('receipt does not match operation')
  expect(f.disposed).toBe(1)
})
