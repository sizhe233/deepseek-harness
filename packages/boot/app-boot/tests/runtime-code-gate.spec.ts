/** Instrumented callback regressions complement the real Node call-kind fixtures. */
import { createHash } from 'node:crypto'
import Module, { type LoadHookContext, type LoadHookSync, type ResolveHookContext, type ResolveHookSync } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RuntimeCodeFile, RuntimeCodeGateBinding } from '../src/runtime-code-gate.ts'

const hooks = vi.hoisted(() => ({
  register: vi.fn(),
  resolve: vi.fn<NativeModule['_resolveFilename']>(),
  paths: vi.fn((directory: string) => [directory]),
}))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof Module; isBuiltin: typeof import('node:module').isBuiltin }>()
  class IsolatedModule extends actual.default {
    static _cache: Record<string, Module | undefined> = {}
    static _resolveFilename = hooks.resolve
    static _nodeModulePaths = hooks.paths
  }
  return { isBuiltin: actual.isBuiltin, default: IsolatedModule, registerHooks: hooks.register }
})
interface NativeModule {
  _cache: Record<string, Module | undefined>
  _resolveFilename(request: string, parent?: Module, isMain?: boolean, options?: { paths?: string[]; [key: string]: unknown }): string
}
const cjs = Module as typeof Module & NativeModule
const originalArgv = process.execArgv
const root = resolve('runtime-inventory')
const logical = join(root, 'logical'), physical = join(root, 'generation'), bootstrap = join(root, 'bootstrap')
const entry = join(physical, 'entry.cjs'), original = join(logical, 'entry.cjs'), packagePath = join(physical, 'package.json')
const url = (path: string): string => pathToFileURL(path).href
const file = (path: string, source = 'module.exports = 42'): RuntimeCodeFile => ({
  path, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'),
})
function binding(): RuntimeCodeGateBinding & { bytes: Map<string, Uint8Array>; read: Mock<(row: RuntimeCodeFile) => Uint8Array> } {
  const bytes = new Map([[entry, Buffer.from('module.exports = 42')], [packagePath, Buffer.from('{}')]])
  const read = vi.fn((row: RuntimeCodeFile): Uint8Array => {
    const value = bytes.get(row.path)
    if (value === undefined) throw new Error(`Missing retained source: ${row.path}`)
    return value
  })
  return { roots: [physical, bootstrap], aliases: [{ logical, physical }], files: [file(entry), file(packagePath, '{}')], source: { read }, bytes, read }
}
async function install(input = binding()) {
  const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
  const inspection = installRuntimeCodeGate(input)
  const callbacks = hooks.register.mock.calls[0]?.[0] as { resolve: ResolveHookSync; load: LoadHookSync }
  expect(callbacks).toBeDefined()
  return { inspection, callbacks, input, installRuntimeCodeGate }
}
const resolveContext = (parentURL?: string): ResolveHookContext => ({ conditions: ['node', 'import'], importAttributes: {}, parentURL })
const loadContext: LoadHookContext = { conditions: ['node', 'import'], importAttributes: {}, format: 'commonjs' }
// JavaScript loaders can return values outside Node's declaration-file source union.
function javascriptLoadResult(properties: object): ReturnType<LoadHookSync> {
  const result: ReturnType<LoadHookSync> = { format: 'commonjs' }
  Object.assign(result, properties)
  return result
}
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NODE_OPTIONS', '')
  process.execArgv = []
  cjs._cache = {}
  hooks.register.mockReset()
  hooks.resolve.mockReset().mockImplementation((request: string) => request)
  hooks.paths.mockClear()
  cjs._resolveFilename = hooks.resolve
})
afterEach(() => {
  process.execArgv = originalArgv
  vi.unstubAllEnvs()
})

describe('runtime inventory admission', () => {
  it.each(['--import=evil', '--require evil', '--experimental-loader evil', '-r evil'])('refuses ambient preload %s before installing hooks', async (option) => {
    vi.stubEnv('NODE_OPTIONS', option)
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate(binding())).toThrow('NODE_OPTIONS')
    expect(hooks.register).not.toHaveBeenCalled()
  })
  it.each([['--import=evil'], ['--require', 'evil'], ['-r'], ['--loader', 'evil']])('refuses unadmitted argv %j', async (...argv) => {
    process.execArgv = argv
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate(binding())).toThrow('unadmitted preload')
  })
  it('admits fixed preloads, ordinary flags and sparse argv without trusting later input edits', async () => {
    vi.stubEnv('NODE_OPTIONS', undefined)
    process.execArgv = ['--inspect', '--import=accepted', '-r', 'accepted']
    process.execArgv.length++
    const input = binding()
    const { inspection, installRuntimeCodeGate } = await install({ ...input, admittedPreloads: ['accepted'] })
    expect(Object.isFrozen(inspection)).toBe(true)
    const admitted = inspection.inspect(entry)
    expect(Object.isFrozen(admitted)).toBe(true)
    Object.assign(input.files[0]!, { sha256: '0'.repeat(64) })
    Object.assign(input.aliases[0]!, { physical: root })
    input.source.read = () => { throw new Error('late read replacement') }
    expect(inspection.inspect(entry)).toBe(admitted)
    expect(() => installRuntimeCodeGate(input)).toThrow('already installed')
    expect(() => inspection.inspect(join(physical, 'missing.js'))).toThrow('outside the admitted runtime inventory')
    input.bytes.set(entry, Buffer.from('module.exports = 43'))
    expect(() => inspection.inspect(entry)).toThrow('bytes changed')
    input.bytes.set(entry, Buffer.from('short'))
    expect(() => inspection.inspect(entry)).toThrow('bytes changed')
  })
  it.each([
    ['duplicate files', (input: RuntimeCodeGateBinding) => ({ ...input, files: [...input.files, input.files[0]!] })],
    ['relative root', (input: RuntimeCodeGateBinding) => ({ ...input, roots: ['relative'] })],
    ['uncanonical root', (input: RuntimeCodeGateBinding) => ({ ...input, roots: [physical + '/..'] })],
    ['relative alias', (input: RuntimeCodeGateBinding) => ({ ...input, aliases: [{ logical: 'relative', physical }] })],
    ['uncanonical alias', (input: RuntimeCodeGateBinding) => ({ ...input, aliases: [{ logical: logical + '/..', physical }] })],
    ['alias outside roots', (input: RuntimeCodeGateBinding) => ({ ...input, aliases: [{ logical, physical: root }] })],
  ])('refuses %s', async (_name, change) => {
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate(change(binding()))).toThrow('inventory paths are invalid')
  })
  it.each([
    { path: 'relative' }, { path: entry + '/..' }, { bytes: 0.5 }, { bytes: -1 }, { sha256: 'invalid' }, { path: root },
  ])('rejects invalid file facts %j', async (change) => {
    const input = binding()
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate({ ...input, files: [{ ...file(entry), ...change }] })).toThrow('Runtime code file is invalid')
  })
  it.each([
    [{ generated: entry, bootstrap: entry }, { generated: entry, bootstrap: entry }],
    [{ generated: join(physical, 'missing'), bootstrap: entry }],
    [{ generated: entry, bootstrap: join(bootstrap, 'missing') }],
    [{ generated: entry, bootstrap: packagePath }],
  ])('refuses invalid shared module map %j', async (...sharedModules) => {
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate({ ...binding(), sharedModules })).toThrow(/Duplicate shared|differs from its inventoried/)
  })
  it('rejects shared copies whose byte count differs even with matching declared digest', async () => {
    const input = binding(), copy = join(bootstrap, 'copy.cjs')
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate({ ...input, files: [...input.files, { ...file(copy), bytes: 1 }], sharedModules: [{ generated: entry, bootstrap: copy }] })).toThrow('differs from its inventoried')
  })
  it('refuses unknown bootstrap files and previously loaded application modules', async () => {
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate({ ...binding(), bootstrapFiles: [join(bootstrap, 'missing')] })).toThrow('outside the closed inventory')
    cjs._cache[original] = new Module(original)
    expect(() => installRuntimeCodeGate(binding())).toThrow('loaded before runtime admission')
  })
  it('permits already loaded inventoried bootstrap files and unrelated cached code', async () => {
    const input = binding()
    cjs._cache[entry] = new Module(entry)
    cjs._cache[join(root, 'unmanaged.cjs')] = new Module('unmanaged')
    await install({ ...input, bootstrapFiles: [entry] })
  })
  it('checks metadata before registration and restores the native resolver if registration fails', async () => {
    const input = binding(), failure = new Error('hook registration failed')
    hooks.register.mockImplementationOnce(() => { throw failure })
    const { installRuntimeCodeGate } = await import('../src/runtime-code-gate.ts')
    expect(() => installRuntimeCodeGate(input)).toThrow(failure)
    expect(Reflect.get(cjs, '_resolveFilename')).toBe(hooks.resolve)
    installRuntimeCodeGate(input)
    expect(input.read.mock.calls.map(([row]) => row.path)).toEqual([packagePath, packagePath])
  })
})

describe('CommonJS resolver callbacks', () => {
  it('delegates unmanaged callers and accepts native builtin spellings without inventory reads', async () => {
    const { input } = await install()
    input.read.mockClear()
    expect(cjs._resolveFilename('unmanaged', undefined)).toBe('unmanaged')
    const outside = new Module('outside'); outside.filename = join(root, 'outside.cjs')
    expect(cjs._resolveFilename('relative', outside)).toBe('relative')
    for (const request of ['node:path', 'path']) {
      hooks.resolve.mockReturnValueOnce('node:path')
      expect(cjs._resolveFilename(request)).toBe('node:path')
    }
    expect(input.read).not.toHaveBeenCalled()
    hooks.resolve.mockReturnValueOnce(entry)
    expect(() => cjs._resolveFilename('node:path')).toThrow('builtin was redirected')
    hooks.resolve.mockReturnValueOnce('node:fs')
    expect(() => cjs._resolveFilename('path')).toThrow('builtin was redirected')
  })
  it('maps direct requests, parent ancestry and explicit lookup paths into the admitted generation', async () => {
    await install()
    const parent = new Module(original), ancestor = new Module('ancestor')
    parent.filename = original
    Object.assign(parent, { parent: ancestor })
    hooks.resolve.mockReturnValue(entry)
    expect(cjs._resolveFilename('dependency', parent, false, { paths: [logical, physical], conditions: ['require'] })).toBe(entry)
    const [, synthetic, isMain, options] = hooks.resolve.mock.calls[0]!
    expect(synthetic).not.toBe(parent)
    expect(synthetic).toMatchObject({ filename: entry, parent: ancestor, paths: [physical] })
    expect(isMain).toBe(false)
    expect(options).toEqual({ paths: [physical, physical], conditions: ['require'] })
    expect(cjs._resolveFilename(original, undefined, true)).toBe(entry)
    expect(hooks.resolve.mock.calls[1]).toEqual([entry, undefined, true, undefined])
    expect(cjs._resolveFilename(entry, undefined, false, { conditions: ['require'] })).toBe(entry)
    expect(() => cjs._resolveFilename('dependency', parent, false, { paths: [root] })).toThrow('lookup escaped')
  })
  it('passes bootstrap paths unchanged and chooses the most specific logical alias', async () => {
    const input = binding(), deep = join(logical, 'nested'), nested = join(physical, 'specific'), nestedEntry = join(nested, 'entry.cjs')
    input.bytes.set(nestedEntry, Buffer.from('module.exports = 42'))
    await install({ ...input, files: [...input.files, file(nestedEntry)], bootstrapFiles: [entry],
      aliases: [{ logical, physical }, { logical: deep, physical: nested }] })
    hooks.resolve.mockReturnValueOnce(entry).mockReturnValueOnce(nestedEntry)
    expect(cjs._resolveFilename(entry)).toBe(entry)
    expect(cjs._resolveFilename(join(deep, 'entry.cjs'))).toBe(nestedEntry)
    expect(hooks.resolve.mock.calls[1]?.[0]).toBe(nestedEntry)
  })
  it('shares identical bootstrap copies and delegates reentrant native resolution only within the current call', async () => {
    const input = binding(), copy = join(bootstrap, 'entry.cjs')
    input.bytes.set(copy, Buffer.from('module.exports = 42'))
    await install({ ...input, files: [...input.files, file(copy)], sharedModules: [{ generated: entry, bootstrap: copy }] })
    hooks.resolve.mockImplementationOnce(() => {
      expect(cjs._resolveFilename('internal-resolution')).toBe('internal-resolution')
      return entry
    })
    expect(cjs._resolveFilename(original)).toBe(copy)
    const failure = new Error('native resolution failed')
    hooks.resolve.mockImplementationOnce(() => { throw failure })
    expect(() => cjs._resolveFilename(original)).toThrow(failure)
    hooks.resolve.mockReturnValueOnce(join(root, 'outside.cjs'))
    expect(() => cjs._resolveFilename(original)).toThrow('outside the admitted runtime inventory')
  })
})

describe('ESM resolve and load callbacks', () => {
  it('checks builtin resolution identity and delegates unrelated URLs and parents', async () => {
    const { callbacks, input } = await install()
    input.read.mockClear()
    for (const specifier of ['path', 'node:path']) {
      const next = vi.fn(() => ({ url: 'node:path' }))
      expect(callbacks.resolve(specifier, resolveContext(), next)).toEqual({ url: 'node:path' })
    }
    expect(() => callbacks.resolve('node:path', resolveContext(), () => ({ url: 'node:fs' }))).toThrow('builtin was redirected')
    for (const specifier of ['data:text/javascript,export{}', 'unmanaged', join(root, 'outside.js')]) {
      const next = vi.fn(() => ({ url: specifier }))
      expect(callbacks.resolve(specifier, resolveContext('data:parent'), next)).toEqual({ url: specifier })
    }
    expect(input.read).not.toHaveBeenCalled()
  })
  it('maps file URLs without dropping search or hash and preserves ordinary resolved metadata', async () => {
    const { callbacks } = await install()
    const next = vi.fn<Parameters<ResolveHookSync>[2]>(() => ({ url: url(entry) + '?mode=1#source', format: 'commonjs' as const, shortCircuit: true }))
    const result = callbacks.resolve(url(original) + '?mode=1#source', resolveContext(url(original) + '?parent=1#top'), next)
    expect(next).toHaveBeenCalledWith(url(entry) + '?mode=1#source', resolveContext(url(entry) + '?parent=1#top'))
    expect(result).toEqual({ url: url(entry) + '?mode=1#source', format: 'commonjs', shortCircuit: true })
    callbacks.resolve(original, resolveContext(), next)
    expect(next.mock.lastCall?.[0]).toBe(entry)
    callbacks.resolve('./entry.cjs', resolveContext(url(original)), next)
    expect(next.mock.lastCall?.[0]).toBe('./entry.cjs')
    callbacks.resolve(original, resolveContext('data:parent'), next)
    expect(next.mock.lastCall?.[1]).toEqual(resolveContext('data:parent'))
    expect(() => callbacks.resolve('./escape', resolveContext(url(original)), () => ({ url: 'https://example.test/code' }))).toThrow('unadmitted URL scheme')
    expect(() => callbacks.resolve('./escape', resolveContext(url(original)), () => ({ url: url(join(root, 'outside.js')) }))).toThrow('outside the admitted runtime inventory')
  })
  it('returns the inventoried bootstrap URL for an identical generated module', async () => {
    const input = binding(), copy = join(bootstrap, 'entry.cjs')
    input.bytes.set(copy, Buffer.from('module.exports = 42'))
    const { callbacks } = await install({ ...input, files: [...input.files, file(copy)],
      sharedModules: [{ generated: entry, bootstrap: copy }] })
    const selected = callbacks.resolve(url(original), resolveContext(), () => ({ url: url(entry), format: 'commonjs' }))
    expect(selected).toEqual({ url: url(copy), format: 'commonjs' })
  })
  it.each([
    { format: 'builtin' as const }, { format: 'builtin' as const, source: null }, { format: 'builtin' as const, responseURL: undefined }, { format: 'builtin' as const, responseURL: 'node:path' },
  ])('accepts untouched builtin result %j', async (result) => {
    const { callbacks } = await install()
    const output = javascriptLoadResult(result)
    expect(callbacks.load('node:path', loadContext, () => output)).toBe(output)
  })
  it.each([
    { format: 'module' as const }, { format: 'builtin' as const, source: '' }, { format: 'builtin' as const, responseURL: 'node:fs' },
  ])('rejects builtin replacement %j', async (result) => {
    const { callbacks } = await install()
    expect(() => callbacks.load('node:path', loadContext, () => result)).toThrow('builtin bytes were replaced')
  })
  it('delegates non-file and unmanaged file loads', async () => {
    const { callbacks, input } = await install()
    input.read.mockClear()
    const result = { format: 'module' as const, source: 'export {}' }
    for (const target of ['data:text/javascript,export{}', url(join(root, 'outside.js'))]) expect(callbacks.load(target, loadContext, () => result)).toBe(result)
    expect(input.read).not.toHaveBeenCalled()
  })
  it.each(['string', 'buffer', 'view', 'arraybuffer', 'undefined', 'null'] as const)('verifies native %s source and rereads after loader execution', async (kind) => {
    const { callbacks, input } = await install()
    const text = 'module.exports = 42', bytes = new TextEncoder().encode(text)
    const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2)
    const source = kind === 'string' ? text : kind === 'buffer' ? Buffer.from(bytes) : kind === 'view' ? new DataView(padded.buffer, 2, bytes.length)
      : kind === 'arraybuffer' ? bytes.buffer : kind === 'null' ? null : undefined
    const result = javascriptLoadResult({ format: 'commonjs', source, responseURL: url(entry) })
    input.read.mockClear()
    expect(callbacks.load(url(entry), loadContext, () => result)).toBe(result)
    expect(input.read.mock.calls.map(([row]) => row.path)).toEqual([entry, entry])
  })
  it('rejects redirected, unsupported or transformed sources and mutations during loader execution', async () => {
    const { callbacks, input } = await install()
    expect(() => callbacks.load(url(entry), loadContext, () => ({ format: 'commonjs', responseURL: url(original) }))).toThrow('changed admitted executable identity')
    const malformed = javascriptLoadResult({ format: 'commonjs', source: { untrusted: true } })
    expect(() => callbacks.load(url(entry), loadContext, () => malformed)).toThrow('unsupported executable source')
    for (const source of ['module.exports = 43', 'short']) expect(() => callbacks.load(url(entry), loadContext, () => ({ format: 'commonjs', source }))).toThrow('transformed admitted executable bytes')
    expect(() => callbacks.load(url(entry), loadContext, () => {
      input.bytes.set(entry, Buffer.from('module.exports = 43'))
      return { format: 'commonjs', responseURL: undefined }
    })).toThrow('Admitted runtime bytes changed')
  })
})
