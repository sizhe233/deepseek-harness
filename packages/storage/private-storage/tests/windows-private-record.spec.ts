/** Synthetic Windows private-record resources; these checks do not execute the Windows kernel. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrivateStorageError } from '../src/error.ts'
import { readBoundedPrivateRecord } from '../src/private-record-reader.ts'
import { openWindowsPrivateRecordResource } from '../src/windows-private-record.ts'
import { FakeNative } from './fake-native.ts'
import type { WindowsWriterParent } from '../src/windows-stream-writer.ts'

class RecordNative extends FakeNative {
  override inspectSource(handle: bigint) {
    const { ownerSid: _owner, daclProtected: _protected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
}
function fixture(bytes = Buffer.from('current record')) {
  const native = new RecordNative()
  native.add(2n, 'current.json', 'file', bytes)
  const handle = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
  const directory = native.open(handle, 'private', 'directory', 'inspect')
  let released = false
  const parent: WindowsWriterParent = { api: native.asNative(), sid: native.sid, handle: directory,
    identity: native.inspect(directory).identity,
    validate() { if (released) throw new PrivateStorageError('closed', 'parent released'); native.inspect(directory) },
    release() { if (released) return; released = true; native.close(directory); native.close(handle) },
  }
  return { native, parent, bytes }
}

describe('Windows private record resource', () => {
  it('returns bytes and digest from the same admitted source and releases all retained handles', () => {
    const { native, parent, bytes } = fixture()
    const result = readBoundedPrivateRecord(1024, () => openWindowsPrivateRecordResource(parent, 'current.json'))
    expect(Buffer.from(result.bytes)).toEqual(bytes)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.source.observations).toMatchObject({ daclProtected: true, links: 1 })
    expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('write'); expect(native.events).not.toContain('remove')
  })
  it('rejects excess input before returning a partial record and keeps the original intact', () => {
    const { native, parent, bytes } = fixture()
    expect(() => readBoundedPrivateRecord(1, () => openWindowsPrivateRecordResource(parent, 'current.json'))).toThrow()
    expect([...native.entries.values()].find(entry => entry.name === 'current.json')!.bytes).toEqual(bytes)
    expect(native.handles.size).toBe(0)
  })
  it('denies an independent delete open while reading and permits it only after release', () => {
    const { native, parent } = fixture()
    const reader = openWindowsPrivateRecordResource(parent, 'current.json')
    expect(() => native.open(parent.handle, 'current.json', 'file', 'delete')).toThrow(expect.objectContaining({ win32Code: 32 }))
    reader.close(); reader.close()
    const root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
    const directory = native.open(root, 'private', 'directory', 'inspect')
    const deleted = native.open(directory, 'current.json', 'file', 'delete')
    native.close(deleted); native.close(directory); native.close(root)
    expect(native.handles.size).toBe(0)
  })
  it('rejects metadata drift during native read without returning bytes', () => {
    const { native, parent } = fixture()
    const reader = openWindowsPrivateRecordResource(parent, 'current.json')
    native.hook = (operation, handle) => {
      if (operation === 'read' && handle !== undefined) native.entry(handle).facts = { ...native.entry(handle).facts, changeTime: native.entry(handle).facts.changeTime + 1n }
    }
    expect(() => reader.read(3)).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
    native.hook = () => {}; reader.close()
    expect(native.handles.size).toBe(0)
  })
  it('retains the original admission error when its close acknowledgement is lost', () => {
    const { native, parent } = fixture()
    let closed = 0
    native.hook = (operation, handle) => {
      if (handle === undefined || native.entry(handle).name !== 'current.json') return
      if (operation === 'inspect') throw new PrivateStorageError('privacy', 'bad ACL', { win32Code: 5 })
      if (operation === 'close') { closed++; native.handles.delete(handle); throw new PrivateStorageError('native', 'lost close', { win32Code: 6 }) }
    }
    expect(() => openWindowsPrivateRecordResource(parent, 'current.json')).toThrow(expect.objectContaining({ code: 'privacy', win32Code: 5, cleanupFailed: true }))
    expect(closed).toBe(1); expect(native.handles.size).toBe(0)
  })
  it('rejects invalid components before opening a source and still releases the retained parent', () => {
    const { native, parent } = fixture()
    expect(() => openWindowsPrivateRecordResource(parent, '../outside')).toThrow(expect.objectContaining({ code: 'name' }))
    expect(native.handles.size).toBe(0)
  })
  it('rejects every closed resource operation without a further native call', () => {
    const { native, parent } = fixture(), resource = openWindowsPrivateRecordResource(parent, 'current.json')
    resource.close(); const before = [...native.events]
    expect(() => resource.inspect()).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(() => resource.read(1)).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(() => resource.observeRetired()).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(native.events).toEqual(before)
  })
  it.each(['kind', 'links', 'volume', 'identity', 'size-limit', 'negative-size'])(
    'rejects retained private record drift before returning bytes: %s', (change) => {
      const { native, parent } = fixture(), resource = openWindowsPrivateRecordResource(parent, 'current.json')
      const entry = [...native.entries.values()].find(value => value.name === 'current.json')!
      const facts = entry.facts
      entry.facts = { ...facts,
        ...(change === 'kind' ? { kind: 'directory' as const } : {}), ...(change === 'links' ? { links: 2 } : {}),
        ...(change === 'volume' ? { identity: { ...facts.identity, volumeSerial: 'f'.repeat(16) } } : {}),
        ...(change === 'identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}),
      }
      if (change === 'size-limit' || change === 'negative-size') {
        const inspect = native.inspect.bind(native)
        native.inspect = handle => ({ ...inspect(handle), ...native.entry(handle).name === 'current.json'
          ? { sizeBytes: change === 'size-limit' ? BigInt(Number.MAX_SAFE_INTEGER) + 1n : -1n } : {} })
      }
      expect(() => resource.inspect()).toThrow()
      expect(native.events).not.toContain('read'); resource.close()
      expect(native.handles.size).toBe(0)
    },
  )
  it.each(['identity', 'sizeBytes', 'links', 'attributes', 'lastWriteTime', 'changeTime'])(
    'rejects disagreement between the private and source observation: %s', (field) => {
      const { native, parent } = fixture(), source = native.inspectSource.bind(native)
      native.inspectSource = (handle) => {
        const facts = source(handle)
        if (native.entry(handle).name !== 'current.json') return facts
        return { ...facts, ...(field === 'identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}),
          ...(field === 'sizeBytes' ? { sizeBytes: facts.sizeBytes + 1n } : {}), ...(field === 'links' ? { links: 2 } : {}),
          ...(field === 'attributes' ? { attributes: facts.attributes + 1 } : {}),
          ...(field === 'lastWriteTime' ? { lastWriteTime: facts.lastWriteTime + 1n } : {}),
          ...(field === 'changeTime' ? { changeTime: facts.changeTime + 1n } : {}) }
      }
      expect(() => openWindowsPrivateRecordResource(parent, 'current.json')).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
      expect(native.handles.size).toBe(0)
    },
  )
})
