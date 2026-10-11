import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const loader = vi.hoisted(() => ({
  version: '3.1.1', manifest: '{"version":"3.1.1"}' as string,
  ownerCalls: 0, missing: false, native: {} as object, mismatch: '', required: [] as string[], cache: {} as Record<string, object>, loads: [] as string[],
}))
vi.mock('@deepseek-ai/node-addon-system/windows-private-owner', () => ({
  loadWindowsPrivateOwner: () => { loader.ownerCalls++; return {} },
  inspectWindowsPrivateOwnerRuntime: () => ({ platform: 'win32', architecture: 'x64', nodeApi: 8,
    entry: { name: '@deepseek-ai/node-addon-system', version: '0.1.3', file: 'lib/windows-private-owner.js', sha256: 'a'.repeat(64) },
    platformPackage: { name: '@deepseek-ai/node-addon-system-win32-x64', version: '0.1.3', binary: 'bin/windows-private-owner.node', sha256: 'b'.repeat(64), bytes: 123 },
  }),
}))
vi.mock('node:fs', () => ({
  realpathSync: (path: string) => { if (loader.missing && path.endsWith('.node')) throw new Error('missing prebuild'); if (loader.mismatch === 'missing-layout' && path.endsWith('/static.cjs')) throw new Error('missing pinned layout'); return path },
  readFileSync: (path: string) => path.endsWith('package.json') ? loader.manifest : Buffer.from('synthetic native binary'),
}))
vi.mock('node:module', () => ({ createRequire: (parent: string) => {
  const require = Object.assign((specifier: string) => {
    loader.required.push(specifier)
    if (specifier.endsWith('.node')) {
      if (loader.mismatch === 'binary-error') throw new Error('wrong native architecture')
      return loader.native
    }
    if (specifier === '@koromix/koffi-win32-x64') {
      if (loader.mismatch === 'platform-error') throw new Error('corrupt platform wrapper')
      return loader.mismatch === 'platform-export' ? {} : loader.native
    }
    return { version: loader.version, default: loader.mismatch === 'cached-native' ? {} : loader.native, load: (name: string) => {
      loader.loads.push(name)
      return { func: () => () => 0 }
    } }
  }, { resolve: (name: string) => name === 'koffi' ? '/synthetic/koffi/index.cjs' : parent.endsWith('/static.cjs') && loader.mismatch.startsWith('shadow-') ? '/synthetic/shadow/index.js' : '/synthetic/platform/index.js', cache: loader.cache })
  return require
} }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!
beforeEach(() => {
  vi.resetModules()
  loader.ownerCalls = 0; loader.version = '3.1.1'; loader.manifest = '{"version":"3.1.1"}'; loader.missing = false; loader.loads = []; loader.required = []; loader.mismatch = ''
  loader.cache = { '/other/native.node': {}, '/ordinary/module.js': {}, '/synthetic/platform/win32_x64/koffi.node': {} }
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture) })

describe('pinned prebuilt native dependency selection', () => {
  it('loads once, keeps DLLs lazy until backend use and records the actual cached binary digest', async () => {
    const { loadNativeStorage } = await import('../src/native.ts')
    expect(loader.loads).toEqual([])
    const api = loadNativeStorage()
    expect(api.artifact).toEqual({ koffiVersion: '3.1.1', platformPackage: '@koromix/koffi-win32-x64', nativeBinarySha256: createHash('sha256').update('synthetic native binary').digest('hex') })
    expect(loadNativeStorage()).toBe(api)
    expect(loader.loads).toEqual([])
    expect(loader.ownerCalls).toBe(1)
    expect(api.ownershipArtifact?.platformPackage.binary).toBe('bin/windows-private-owner.node')
  })
  it.each(['linux', 'arm64'])('rejects unsupported platform or architecture %s before native loading', async (unsupported) => {
    Object.defineProperty(process, unsupported === 'linux' ? 'platform' : 'arch', { value: unsupported, configurable: true })
    const { loadNativeStorage } = await import('../src/native.ts')
    expect(() => loadNativeStorage()).toThrow(/Windows x64/u)
    expect(loader.loads).toEqual([])
  })
  it.each(['null', '5', '{}', '{"version":"other"}', 'invalid json'])('rejects incomplete or incorrect platform metadata %s', async (manifest) => {
    loader.manifest = manifest
    const { loadNativeStorage } = await import('../src/native.ts')
    expect(() => loadNativeStorage()).toThrow(/unavailable/u)
    expect(loader.loads).toEqual([])
  })
  it.each(['missing', 'wrong-version', 'wrong-binary'])('fails closed for %s without compilation or fallback', async (fault) => {
    if (fault === 'missing') loader.missing = true
    if (fault === 'wrong-version') loader.version = '3.1.0'
    if (fault === 'wrong-binary') loader.cache = { '/unapproved/build/koffi.node': {} }
    const { loadNativeStorage } = await import('../src/native.ts')
    expect(() => loadNativeStorage()).toThrow(/unavailable/u)
    expect(loader.loads).toEqual([])
  })
})


it.each(['binary-error', 'platform-error', 'platform-export', 'cached-native'])('rejects %s without allowing Koffi fallback selection', async (fault) => {
  loader.mismatch = fault
  const { loadNativeStorage } = await import('../src/native.ts')
  expect(() => loadNativeStorage()).toThrow(/unavailable/u)
  expect(loader.loads).toEqual([])
  if (fault !== 'cached-native') expect(loader.required).not.toContain('koffi')
})


it.each(['missing-layout', 'shadow-object', 'shadow-throw'])('rejects %s before any native or wrapper execution', async (fault) => {
  loader.mismatch = fault
  const { loadNativeStorage } = await import('../src/native.ts')
  expect(() => loadNativeStorage()).toThrow(/unavailable/u)
  expect(loader.required).toEqual([])
  expect(loader.loads).toEqual([])
})
