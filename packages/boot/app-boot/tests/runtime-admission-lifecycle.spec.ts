/** Instrumented admission lifecycle tests; doubles make no native storage qualification claim. */
import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createProfileDocumentView, type ProfileDocumentSelection, type ProfileDocumentViewReference } from '../src/profile-document-view.ts'
import type { ManagedRuntimeAdmission, RuntimeAdmissionRequest, RuntimeChildLaunchRequest, RuntimeProfileQualification } from '../src/runtime-admission.ts'
import type { ProfileDocuments } from '../src/profile-documents.ts'

const native = vi.hoisted(() => ({
  stat: vi.fn(), spawn: vi.fn(), worker: vi.fn(), main: true, data: undefined as unknown,
  slots: new Map<symbol, object>(),
}))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), lstatSync: native.stat }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: native.spawn }))
vi.mock('node:worker_threads', () => ({
  Worker: function (entry: string | URL, options?: object) { native.worker(entry, options) },
  get isMainThread() { return native.main },
  get workerData() { return native.data },
}))
vi.mock('../src/runtime-outer-bootstrap.ts', () => ({
  registerRuntimeOuterCapability: (slot: symbol, capability: object) => { native.slots.set(slot, capability) },
  runtimeOuterCapability: (slot: symbol) => native.slots.get(slot),
}))
const home = resolve('runtime-home'), dir = join(home, 'profiles', 'web')
const request: RuntimeAdmissionRequest = { carrier: 'cli', entryUrl: 'file:///installed/bin.js', home, profile: 'web', mode: 'application' }
const profileRequest = { home, profileDir: dir, runtimeDir: resolve('installed') }
function managed() {
  const selection: ProfileDocumentSelection = {
    home, profileDir: dir, codeBinding: brandString<ProfileDocumentSelection['codeBinding']>('code'),
    packageDocuments: brandString<ProfileDocumentSelection['packageDocuments']>('packages'),
  }
  const view = createProfileDocumentView({ selection, reference: brandString<ProfileDocumentViewReference>('view'), documents: [] })
  const current = vi.fn(() => view), failed = vi.fn(), installResolution = vi.fn()
  const documents: ProfileDocuments = {
    selection, domainId: brandString<ProfileDocuments['domainId']>('domain'), current,
    bundleLayers: () => ({ ...selection, layers: [] }), refresh: async () => view, readView: async () => view,
    withWriteSnapshot: async () => { throw new Error('Admission cannot publish documents') },
    inspectOperation: async () => undefined, subscribe: () => () => {},
  }
  const value: ManagedRuntimeAdmission = {
    status: 'managed', bindingId: 'code', request: { ...request }, installAnchor: resolve('installed/package.json'),
    profile: { name: 'web', dir, layers: [], patchPath: join(dir, 'cordis.patch.yml'), patches: [], skippedBundles: [] },
    documents, packages: { resolution: { profilesDir: join(home, 'profiles'), profileDir: dir, entries: [], linkedRoots: [], localPackageNames: [] }, packageOf: () => undefined },
    installResolution, provideServices: vi.fn(), ready: vi.fn(), failed,
  }
  return { value, selection, view, current, failed, installResolution }
}
beforeEach(() => {
  vi.resetModules()
  native.stat.mockReset().mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) })
  native.spawn.mockReset()
  native.worker.mockReset()
  native.slots.clear()
  native.main = true
  native.data = undefined
})
afterEach(() => vi.restoreAllMocks())

describe('carrier admission lifecycle', () => {
  it.each([[null, 'null'], ['denied', 'denied'], [{}, '[object Object]'], [{ code: 'EACCES' }, '[object Object]']])('blocks uncertain discovery %j without native authority', async (error, description) => {
    const admission = await import('../src/runtime-admission.ts')
    native.stat.mockImplementationOnce(() => { throw error })
    expect(admission.inspectUnenrolledRuntime(home)).toEqual({ status: 'blocked', reason: `Runtime enrollment discovery failed: ${description}` })
    expect(native.stat).toHaveBeenCalledWith(join(home, 'runtime-management'))
  })
  it('records positive absence, then refuses a late provider or repeated admission', async () => {
    const admission = await import('../src/runtime-admission.ts')
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
    const absent = await admission.admitRuntimeCarrier(request)
    expect(absent).toEqual({ status: 'unenrolled' })
    expect(Object.isFrozen(absent)).toBe(true)
    expect(admission.currentRuntimeAdmission()).toBe(absent)
    expect(() => { admission.installRuntimeAdmissionProvider({ admit: async () => absent }) }).toThrow('already fixed')
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('already admitted')
  })
  it('closes admission when native provider discovery throws', async () => {
    const admission = await import('../src/runtime-admission.ts'), failure = new Error('native discovery failed')
    admission.installRuntimeAdmissionProvider({ admit: async () => { throw failure } })
    await expect(admission.admitRuntimeCarrier(request)).rejects.toBe(failure)
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('already admitted')
  })
  it('captures the provider receiver and frozen request before await, then publishes only the installed opaque result', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed()
    let finish: ((value: ManagedRuntimeAdmission) => void) | undefined
    const input = { ...request }, requests: RuntimeAdmissionRequest[] = []
    const provider = { identity: 'native', admit(value: RuntimeAdmissionRequest) {
      expect(this.identity).toBe('native'); requests.push(value)
      return new Promise<ManagedRuntimeAdmission>((resolve) => { finish = resolve })
    } }
    admission.installRuntimeAdmissionProvider(provider)
    const pending = admission.admitRuntimeCarrier(input)
    expect(requests).toEqual([request])
    expect(Object.isFrozen(requests[0])).toBe(true)
    input.profile = 'changed'
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
    expect(() => admission.requireManagedRuntimeAdmission(fixture.value)).toThrow('not admitted')
    fixture.installResolution.mockImplementation(() => { expect(admission.currentRuntimeAdmission()).toBeUndefined() })
    finish!(fixture.value)
    const result = await pending
    expect(result).toBe(fixture.value)
    expect(fixture.installResolution).toHaveBeenCalledExactlyOnceWith()
    expect(fixture.failed).not.toHaveBeenCalled()
    expect(Object.isFrozen(result)).toBe(true)
    expect(admission.currentRuntimeAdmission()).toBe(result)
    expect(admission.requireManagedRuntimeAdmission(fixture.value)).toBe(result)
    expect(() => admission.requireManagedRuntimeAdmission({ ...fixture.value })).toThrow('not admitted')
  })
  it.each(['carrier', 'entryUrl', 'home', 'profile', 'mode'] as const)('rejects native invocation mismatch in %s before installing code', async (key) => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed()
    Object.assign(fixture.value.request, { [key]: 'different' })
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('another carrier invocation')
    expect(fixture.installResolution).not.toHaveBeenCalled()
    expect(fixture.failed).toHaveBeenCalledOnce()
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
  })
  it.each(['desktop-cli', 'desktop-host'] as const)('requires admitted physical resources for %s', async (carrier) => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed(), desktop = { ...request, carrier }
    Object.assign(fixture.value, { request: desktop })
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await expect(admission.admitRuntimeCarrier(desktop)).rejects.toThrow('requires admitted physical carrier resources')
    expect(fixture.failed).toHaveBeenCalledOnce()
  })
  it('admits physical Desktop resources without substituting logical document paths', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed(), desktop = { ...request, carrier: 'desktop-host' as const }
    const resources = { runtimeDir: resolve('physical/runtime'), supportDir: resolve('physical/support'), officeSource: resolve('physical/office'), packageManagerPath: resolve('physical/pnpm'), commandPath: resolve('physical/dsh') }
    Object.assign(fixture.value, { request: desktop, carrierResources: resources })
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    const result = await admission.admitRuntimeCarrier(desktop)
    expect(result).toBe(fixture.value)
    expect(fixture.value.carrierResources).toBe(resources)
    expect(fixture.value.documents.selection.home).toBe(home)
  })
  it.each([
    'binding', 'view-code', 'view-packages', 'view-dir', 'selection-dir', 'view-home', 'selection-home', 'profile-name',
  ])('rejects incoherent code/document selection %s', async (mismatch) => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed()
    if (mismatch === 'binding') Object.assign(fixture.value, { bindingId: 'other-code' })
    else if (mismatch === 'selection-dir') Object.assign(fixture.selection, { profileDir: resolve('other-profile') })
    else if (mismatch === 'selection-home') Object.assign(fixture.selection, { home: resolve('other-home') })
    else if (mismatch === 'profile-name') fixture.value.profile.name = 'other-profile'
    else {
      const field = mismatch === 'view-code' ? 'codeBinding' : mismatch === 'view-packages' ? 'packageDocuments' : mismatch === 'view-dir' ? 'profileDir' : 'home'
      const changed = { ...fixture.view.selection }; Object.assign(changed, { [field]: 'different' })
      fixture.current.mockReturnValue({ ...fixture.view, selection: changed })
    }
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('code and document selections differ')
    expect(fixture.installResolution).not.toHaveBeenCalled()
    expect(fixture.failed).toHaveBeenCalledOnce()
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
  })
  it('reports installation failure before publication and does not retry admission', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed(), error = new Error('inventory changed')
    fixture.installResolution.mockImplementation(() => { throw error })
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await expect(admission.admitRuntimeCarrier(request)).rejects.toBe(error)
    expect(fixture.failed).toHaveBeenCalledExactlyOnceWith(error)
    expect(admission.currentRuntimeAdmission()).toBeUndefined()
    expect(() => admission.requireManagedRuntimeAdmission(fixture.value)).toThrow('not admitted')
  })
  it('closes failed managed admission exactly once, preserving original and cleanup errors', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed(), error = new Error('startup failed'), cleanup = new Error('native close failed')
    fixture.failed.mockRejectedValueOnce(cleanup)
    const failure = admission.failRuntimeCarrier(fixture.value, error)
    await expect(failure).rejects.toMatchObject({ errors: [error, cleanup], message: 'Runtime startup and native admission closure failed' })
    await expect(admission.failRuntimeCarrier(fixture.value, error)).rejects.toBe(error)
    expect(fixture.failed).toHaveBeenCalledExactlyOnceWith(error)
    await expect(admission.failRuntimeCarrier(undefined, error)).rejects.toBe(error)
    await expect(admission.failRuntimeCarrier({ status: 'unenrolled' }, error)).rejects.toBe(error)
    const successfulClose = managed()
    await expect(admission.failRuntimeCarrier(successfulClose.value, error)).rejects.toBe(error)
    expect(successfulClose.failed).toHaveBeenCalledExactlyOnceWith(error)
  })
})

describe('Worker payload and launch ownership', () => {
  it('preserves ordinary Worker construction and Node payload', async () => {
    const admission = await import('../src/runtime-admission.ts'), data = { original: true }, entry = new URL('file:///worker.js')
    native.data = data
    const options = { workerData: data, name: 'ordinary' }
    const worker = admission.createRuntimeWorker(entry, options)
    expect(worker).toBeDefined()
    expect(native.worker).toHaveBeenCalledExactlyOnceWith(entry, options)
    expect(admission.runtimeWorkerData()).toBe(data)
    expect(() => { admission.installRuntimeWorkerPayload(data) }).toThrow('main thread')
  })
  it('unwraps even an undefined original payload once inside a Worker', async () => {
    native.main = false
    native.data = { privateEnvelope: true }
    const admission = await import('../src/runtime-admission.ts')
    admission.installRuntimeWorkerPayload(undefined)
    expect(admission.runtimeWorkerData()).toBeUndefined()
    expect(() => { admission.installRuntimeWorkerPayload({ late: true }) }).toThrow('already installed')
  })
  it('requires native Worker authority under a managed admission', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed()
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await admission.admitRuntimeCarrier(request)
    expect(() => admission.createRuntimeWorker('worker.js')).toThrow('no qualified Worker bootstrap')
    expect(native.worker).not.toHaveBeenCalled()
  })
  it('forwards admitted Worker URL, transfers and result unchanged', async () => {
    const admission = await import('../src/runtime-admission.ts'), fixture = managed(), entry = new URL('file:///worker.js')
    const ordinary = admission.createRuntimeWorker(entry), options = { workerData: new ArrayBuffer(4), transferList: [] }
    const spawn = vi.fn(() => ordinary)
    Object.assign(fixture.value, { workers: { spawn } })
    admission.installRuntimeAdmissionProvider({ admit: async () => fixture.value })
    await admission.admitRuntimeCarrier(request)
    expect(admission.createRuntimeWorker(entry, options)).toBe(ordinary)
    expect(spawn).toHaveBeenCalledExactlyOnceWith(entry, options)
    expect(native.worker).toHaveBeenCalledOnce()
  })
})

describe('outer process authorities', () => {
  it('maps only canonical installer locations and refuses a different bundle', async () => {
    const admission = await import('../src/runtime-admission.ts'), bundled = resolve('bundled'), installation = resolve('physical')
    expect(admission.resolveRuntimeInstallation(bundled)).toBe(bundled)
    for (const location of [{ bundled: 'relative', installation }, { bundled, installation: 'relative' }, { bundled: bundled + '/..', installation }]) {
      expect(() => { admission.installRuntimeInstallationLocation(location) }).toThrow('literal absolute path')
    }
    admission.installRuntimeInstallationLocation({ bundled, installation })
    expect(admission.resolveRuntimeInstallation(bundled)).toBe(installation)
    expect(() => admission.resolveRuntimeInstallation(resolve('other'))).toThrow('differs from the fixed packaged binding')
    expect(Object.isFrozen([...native.slots.values()][0])).toBe(true)
  })
  it('preserves ordinary child arguments/options and ignores private messages without an authority', async () => {
    const admission = await import('../src/runtime-admission.ts'), child = new ChildProcess(), options: SpawnOptions = { stdio: 'pipe' }
    const args = ['--flag'], launch: RuntimeChildLaunchRequest = { carrier: 'cli', executable: 'node', args, options }
    native.spawn.mockReturnValue(child)
    expect(admission.spawnRuntimeChild(launch)).toBe(child)
    expect(native.spawn).toHaveBeenCalledExactlyOnceWith('node', args, options)
    expect(native.spawn.mock.calls[0]?.[1]).not.toBe(args)
    for (const message of [null, 42, {}, { type: 2 }, { type: 'ready' }, { type: 'dsh-runtime-ready' }]) expect(admission.consumeRuntimeChildMessage(child, message)).toBe(false)
  })
  it('retains authority receivers and delegates only private coordinator message candidates', async () => {
    const admission = await import('../src/runtime-admission.ts'), child = new ChildProcess(), launch: RuntimeChildLaunchRequest = { carrier: 'desktop-host', executable: 'node', args: [], options: {} }
    const messages: unknown[] = []
    const authority = {
      child,
      spawn(request: RuntimeChildLaunchRequest) { expect(request).toBe(launch); return this.child },
      consumeMessage(value: ChildProcess, message: unknown) { expect(value).toBe(this.child); messages.push(message); return true },
    }
    admission.installRuntimeChildLaunchAuthority(authority)
    authority.spawn = () => { throw new Error('late replacement') }
    expect(admission.spawnRuntimeChild(launch)).toBe(child)
    expect(admission.consumeRuntimeChildMessage(child, { type: 'ready' })).toBe(false)
    const message = { type: 'dsh-runtime-ready' }
    expect(admission.consumeRuntimeChildMessage(child, message)).toBe(true)
    expect(messages).toEqual([message])
    expect(Object.isFrozen([...native.slots.values()][0])).toBe(true)
  })
  it.each([{ status: 'unenrolled' as const }, { status: 'blocked' as const, reason: 'native refusal' }])('preserves %s profile qualification without exposing a mutable result', async (qualification) => {
    const admission = await import('../src/runtime-admission.ts')
    admission.installRuntimeProfileAuthority({ qualify: async () => qualification })
    const result = await admission.qualifyRuntimeProfile(profileRequest)
    expect(result).toEqual(qualification)
    expect(result).not.toBe(qualification)
    expect(Object.isFrozen(result)).toBe(true)
  })
  it('binds profile preparation and recovery to the qualified authority before method replacement', async () => {
    const admission = await import('../src/runtime-admission.ts'), bundles = ['installed-default']
    const operations: string[] = []
    const qualification = {
      status: 'managed' as const, identity: 'qualified',
      async prepare() { operations.push(this.identity) },
      async disableThirdParty(value: readonly string[]) { expect(value).toBe(bundles); operations.push(this.identity); return '/private/backup' },
    }
    const authority = { identity: 'outer', async qualify(value: typeof profileRequest): Promise<RuntimeProfileQualification> {
      expect(this.identity).toBe('outer'); expect(value).toEqual(profileRequest); expect(value).not.toBe(profileRequest); expect(Object.isFrozen(value)).toBe(true)
      return qualification
    } }
    admission.installRuntimeProfileAuthority(authority)
    const result = await admission.qualifyRuntimeProfile(profileRequest)
    expect(result.status).toBe('managed')
    if (result.status !== 'managed') throw new Error('Missing managed qualification')
    qualification.prepare = async () => { throw new Error('late replacement') }
    await result.prepare()
    expect(await result.disableThirdParty(bundles)).toBe('/private/backup')
    expect(operations).toEqual(['qualified', 'qualified'])
    expect(Object.isFrozen(result)).toBe(true)
  })
  it('uses positive absence or a native-provider block when no profile authority exists', async () => {
    const admission = await import('../src/runtime-admission.ts')
    expect(await admission.qualifyRuntimeProfile(profileRequest)).toEqual({ status: 'unenrolled' })
    native.stat.mockReturnValueOnce({})
    expect(await admission.qualifyRuntimeProfile(profileRequest)).toEqual({ status: 'blocked', reason: 'Runtime management exists; the fixed native admission provider is required' })
  })
})
