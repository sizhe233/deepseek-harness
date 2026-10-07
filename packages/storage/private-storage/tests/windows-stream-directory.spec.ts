/** Retained enumeration models; native platform execution remains separate. */
import { describe, expect, it } from 'vitest'
import { inspectWindowsPrivateStreamDirectory, listWindowsPrivateStreamDirectory } from '../src/windows-stream-directory.ts'
import { FakeNative } from './fake-native.ts'
import type { WindowsWriterParent } from '../src/windows-stream-writer.ts'
import { PrivateStorageError } from '../src/error.ts'
class DirectoryNative extends FakeNative {
  override inspectSource(handle: bigint) {
    const { ownerSid: _owner, daclProtected: _protected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
}
function fixture() {
  const native = new DirectoryNative()
  const root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
  const directory = native.open(root, 'private', 'directory', 'inspect')
  let closed = false
  const parent: WindowsWriterParent = { api: native.asNative(), sid: native.sid, handle: directory,
    identity: native.inspect(directory).identity,
    validate() { if (closed) throw new PrivateStorageError('closed', 'directory closed'); native.inspect(directory) },
    release() { if (closed) return; closed = true; native.close(directory); native.close(root) },
  }
  return { native, parent }
}
describe('Windows retained complete directory observations', () => {
  it('lists all current names and full identities without claiming leaf admission', () => {
    const { native, parent } = fixture()
    native.add(2n, 'record.bin', 'file', Buffer.from('record'))
    native.add(2n, 'child', 'directory')
    const result = listWindowsPrivateStreamDirectory(parent, 2)
    expect(result).toMatchObject({ complete: true, before: { privateVerified: true }, after: { privateVerified: true } })
    expect(result.before.changeToken).toBe(result.after.changeToken)
    expect(result.entries.map(entry => [entry.name, entry.kind])).toEqual([['record.bin', 'file'], ['child', 'directory']])
    for (const entry of result.entries) { expect(entry.identity.backend).toBe('windows-ntfs'); expect(entry).not.toHaveProperty('privateVerified') }
    expect(native.handles.size).toBe(0)
  })
  it('fails a complete enumeration ceiling rather than returning a truncated inventory', () => {
    const { native, parent } = fixture()
    native.add(2n, 'one', 'file'); native.add(2n, 'two', 'file')
    expect(() => listWindowsPrivateStreamDirectory(parent, 1)).toThrow(expect.objectContaining({ code: 'limit' }))
    expect(native.handles.size).toBe(0)
  })
  it('rejects a directory observation change during enumeration and releases its parent', () => {
    const { native, parent } = fixture()
    native.hook = (operation, handle) => {
      if (operation === 'names' && handle !== undefined) {
        const entry = native.entry(handle)
        entry.facts = { ...entry.facts, changeTime: entry.facts.changeTime + 1n }
      }
    }
    expect(() => listWindowsPrivateStreamDirectory(parent, 1)).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(native.handles.size).toBe(0)
  })
  it('rejects case-colliding entries before a consumer can treat them as separate files', () => {
    const { native, parent } = fixture()
    native.add(2n, 'Record', 'file'); native.add(2n, 'record', 'file')
    expect(() => listWindowsPrivateStreamDirectory(parent, 2)).toThrow(expect.objectContaining({ code: 'name' }))
    expect(native.handles.size).toBe(0)
  })
  it('rejects invalid limits before enumeration and consumes its supplied owned parent', () => {
    const { native, parent } = fixture()
    expect(() => listWindowsPrivateStreamDirectory(parent, 100_001)).toThrow(RangeError)
    expect(native.events).not.toContain('names'); expect(native.handles.size).toBe(0)
  })
  it('rejects a child from another volume and closes both child and retained parent', () => {
    const { native, parent } = fixture(), id = native.add(2n, 'child', 'file')
    const entry = native.entries.get(id)!
    entry.facts = { ...entry.facts, identity: { ...entry.facts.identity, volumeSerial: 'f'.repeat(16) } }
    expect(() => listWindowsPrivateStreamDirectory(parent, 1)).toThrow(/child volume changed/u)
    expect(native.handles.size).toBe(0)
  })
  it.each(['kind', 'links', 'identity', 'write-time', 'change-time', 'attributes'])(
    'refuses inconsistent retained directory observations and releases ownership: %s', (field) => {
      const { native, parent } = fixture(), inspect = native.inspectSource.bind(native)
      native.inspectSource = (handle) => {
        const facts = inspect(handle)
        return { ...facts, ...(field === 'kind' ? { kind: 'file' as const } : {}), ...(field === 'links' ? { links: 0 } : {}),
          ...(field === 'identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}),
          ...(field === 'write-time' ? { lastWriteTime: facts.lastWriteTime + 1n } : {}),
          ...(field === 'change-time' ? { changeTime: facts.changeTime + 1n } : {}),
          ...(field === 'attributes' ? { attributes: facts.attributes + 1 } : {}) }
      }
      expect(() => inspectWindowsPrivateStreamDirectory(parent)).toThrow(/observations changed/u)
      expect(native.handles.size).toBe(0)
    },
  )
})
