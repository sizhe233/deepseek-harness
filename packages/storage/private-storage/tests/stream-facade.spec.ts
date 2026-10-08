/** Cross-provider authority routing; native storage behavior is exercised in its separate provider suites. */
import { afterEach, expect, it, vi } from 'vitest'
import { createStreamFacade } from '../src/stream-facade.ts'
import { createWindowsStreamFacade } from '../src/windows-stream-facade.ts'
import type { PrivateFileWriterOptions, SourceFileReaderOptions } from '../src/stream-types.ts'
import type { SourceDocumentReadOptions } from '../src/source-document-reader.ts'
import type { ManagementLease, PrivateStreamDirectory, SourceDirectory } from '../src/stream-directory-types.ts'

const model = vi.hoisted(() => {
  const open = new Set<object>(), calls: { name: string; args: unknown[] }[] = []
  let inode = 0
  const capability = () => {
    const cap = { identity: { backend: 'posix', device: '1', inode: String(++inode) }, policy: 'private', close() { open.delete(cap) } }
    open.add(cap); return cap
  }
  const inspect = (cap: object) => { if (!open.has(cap)) throw new Error('native capability closed') }
  const perform = (name: string) => (...args: unknown[]) => {
    inspect(args[0] as object); calls.push({ name, args }); return { observedBy: name }
  }
  return { open, calls, capability, inspect, perform }
})
vi.mock('../src/native-posix.ts', () => ({
  posixStreamCapabilities: () => ({ available: true, backend: 'posix', acceptance: 'unverified', platform: 'linux', architecture: 'x64' }),
  openPosixPrivateDirectory: () => model.capability(), openPosixSourceDirectory: () => model.capability(),
  openPosixPrivateStreamRoot: () => ({ directory: model.capability(), receipt: { kind: 'existing-root', durability: 'not-attempted' } }),
  openPosixSourceChild: (parent: object) => { model.inspect(parent); return model.capability() },
  listPosixSourceDirectory: model.perform('source-list'),
  inspectPosixSourceLink: model.perform('source-link'), openPosixObservedSourceFileReader: model.perform('observed-reader'),
  openPosixPrivateStreamChild: (parent: object) => { model.inspect(parent); return model.capability() },
  createPosixPrivateStreamChild: (parent: object) => { model.inspect(parent); return { directory: model.capability(),
    receipt: { publication: 'published' } } },
  createPosixPrivateFileWriter: model.perform('writer'), readPosixPrivateRecord: model.perform('record'),
  openPosixPrivateFileReader: model.perform('reader'), listPosixPrivateStreamDirectory: model.perform('list'),
  inspectPosixPrivateStreamEntry: model.perform('inspect'), observePosixPrivateStreamCapacity: model.perform('capacity'),
  acquirePosixManagementLease: (parent: object) => {
    model.inspect(parent); const cap = model.capability(); return { ...cap, parentIdentity: { parent } }
  },
  assertPosixManagementLease: (parent: object, lease: { close(): void }) => {
    model.inspect(parent); model.calls.push({ name: 'lease', args: [parent, lease] })
  },
  createPosixControlRecordOwner: model.perform('controls'), inspectPosixSourceFile: model.perform('source-inspect'),
  readPosixSourceDocument: model.perform('document'), openPosixSourceFileReader: model.perform('source-reader'),
}))
const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', nativePlatform); model.open.clear(); model.calls.length = 0 })
function facade() {
  const unavailable = (): never => { throw new Error('Windows native acquisition must not run') }
  const windows = createWindowsStreamFacade({ openDirectory: unavailable, openChild: unavailable, createChild: unavailable,
    retainParent: unavailable, rootParentIdentity: unavailable, acquireLease: unavailable, assertLease: unavailable })
  return createStreamFacade(windows, () => ({ available: false, backend: 'windows-ntfs', platform: 'win32',
    architecture: 'x64', reason: 'model unavailable' }))
}

it('retains provider authority across platform changes and forwards native capabilities instead of wrappers', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const api = facade(), root = api.openDirectory('/synthetic', { create: false })
  expect(root.identity.backend).toBe('posix'); expect(api.capabilities()).toMatchObject({ backend: 'posix', acceptance: 'unverified' })
  const opened = api.openChild(root, 'old'), made = api.createChild(root, 'new')
  expect(made.receipt).toEqual({ publication: 'published' })
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  expect(api.capabilities()).toMatchObject({ available: false, backend: 'windows-ntfs', platform: 'win32',
    acceptance: 'unverified', maxChunkBytes: 1048576 })
  const writer = {} as PrivateFileWriterOptions, reader = {} as SourceFileReaderOptions
  expect(api.createWriter(root, 'asset', writer)).toEqual({ observedBy: 'writer' })
  expect(api.readRecord(root, 'current', { maxBytes: 64 })).toEqual({ observedBy: 'record' })
  expect(api.openFileReader(root, 'asset', reader)).toEqual({ observedBy: 'reader' })
  expect(api.list(root, 0)).toEqual({ observedBy: 'list' })
  expect(model.calls.at(-1)?.args[1]).toEqual({ maxEntries: 0 })
  expect(api.inspect(root, 'asset')).toEqual({ observedBy: 'inspect' })
  expect(api.capacity(root)).toEqual({ observedBy: 'capacity' })
  const lease = api.acquireLease(root, 'writer.lock')
  api.assertLease(root, lease)
  expect(api.controlOwner(root, lease, ['current'])).toEqual({ observedBy: 'controls' })
  for (const call of model.calls) { expect(call.args[0]).not.toBe(root); expect(model.open.has(call.args[0] as object)).toBe(true) }
  expect(() => api.openLog(root, 'log', { maxChunkBytes: 64 })).toThrow(/Windows provider/u)
  lease.close(); opened.close(); made.directory.close(); root.close()
  expect(model.open.size).toBe(0)
  expect(() => api.list(root, 1)).toThrow(/native capability closed/u)
})

it('rejects foreign wrapper, lease and source capabilities before a provider sees them', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const first = facade(), second = facade(), root = first.openDirectory('/synthetic', { create: false })
  const foreign = second.openDirectory('/synthetic', { create: false }), lease = second.acquireLease(foreign, 'writer.lock')
  expect(() => first.openChild(foreign, 'child')).toThrow(/another installed provider/u)
  expect(() =>{  first.assertLease(root, lease) }).toThrow(/another installed provider/u)
  expect(() => first.controlOwner(root, {} as ManagementLease, ['current'])).toThrow(/another installed provider/u)
  expect(() => first.capacity({} as PrivateStreamDirectory)).toThrow(/another installed provider/u)
  expect(() => first.inspectSource({} as SourceDirectory, 'file')).toThrow(/another installed provider/u)
  expect(model.calls).toEqual([])
  lease.close(); foreign.close(); root.close()
})

it('routes retained source observations and strict readers through their own provider without admitting private authority', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const api = facade(), source = api.openSource('/synthetic')
  const opened = api.openRoot('/synthetic-private', { create: false })
  expect(opened.receipt).toMatchObject({ kind: 'existing-root', durability: 'not-attempted' }); opened.directory.close()
  expect(source.policy).toBe('source')
  const child = api.openSourceChild(source, 'child')
  expect(api.listSource(child, 0)).toEqual({ observedBy: 'source-list' })
  child.close()
  expect(api.inspectSource(source, 'original')).toEqual({ observedBy: 'source-inspect' })
  expect(api.inspectSourceLink(source, 'bin', { maxBytes: 32768 })).toEqual({ observedBy: 'source-link' })
  expect(api.openObservedSourceReader(source, 'asset', { expectedSource: {} as import('../src/stream-types.ts').SourceFileFacts,
    maxBytes: 1 })).toEqual({ observedBy: 'observed-reader' })
  expect(api.readSourceDocument(source, 'original', {} as SourceDocumentReadOptions)).toEqual({ observedBy: 'document' })
  expect(api.openSourceReader(source, 'asset', {} as SourceFileReaderOptions)).toEqual({ observedBy: 'source-reader' })
  source.close(); expect(model.open.size).toBe(0)
  expect(() => api.inspectSource(source, 'original')).toThrow(/native capability closed/u)
})
