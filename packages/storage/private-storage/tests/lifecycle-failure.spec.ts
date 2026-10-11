import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNative } from './fake-native.ts'
import { PrivateStorageError } from '../src/error.ts'
import { createHash } from 'node:crypto'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import type { PrivateDirectory } from '../src/types.ts'

const mock = vi.hoisted(() => {
  const original = globalThis.FinalizationRegistry
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const callbacks: (() => void)[] = []
  class Registry<T> {
    constructor(readonly callback: (held: T) => void) {}
    register(_target: object, held: T): void { callbacks.push(() => { this.callback(held) }) }
    unregister(): boolean { return true }
  }
  vi.stubGlobal('FinalizationRegistry', Registry)
  return { original, platform, callbacks, load: vi.fn() }
})
vi.mock('../src/native.ts', () => ({ loadNativeStorage: mock.load }))
import * as storage from '../src/index.ts'

function matching(value: Record<string, unknown>): unknown { return expect.objectContaining(value) }

let native: FakeNative
let parents: PrivateDirectory[]
function root(path = 'C:\\private', create = false): PrivateDirectory {
  const parent = storage.openPrivateDirectory(path, { create }); parents.push(parent); return parent
}
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  native = new FakeNative(); parents = []; mock.callbacks.length = 0
  mock.load.mockImplementation(() => native.asNative())
})
afterEach(() => {
  Object.defineProperty(process, 'platform', mock.platform)
  native.hook = () => {}
  for (const parent of parents) parent.close()
  vi.restoreAllMocks()
})
afterAll(() => { vi.stubGlobal('FinalizationRegistry', mock.original) })

function mutateOnInspect(name: string, change: (facts: ReturnType<FakeNative['inspect']>, count: number) => ReturnType<FakeNative['inspect']>): void {
  const inspect = native.inspect.bind(native)
  let count = 0
  vi.spyOn(native, 'inspect').mockImplementation((handle) => {
    const facts = inspect(handle)
    return native.entry(handle).name === name || (name === 'staging' && native.entry(handle).name.startsWith('.dsh-private-')) ? change(facts, ++count) : facts
  })
}

describe('resource release and drift failures', () => {
  it('finalizers release only handles, are idempotent, and contain close failures', () => {
    root(); mock.callbacks[0]!(); mock.callbacks[0]!()
    expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('remove'); expect(native.events).not.toContain('rename')
    root(); native.hook = (operation) => { if (operation === 'close') throw new PrivateStorageError('native', 'close fault') }
    expect(() => { mock.callbacks[1]!() }).not.toThrow()
  })
  it('explicit close attempts every owned guard and reports the first failure', () => {
    const parent = root()
    native.hook = (operation) => { if (operation === 'close') throw new PrivateStorageError('native', 'close fault') }
    expect(() => { parent.close() }).toThrow(/close fault/u)
    expect(native.events.filter(operation => operation === 'close')).toHaveLength(2)
    parent.close()
  })
  it('rejects an unexpected child type and a non-directory root', () => {
    native.add(2n, 'child', 'file')
    expect(() => storage.openPrivateChild(root(), 'child')).toThrow(/object type/u)
    mutateOnInspect('private', facts => ({ ...facts, kind: 'file' }))
    expect(() => root()).toThrow(/directory required/u)
  })
  it.each(['wrong-kind', 'not-write-through', 'wrong-volume', 'pre-rename-identity', 'pre-rename-mode', 'pre-rename-size'])('refuses unsafe staging state %s and removes only staging', (fault) => {
    const parent = root()
    mutateOnInspect('staging', (facts, count) => {
      if (count === 1) {
        if (fault === 'wrong-kind') return { ...facts, kind: 'directory' }
        if (fault === 'not-write-through') return { ...facts, writeThrough: false }
        if (fault === 'wrong-volume') return { ...facts, identity: { ...facts.identity, volumeSerial: 'different' } }
      } else {
        if (fault === 'pre-rename-identity') return { ...facts, identity: { ...facts.identity, fileId: 'different' } }
        if (fault === 'pre-rename-mode') return { ...facts, writeThrough: false }
        if (fault === 'pre-rename-size') return { ...facts, sizeBytes: 7n }
      }
      return facts
    })
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.from('abc'))).toThrow(expect.objectContaining({ receipt: matching({ publication: 'not-published', cleanup: 'delete-pending' }) }))
    expect(native.events).not.toContain('rename')
  })
  it.each(['final-identity', 'source-identity', 'final-kind', 'source-mode', 'source-size'])('retains publication after post-rename drift %s', (fault) => {
    const parent = root()
    mutateOnInspect('record', (facts, count) => {
      if ((fault === 'final-identity' && count === 1) || (fault === 'source-identity' && count === 2)) return { ...facts, identity: { ...facts.identity, fileId: 'changed' } }
      if (fault === 'final-kind' && count === 1) return { ...facts, kind: 'directory' }
      if (fault === 'source-mode' && count === 2) return { ...facts, writeThrough: false }
      if (fault === 'source-size' && count === 2) return { ...facts, sizeBytes: 7n }
      return facts
    })
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.from('abc'))).toThrow(expect.objectContaining({ receipt: matching({ publication: 'published', durability: 'unconfirmed' }) }))
    expect(native.events).not.toContain('remove')
  })
  it('reports binding drift across directory source-close and non-delete-shared guard reopen', () => {
    const parent = root()
    mutateOnInspect('child', (facts, count) => count === 3 ? { ...facts, identity: { ...facts.identity, fileId: 'different' } } : facts)
    expect(() => storage.createPrivateChild(parent, 'child')).toThrow(expect.objectContaining({ receipt: matching({ publication: 'published', phase: 'retain-directory-guard', cleanup: 'withheld' }) }))
    expect(native.events).not.toContain('remove')
  })
  it('records close cleanup failure separately from the original write error and native code', () => {
    const parent = root()
    native.hook = (operation, handle) => {
      if (operation === 'write') throw new PrivateStorageError('limit', 'write failed', { win32Code: 112 })
      if (operation === 'close' && handle && native.entry(handle).name.startsWith('.dsh-private-')) throw new Error('close failed')
    }
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.alloc(1))).toThrow(expect.objectContaining({ code: 'limit', win32Code: 112, receipt: matching({ cleanup: 'failed' }) }))
  })
})

describe('ambiguous native publication reconciliation', () => {
  it('recovers the published identity when the native rename succeeded but its return was lost', () => {
    const parent = root()
    const rename = native.rename.bind(native)
    vi.spyOn(native, 'rename').mockImplementation((...args) => { rename(...args); throw new Error('lost return') })
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.from('new'))).toThrow(expect.objectContaining({ receipt: matching({ publication: 'published', durability: 'unconfirmed', cleanup: 'withheld' }) }))
    expect(native.events).not.toContain('remove')
    expect(Buffer.from(storage.readPrivateFile(parent, 'record', 3)).toString()).toBe('new')
  })
  it('keeps indeterminate state when the created source moved outside both known bindings', () => {
    const parent = root()
    vi.spyOn(native, 'rename').mockImplementation((handle) => { native.entry(handle).name = 'relocated'; throw new Error('lost rename') })
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.from('x'))).toThrow(expect.objectContaining({ receipt: matching({ publication: 'indeterminate', cleanup: 'withheld' }) }))
    expect(native.events).not.toContain('remove')
  })
})

describe('collision winner admission and lock release failures', () => {
  function collision(name: string): void {
    const rename = native.rename.bind(native)
    vi.spyOn(native, 'rename').mockImplementation((handle, parent, target, replace) => {
      if (target === name) native.add(native.id(parent), name, name.endsWith('.lock') ? 'file' : 'directory')
      rename(handle, parent, target, replace)
    })
  }
  it('admits an independently checked private directory collision winner', () => {
    collision('raced')
    expect(root('C:\\raced', true).identity).toBeDefined()
  })
  it('does not silently admit other directory publication failures', () => {
    native.hook = (operation) => { if (operation === 'open:create') throw new Error('native unavailable') }
    expect(() => root('C:\\new', true)).toThrow(/native/u)
  })
  it('uses a checked lock collision winner without deleting it', () => {
    const parent = root(); collision('writer.lock')
    const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock')
    lease.release()
    expect([...native.entries.values()].filter(entry => entry.name === 'writer.lock')).toHaveLength(1)
  })
  it('propagates lock-file open, creation and acquisition failures with owned cleanup', () => {
    const parent = root()
    native.hook = (operation) => { if (operation === 'open:lock') throw new PrivateStorageError('privacy', 'lock public') }
    expect(() => storage.acquirePrivateWriterLease(parent, 'writer.lock')).toThrow(/privacy/u)
    native.hook = (operation) => { if (operation === 'open:create') throw new PrivateStorageError('native', 'create failed') }
    expect(() => storage.acquirePrivateWriterLease(parent, 'writer.lock')).toThrow(/native/u)
    native.hook = (operation) => { if (operation === 'lock') throw new PrivateStorageError('busy', 'contended') }
    expect(() => storage.acquirePrivateWriterLease(parent, 'writer.lock')).toThrow(/busy/u)
    expect(native.handles.size).toBe(2)
  })
  it.each(['unlock', 'close', 'guards'])('releases every lease resource after %s failure', (fault) => {
    const parent = root(); const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock')
    parent.close()
    native.hook = (operation, handle) => {
      if ((fault === 'unlock' && operation === 'unlock') || (fault === 'close' && operation === 'close' && handle && native.entry(handle).name === 'writer.lock') || (fault === 'guards' && operation === 'close' && handle && native.entry(handle).name !== 'writer.lock')) throw new PrivateStorageError('native', `${fault} failed`)
    }
    expect(() => { lease.release() }).toThrow(/failed/u)
    lease.release()
    expect(native.events.filter(operation => operation === 'close').length).toBeGreaterThanOrEqual(3)
  })
  it('detects an oversized native enumeration instead of trusting a partial audit', () => {
    const parent = root(); const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock')
    vi.spyOn(native, 'names').mockReturnValue(['a', 'b'])
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 1, maxDepth: 1 }, lease)).toThrow(/audit entries/u)
    lease.release()
  })
})


describe('primary errors survive failed cleanup and partial root creation', () => {
  it.each(['typed', 'untyped'])('retains original %s failure classification if close also fails', (kind) => {
    const parent = root(); native.add(2n, 'record', 'file', Buffer.from('abc'))
    native.hook = (operation, handle) => {
      if (operation === 'read') {
        if (kind === 'typed') throw new PrivateStorageError('changed', 'read failed', { nativeStatus: 0xc0000022, win32Code: 5 })
        throw new Error('read failed')
      }
      if (operation === 'close' && handle && native.entry(handle).name === 'record') throw new Error('close failed')
    }
    expect(() => storage.readPrivateFile(parent, 'record', 3)).toThrow(expect.objectContaining({ code: kind === 'typed' ? 'changed' : 'native', cleanupFailed: true, ...(kind === 'typed' ? { nativeStatus: 0xc0000022, win32Code: 5 } : {}) }))
  })
  it('retains earlier directory namespace receipts if a later fresh level fails', () => {
    native.hook = (operation, handle) => {
      if (operation === 'inspect' && handle && native.entry(handle).name === 'first') {
        native.hook = (next) => { if (next === 'open:create') throw new PrivateStorageError('limit', 'second level failed') }
      }
    }
    expect(() => root('C:\\first\\second', true)).toThrow(expect.objectContaining({ code: 'limit', directoryPublications: [matching({ publication: 'published', durability: 'synced' })], receipt: matching({ publication: 'not-published' }) }))
  })
  it('retains an ordinary typed failure without native status through root cleanup failure', () => {
    native.hook = (operation) => { if (operation === 'filesystem') throw new PrivateStorageError('unsupported', 'volume rejected'); if (operation === 'close') throw new Error('close failed') }
    expect(() => root()).toThrow(expect.objectContaining({ code: 'unsupported', cleanupFailed: true, directoryPublications: [] }))
  })
  it('identity-binds reopening an enumeration-capable child directory', () => {
    const parent = root(); native.add(2n, 'child', 'directory')
    const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock')
    mutateOnInspect('child', (facts, count) => count === 2 ? { ...facts, identity: { ...facts.identity, fileId: 'changed' } } : facts)
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 3, maxDepth: 1 }, lease)).toThrow(/audit directory binding changed/u)
    lease.release()
  })
})


it('finalizer holdings release leases without retaining public capabilities', () => {
  const parent = root()
  storage.acquirePrivateWriterLease(parent, 'writer.lock')
  mock.callbacks[1]!()
  expect(native.events.filter(event => event === 'unlock')).toHaveLength(1)
})

it('normalizes non-Error native release failures without interrupting sibling cleanup', () => {
  const parent = root()
  const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock')
  native.hook = (operation) => { if (operation === 'unlock') throw 'synthetic foreign exception' }
  expect(() => { lease.release() }).toThrow(/resource release failed/u)
  native.hook = (operation) => { if (operation === 'close') throw 'synthetic foreign exception' }
  expect(() => { parent.close() }).toThrow(/resource release failed/u)
})


describe('publication close has conservative cleanup facts without a second close', () => {
  it.each(['file', 'directory'] as const)('keeps published/synced %s facts when close refuses release or loses its return', (kind) => {
    for (const outcome of ['refused', 'lost-return'] as const) {
      const parent = root()
      const name = `${kind}-${outcome}`
      let source: bigint | undefined
      let ownedAfterFailure: bigint | undefined
      let attempts = 0
      native.hook = (operation, handle) => { if (operation === 'rename') source = handle }
      const close = native.close.bind(native)
      const spy = vi.spyOn(native, 'close').mockImplementation((handle) => {
        if (handle !== source) { close(handle); return }
        attempts++
        if (outcome === 'lost-return') {
          close(handle)
          // Reuse the retired number for a different fixture-owned identity.
          native.next = handle
          ownedAfterFailure = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
          expect(ownedAfterFailure).toBe(handle)
        } else ownedAfterFailure = handle
        throw new PrivateStorageError('native', 'source close unconfirmed', { nativeStatus: 0xc0000008, win32Code: 6 })
      })
      let failure: unknown
      try {
        if (kind === 'file') storage.createPrivateFileExclusive(parent, name, Buffer.from('new'))
        else storage.createPrivateChild(parent, name)
      } catch (error) { failure = error }
      const entry = [...native.entries.values()].find(value => value.name === name)
      expect(entry).toBeDefined()
      expect(failure).toMatchObject({ code: 'native', nativeStatus: 0xc0000008, win32Code: 6, cleanupFailed: true,
        receipt: { publication: 'published', durability: 'synced', phase: 'close', cleanup: 'failed',
          parentIdentity: parent.identity, identity: entry!.facts.identity, nativeStatus: 0xc0000008 } })
      expect(attempts).toBe(1)
      expect(native.events).not.toContain('remove')
      expect(native.handles.has(ownedAfterFailure!)).toBe(true)
      expect(native.entry(ownedAfterFailure!).name).toBe(outcome === 'lost-return' ? '\\??\\C:\\' : name)
      spy.mockRestore(); native.hook = () => {}
      // The fixture knows whether it retained the original handle or owns its new replacement.
      native.close(ownedAfterFailure!)
      parent.close()
    }
  })
  it('keeps close uncertainty through earlier-directory publication context', () => {
    let source: bigint | undefined
    let attempts = 0
    native.hook = (operation, handle) => {
      if (operation === 'rename') source = handle
      if (operation === 'close' && handle !== undefined && handle === source && native.entry(handle).name === 'second') {
        attempts++
        throw new PrivateStorageError('native', 'source close unconfirmed', { win32Code: 6 })
      }
    }
    expect(() => root('C:\\first\\second', true)).toThrow(expect.objectContaining({ cleanupFailed: true, win32Code: 6,
      receipt: matching({ publication: 'published', durability: 'synced', phase: 'close', cleanup: 'failed' }),
      directoryPublications: [matching({ publication: 'published', durability: 'synced', cleanup: 'not-needed' })] }))
    expect(attempts).toBe(1); expect(native.events).not.toContain('remove')
    expect(native.handles.size).toBe(1)
    native.hook = () => {}; native.close(source!)
  })
  it('preserves an earlier validation cleanup signal when no staging source exists', () => {
    const parent = root(); native.add(2n, 'record', 'file')
    let held: bigint | undefined
    native.hook = (operation, handle) => {
      if (handle && native.entry(handle).name === 'record') {
        held = handle
        if (operation === 'inspect') throw new PrivateStorageError('changed', 'validation failed', { win32Code: 5 })
        if (operation === 'close') throw new Error('validation handle release unconfirmed')
      }
    }
    expect(() => storage.replacePrivateFile(parent, 'record', Buffer.from('new'))).toThrow(expect.objectContaining({ code: 'changed', win32Code: 5,
      cleanupFailed: true, receipt: matching({ publication: 'not-published', phase: 'validate', identity: null }) }))
    expect(native.events).not.toContain('open:create')
    native.hook = () => {}; native.close(held!)
  })
})

describe('publishing source excludes external DELETE authority', () => {
  it('prevents a staging-to-final move before a failed write cleans its own unpublished file', () => {
    const parent = root()
    storage.createPrivateFileExclusive(parent, 'record', Buffer.from('original'))
    const original = storage.inspectPrivate(parent, 'record').identity
    const parentHandle = [...native.handles].find(([, opened]) => opened.entry.name === 'private')![0]
    let attempted = 0
    native.hook = (operation, handle) => {
      if (operation !== 'write' || handle === undefined) return
      const staging = native.entry(handle).name
      const inspection = native.open(parentHandle, staging, 'file', 'inspect')
      expect(native.inspect(inspection).identity).toEqual(native.inspect(handle).identity)
      native.close(inspection)
      expect(() => native.open(parentHandle, staging, 'file', 'delete')).toThrow(expect.objectContaining({ code: 'sharing', win32Code: 32 }))
      attempted++
      throw new PrivateStorageError('native', 'synthetic pre-publication write failure', { win32Code: 112 })
    }
    expect(() => storage.replacePrivateFile(parent, 'record', Buffer.from('new'))).toThrow(expect.objectContaining({
      win32Code: 112, receipt: matching({ publication: 'not-published', cleanup: 'delete-pending' }),
    }))
    expect(attempted).toBe(1)
    native.hook = () => {}
    expect(Buffer.from(storage.readPrivateFile(parent, 'record', 32)).toString()).toBe('original')
    expect(storage.inspectPrivate(parent, 'record').identity).toEqual(original)
    expect([...native.entries.values()].some(entry => entry.name.startsWith('.dsh-private-'))).toBe(false)
  })
})


it.each(['stream-writer', 'source-reader', 'private-reader', 'log'] as const)(
  'finalizer model releases %s ownership without namespace work, including failed closes', (kind) => {
    native.add(2n, 'source.bin', 'file', Buffer.from('x'))
    const digest = createHash('sha256').update('x').digest('hex')
    const create = () => {
      if (kind === 'stream-writer') {
        const directory = root()
        const writer = storage.createPrivateFileWriter(directory, 'generated', {
          operationId: 'finalizer-model' as PrivateStreamOperationId, expectedBytes: 1, expectedSha256: digest, replace: false, executable: false,
        })
        writer.append(Buffer.from('x'))
      } else if (kind === 'source-reader') {
        const directory = storage.openSourceDirectory('C:\\private')
        const source = storage.inspectSourceFile(directory, 'source.bin')
        storage.openSourceFileReader(directory, 'source.bin', { expectedIdentity: source.identity, expectedBytes: 1, expectedSha256: digest })
      } else {
        const directory = storage.openPrivateStreamDirectory('C:\\private', { create: false })
        if (kind === 'log') storage.openPrivateLogSink(directory, 'output.log', { maxChunkBytes: 64 })
        else {
          const source = storage.inspectPrivateStreamEntry(directory, 'source.bin')
          if (source.kind !== 'file') throw new Error('regular model source required')
          storage.openPrivateFileReader(directory, 'source.bin', { expectedIdentity: source.facts.identity, expectedBytes: 1, expectedSha256: digest })
        }
      }
    }
    create()
    const namespace = native.events.filter(event => event === 'remove' || event === 'rename').length
    for (const callback of mock.callbacks.toReversed()) callback()
    for (const callback of mock.callbacks.toReversed()) callback()
    expect(native.handles.size).toBe(0)
    expect(native.events.filter(event => event === 'remove' || event === 'rename')).toHaveLength(namespace)
    mock.callbacks.length = 0
    create()
    native.hook = (operation) => { if (operation === 'close') throw new PrivateStorageError('native', 'finalizer close fault') }
    expect(() => { for (const callback of mock.callbacks.toReversed()) callback() }).not.toThrow()
  },
)
