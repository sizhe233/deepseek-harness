import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNative } from './fake-native.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { PrivateDirectory, PrivateWriterLease } from '../src/types.ts'

const mock = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../src/native.ts', () => ({ loadNativeStorage: mock.load }))
import * as storage from '../src/index.ts'

let native: FakeNative
let roots: PrivateDirectory[]
let leases: PrivateWriterLease[]
function root(path = 'C:\\private', create = false): PrivateDirectory {
  const directory = storage.openPrivateDirectory(path, { create })
  roots.push(directory)
  return directory
}
beforeEach(() => { native = new FakeNative(); roots = []; leases = []; mock.load.mockImplementation(() => native.asNative()) })
afterEach(() => {
  native.hook = () => {}
  for (const lease of leases) lease.close()
  for (const directory of roots.toReversed()) directory.close()
})

describe('opaque retained directory and writer ownership', () => {
  it('reports availability and typed loader failure', () => {
    expect(storage.capabilities()).toMatchObject({ available: true, backend: 'windows-ntfs', nativeArtifact: native.artifact })
    mock.load.mockImplementation(() => { throw new PrivateStorageError('unavailable', 'missing binary') })
    expect(storage.capabilities()).toMatchObject({ available: false, backend: null })
    mock.load.mockImplementation(() => { throw new Error('private bytes must not appear') })
    expect(storage.capabilities().reason).toBe('native backend unavailable')
  })
  it('rejects forged, closed and cross-context capabilities before native use', () => {
    const parent = root()
    parent.close(); parent.close()
    expect(native.handles.size).toBe(0)
    expect(() => storage.inspectPrivate(parent, 'record')).toThrow(/closed/u)
    expect(() => storage.inspectPrivate({ identity: parent.identity } as PrivateDirectory, 'record')).toThrow(/closed/u)
  })
  it('retains ancestors independently for children and leases', () => {
    native.add(2n, 'child', 'directory')
    const parent = root()
    const child = storage.openPrivateChild(parent, 'child'); roots.push(child)
    const lease = storage.acquirePrivateWriterLease(child, 'writer.lock'); leases.push(lease)
    parent.close(); child.close()
    expect(native.handles.size).toBeGreaterThan(0)
    lease.release(); lease.close()
    expect(native.handles.size).toBe(0)
    expect(native.events.filter(value => value === 'unlock')).toHaveLength(1)
    expect([...native.entries.values()].some(entry => entry.name === 'writer.lock')).toBe(true)
  })
  it('rejects changed token, root identity and object type', () => {
    const parent = root()
    const original = native.sid[12]!
    native.sid[12] = 99
    expect(() => storage.inspectPrivate(parent, 'record')).toThrow(/TokenUser changed/u)
    native.sid[12] = original
    const entry = native.entries.get(2n)!
    const old = entry.facts
    entry.facts = { ...old, kind: 'file' }
    expect(() => storage.inspectPrivate(parent, 'record')).toThrow(/directory changed/u)
    entry.facts = { ...old, identity: { ...old.identity, fileId: 'a'.repeat(32) } }
    expect(() => storage.inspectPrivate(parent, 'record')).toThrow(/directory changed/u)
    entry.facts = old
  })
  it('publishes each missing directory level with separate receipts and stable guards', () => {
    const parent = root('C:\\fresh\\nested', true)
    expect(parent.publications).toHaveLength(2)
    expect(parent.publications.every(receipt => receipt.publication === 'published' && receipt.durability === 'synced')).toBe(true)
    expect(native.events.filter(value => value === 'flush')).toHaveLength(0)
    expect(() => root('C:\\absent', false)).toThrow(/not-found/u)
    const result = storage.createPrivateChild(parent, 'child'); roots.push(result.directory)
    expect(result.receipt).toMatchObject({ publication: 'published', durability: 'synced' })
    expect(() => storage.createPrivateChild(parent, 'child')).toThrow(/collision/u)
  })
  it('closes a failed child admission without releasing the parent', () => {
    native.add(2n, 'child', 'directory')
    const parent = root()
    native.hook = (operation, handle) => { if (operation === 'filesystem' && handle && native.entry(handle).name === 'child') throw new PrivateStorageError('unsupported', 'synthetic filesystem') }
    expect(() => storage.openPrivateChild(parent, 'child')).toThrow(/unsupported/u)
    expect(native.handles.size).toBe(2)
  })
})

describe('bounded same-object byte reads and identity-safe cleanup', () => {
  it('reads empty, exact-limit and multi-chunk files without text interpretation', () => {
    const parent = root()
    for (const data of [Buffer.alloc(0), Buffer.from([0, 255, 128]), Buffer.alloc(131073, 42)]) {
      storage.replacePrivateFile(parent, 'record', data)
      expect(Buffer.from(storage.readPrivateFile(parent, 'record', data.length))).toEqual(data)
      if (data.length) expect(() => storage.readPrivateFile(parent, 'record', data.length - 1)).toThrow(/limit/u)
    }
  })
  it('rejects truncation, growth and same-sized mutation', () => {
    const parent = root(); storage.createPrivateFileExclusive(parent, 'record', Buffer.from('old'))
    for (const mutation of ['truncate', 'grow', 'timestamp']) {
      const entry = [...native.entries.values()].find(item => item.name === 'record')!
      entry.bytes = Buffer.from('old'); entry.facts = { ...entry.facts, sizeBytes: 3n, changeTime: 1n }
      let reads = 0
      native.hook = (operation, handle) => {
        if (operation !== 'read' || !handle || ++reads !== 1) return
        if (mutation === 'truncate') entry.bytes = Buffer.alloc(0)
        else if (mutation === 'grow') entry.bytes = Buffer.from('grown')
        else entry.facts = { ...entry.facts, changeTime: 2n }
      }
      expect(() => storage.readPrivateFile(parent, 'record', 3)).toThrow(/changed/u)
    }
  })
  it('inspects and deletes only the expected retained identity', () => {
    const parent = root(); storage.createPrivateFileExclusive(parent, 'record', Buffer.from('data'))
    const facts = storage.inspectPrivate(parent, 'record')
    expect(facts.complete).toBe(true)
    expect(() => storage.removeOwnedEntry(parent, 'record', { ...facts.identity, fileId: 'f'.repeat(32) })).toThrow(/identity/u)
    expect(Buffer.from(storage.readPrivateFile(parent, 'record', 4)).toString()).toBe('data')
    expect(storage.removeOwnedEntry(parent, 'record', facts.identity)).toEqual({ deletion: 'pending', identity: facts.identity })
    expect(() => storage.inspectPrivate(parent, 'record')).toThrow(/not-found/u)
  })
  it('rejects shared memory before mutation', () => {
    const parent = root()
    expect(() => storage.createPrivateFileExclusive(parent, 'record', new Uint8Array(new SharedArrayBuffer(4)))).toThrow(/shared input memory/u)
    expect(native.events).not.toContain('write')
  })
})

describe('truthful publication receipts', () => {
  it('uses whole-file create and replacement with pre/post flush and no successful cleanup', () => {
    const parent = root()
    const first = storage.createPrivateFileExclusive(parent, 'record', Buffer.from('old'))
    const second = storage.replacePrivateFile(parent, 'record', Buffer.from('new'))
    expect(first).toMatchObject({ publication: 'published', durability: 'synced', phase: 'complete', cleanup: 'not-needed' })
    expect(second.identity).not.toEqual(first.identity)
    expect(native.events.filter(value => value === 'flush')).toHaveLength(4)
    expect(native.events).not.toContain('remove')
    expect(() => storage.createPrivateFileExclusive(parent, 'record', Buffer.from('other'))).toThrow(/collision/u)
    expect(Buffer.from(storage.readPrivateFile(parent, 'record', 3)).toString()).toBe('new')
  })
  it.each(['create', 'write', 'first-flush', 'rename-failed', 'rename-uncertain', 'second-flush', 'verify', 'close'] as const)('preserves %s failure state', (boundary) => {
    const parent = root()
    let flushes = 0, renamed = false, failed = false
    native.hook = (operation, handle) => {
      if (operation === 'flush') flushes++
      const match = boundary === 'create' ? operation === 'open:create'
        : boundary === 'write' ? operation === 'write'
          : boundary === 'first-flush' ? operation === 'flush' && flushes === 1
            : boundary.startsWith('rename') ? operation === 'rename'
              : boundary === 'second-flush' ? operation === 'flush' && flushes === 2
                : boundary === 'verify' ? renamed && operation === 'open:inspect'
                  : operation === 'close' && handle !== undefined && native.entry(handle).name === 'record'
      if (operation === 'rename') renamed = true
      if (match && !failed) {
        failed = true
        if (boundary === 'rename-uncertain') {
          native.hook = (subsequent) => { if (subsequent === 'open:inspect') throw new Error('reconciliation unavailable') }
          throw new Error('uncertain native invocation')
        }
        throw new PrivateStorageError('native', 'synthetic fault', boundary === 'rename-failed' ? { nativeStatus: 0xC0000022 } : {})
      }
    }
    try { storage.createPrivateFileExclusive(parent, 'record', Buffer.from('complete')); expect.unreachable() }
    catch (error) {
      expect(error).toBeInstanceOf(PrivateStorageError)
      const receipt = (error as PrivateStorageError).receipt!
      expect(receipt.publication).toBe(['second-flush', 'verify', 'close'].includes(boundary) ? 'published' : boundary === 'rename-uncertain' ? 'indeterminate' : 'not-published')
      if (receipt.publication !== 'not-published') expect(native.events).not.toContain('remove')
      if (boundary === 'second-flush') expect(receipt.durability).toBe('unconfirmed')
      expect(receipt.parentIdentity).toEqual(parent.identity)
    }
  })
  it('retains the original failure when created-object cleanup fails', () => {
    const parent = root()
    native.hook = (operation) => { if (operation === 'write') throw new PrivateStorageError('limit', 'write fault'); if (operation === 'remove') throw new Error('cleanup fault') }
    try { storage.createPrivateFileExclusive(parent, 'record', Buffer.from('x')); expect.unreachable() }
    catch (error) { expect(error).toMatchObject({ code: 'limit', receipt: { publication: 'not-published', cleanup: 'failed' } }) }
  })
  it('rejects nonprivate object admission, readonly and wrong-type targets', () => {
    const parent = root(); native.add(2n, 'directory', 'directory')
    expect(() => storage.replacePrivateFile(parent, 'directory', Buffer.alloc(0))).toThrow(/identity/u)
    const id = native.add(2n, 'readonly', 'file')
    const entry = native.entries.get(id)!
    entry.facts = { ...entry.facts, attributes: 1 }
    expect(() => storage.replacePrivateFile(parent, 'readonly', Buffer.alloc(0))).toThrow(/unsupported/u)
    native.hook = (operation, handle) => { if (operation === 'inspect' && handle && native.entry(handle).name === 'readonly') throw new PrivateStorageError('privacy', 'public DACL') }
    expect(() => storage.replacePrivateFile(parent, 'readonly', Buffer.alloc(0))).toThrow(/privacy/u)
  })
})

describe('cooperatively locked bounded tree audit', () => {
  it('checks all descendants under the same live lease', () => {
    const parent = root(); native.add(2n, 'child', 'directory'); native.add(3n, 'file', 'file')
    const lease = storage.acquirePrivateWriterLease(parent, 'writer.lock'); leases.push(lease)
    expect(storage.auditPrivateTree(parent, { maxEntries: 3, maxDepth: 1 }, lease)).toEqual({ complete: true, entries: 3 })
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 2, maxDepth: 1 }, lease)).toThrow(/limit/u)
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 3, maxDepth: 0 }, lease)).toThrow(/limit/u)
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 0, maxDepth: 0 }, lease)).toThrow(/limit/u)
    lease.release()
    expect(() => storage.auditPrivateTree(parent, { maxEntries: 3, maxDepth: 1 }, lease)).toThrow(/closed/u)
  })
})
