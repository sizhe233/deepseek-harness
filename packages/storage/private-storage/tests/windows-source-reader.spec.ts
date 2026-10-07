/** Source lifetime and observation tests use synthetic handles, never a native conformance claim. */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNative } from './fake-native.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { NativeStorageBackend as NativeStorage } from '../src/native.ts'
import { openWindowsSourceDirectory, inspectWindowsSourceFile, openWindowsSourceFileReader,
  openWindowsSourceChild, listWindowsSourceDirectory, inspectWindowsSourceLink, inspectWindowsSourceDirectory } from '../src/windows-source-reader.ts'
import type { SourceLinkObservation } from '../src/source-link.ts'

const selected = vi.hoisted(() => ({ api: undefined as unknown as NativeStorage }))
vi.mock('../src/native.ts', async original => ({ ...await original<object>(), loadNativeStorage: () => selected.api }))
class SourceFakeNative extends FakeNative {
  security = 'a'.repeat(64)
  sourceFlags = 8
  override inspectSource(handle: bigint) {
    const { ownerSid: _ownerSid, daclProtected: _daclProtected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: this.security }
  }
  override admitSourceFilesystem(handle: bigint) {
    this.event('source-filesystem', handle)
    return { filesystem: 'NTFS' as const, flags: this.sourceFlags, deviceType: 7 as const, deviceCharacteristics: 0 }
  }
}
let native: SourceFakeNative
beforeEach(() => { native = new SourceFakeNative(); native.add(2n, 'source.bin', 'file', Buffer.from('abcXYZ!')); selected.api = native.asNative() })
const expected = (source: ReturnType<typeof inspectWindowsSourceFile>) => ({ expectedIdentity: source.identity,
  expectedBytes: source.sizeBytes, expectedSha256: createHash('sha256').update('abcXYZ!').digest('hex') })

describe('retained readonly Windows source adapter (synthetic native model)', () => {
  it('opens a readonly child with independently retained ancestors and completely lists ordinary source names', () => {
    const childId = native.add(2n, 'package', 'directory')
    native.add(childId, 'asset.bin', 'file', Buffer.from('abcXYZ!'))
    const directory = openWindowsSourceDirectory('C:\\private'), child = openWindowsSourceChild(directory, 'package')
    const rootList = listWindowsSourceDirectory(directory, 2)
    expect(rootList).toMatchObject({ complete: true, admission: 'complete' })
    expect(rootList.entries.map(entry => [entry.name, entry.kind])).toEqual([['source.bin', 'file'], ['package', 'directory']])
    expect(rootList.before).not.toHaveProperty('privateVerified')
    directory.close()
    const listed = listWindowsSourceDirectory(child, 1)
    const sourceIdentity: unknown = expect.objectContaining({ backend: 'windows-ntfs' })
    expect(listed.entries).toEqual([{ name: 'asset.bin', kind: 'file', identity: sourceIdentity }])
    expect(listed.before.changeToken).toBe(listed.after.changeToken)
    expect(inspectWindowsSourceFile(child, 'asset.bin').sizeBytes).toBe(7)
    child.close(); expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('write'); expect(native.events).not.toContain('remove')
  })
  it('reports a refused source entry without inventing its identity, target or copy authority', () => {
    native.add(2n, 'unadmitted.bin', 'file')
    const directory = openWindowsSourceDirectory('C:\\private')
    native.hook = (operation, handle) => {
      if (operation === 'inspect' && handle !== undefined && native.entry(handle).name === 'unadmitted.bin') {
        throw new PrivateStorageError('unsupported', 'native reparse refusal', { nativeStatus: 0xc000050b })
      }
    }
    const listed = listWindowsSourceDirectory(directory, 2)
    expect(listed.complete).toBe(true); expect(listed.admission).toBe('unadmitted-entries')
    expect(listed.entries[1]).toEqual({ name: 'unadmitted.bin', kind: 'unadmitted', identity: null,
      reason: 'private-storage: native reparse refusal (unsupported)', nativeStatus: 0xc000050b, win32Code: null })
    native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
  })
  it('fails the whole source listing on an unconfirmed temporary close instead of returning an unadmitted success', () => {
    const directory = openWindowsSourceDirectory('C:\\private')
    native.hook = (operation, handle) => {
      if (handle === undefined || native.entry(handle).name !== 'source.bin') return
      if (operation === 'inspect') throw new PrivateStorageError('unsupported', 'source refused')
      if (operation === 'close') { native.handles.delete(handle); throw new PrivateStorageError('native', 'lost close', { win32Code: 6 }) }
    }
    expect(() => listWindowsSourceDirectory(directory, 1)).toThrow(expect.objectContaining({ cleanupFailed: true }))
    native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
  })
  it.each(['changed', 'duplicate', 'cross-volume', 'invalid-limit'])(
    'refuses incomplete or inconsistent source inventory: %s', (change) => {
      const directory = openWindowsSourceDirectory('C:\\private')
      if (change === 'duplicate') native.add(2n, 'SOURCE.bin', 'file')
      if (change === 'cross-volume') {
        const entry = [...native.entries.values()].find(value => value.name === 'source.bin')!
        entry.facts = { ...entry.facts, identity: { ...entry.facts.identity, volumeSerial: 'f'.repeat(16) } }
      }
      if (change === 'changed') native.hook = (operation, handle) => {
        if (operation === 'names' && handle !== undefined) {
          const entry = native.entry(handle); entry.facts = { ...entry.facts, changeTime: entry.facts.changeTime + 1n }
        }
      }
      expect(() => listWindowsSourceDirectory(directory, change === 'invalid-limit' ? 100001 : 2)).toThrow()
      native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
    },
  )
  it('rejects cross-volume children, foreign capabilities and closed parents without consuming caller ownership', () => {
    const childId = native.add(2n, 'child', 'directory'), entry = native.entries.get(childId)!
    entry.facts = { ...entry.facts, identity: { ...entry.facts.identity, volumeSerial: 'f'.repeat(16) } }
    const directory = openWindowsSourceDirectory('C:\\private')
    expect(() => openWindowsSourceChild(directory, 'child')).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
    expect(() => openWindowsSourceChild({ ...directory }, 'child')).toThrow(/another provider/u)
    expect(() => openWindowsSourceChild(directory, '../outside')).toThrow(expect.objectContaining({ code: 'name' }))
    directory.close()
    expect(() => openWindowsSourceChild(directory, 'child')).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(native.handles.size).toBe(0)
  })
  it('reads distinct sequential chunks after the caller closes its directory and preserves original bytes', () => {
    const directory = openWindowsSourceDirectory('C:\\private')
    const source = inspectWindowsSourceFile(directory, 'source.bin')
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(source))
    directory.close()
    expect(Buffer.from(reader.readChunk(3)).toString()).toBe('abc')
    expect(Buffer.from(reader.readChunk(3)).toString()).toBe('XYZ')
    expect(Buffer.from(reader.readChunk(3)).toString()).toBe('!')
    expect(reader.readChunk(3)).toHaveLength(0)
    const receipt = reader.finish()
    expect(receipt).toMatchObject({ verification: 'verified', observations: 'unchanged', observedBytes: 7, release: 'released' })
    const events = [...native.events]
    expect(reader.finish()).toEqual(receipt); reader.close(); directory.close()
    expect(native.events).toEqual(events)
    expect([...native.entries.values()].find(entry => entry.name === 'source.bin')?.bytes.toString()).toBe('abcXYZ!')
    expect(native.events).not.toContain('write'); expect(native.events).not.toContain('remove'); expect(native.events).not.toContain('rename')
    expect(native.handles.size).toBe(0)
  })
  it('observes hardlinks and readonly source metadata without repairing it', () => {
    const entry = [...native.entries.values()].find(entry => entry.name === 'source.bin')!
    entry.facts = { ...entry.facts, links: 3, attributes: 1 }
    native.sourceFlags = 0x80008
    const directory = openWindowsSourceDirectory('C:\\private')
    const facts = inspectWindowsSourceFile(directory, 'source.bin')
    expect(facts.links).toBe(3)
    expect(facts.observations).toMatchObject({ attributes: 1, filesystemFlags: 0x80008 })
    expect(facts.observations).not.toHaveProperty('ownerOnly')
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
    reader.readChunk(7); expect(reader.finish().verification).toBe('verified')
    directory.close()
    expect(entry.facts.links).toBe(3); expect(entry.facts.attributes).toBe(1)
  })
  it.each(['size', 'mtime', 'ctime', 'links', 'identity', 'security', 'parent-security', 'volume'] as const)('rejects changed %s observations without returning another chunk', (change) => {
    const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
    reader.readChunk(2)
    const entry = [...native.entries.values()].find(entry => entry.name === 'source.bin')!
    if (change === 'size') entry.facts = { ...entry.facts, sizeBytes: 8n }
    if (change === 'mtime') entry.facts = { ...entry.facts, lastWriteTime: 9n }
    if (change === 'ctime') entry.facts = { ...entry.facts, changeTime: 9n }
    if (change === 'links') entry.facts = { ...entry.facts, links: 2 }
    if (change === 'identity') entry.facts = { ...entry.facts, identity: { ...entry.facts.identity, fileId: 'f'.repeat(32) } }
    if (change === 'security' || change === 'parent-security') native.security = 'b'.repeat(64)
    if (change === 'volume') native.sourceFlags = 0x80008
    expect(() => reader.readChunk(2)).toThrow()
    expect(reader.receipt.verification).toBe('failed')
    directory.close(); expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('write')
  })
  it('rejects same-size hidden rewrites through the final manifest digest even if metadata is unchanged', () => {
    const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
    const entry = [...native.entries.values()].find(entry => entry.name === 'source.bin')!
    entry.bytes = Buffer.from('different').subarray(0, 7)
    reader.readChunk(7)
    expect(() => reader.finish()).toThrow()
    expect(reader.receipt.verification).toBe('failed')
    directory.close()
  })
  it('rejects a renamed source and foreign cloned directory before it can redirect reads', () => {
    const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
    expect(() => openWindowsSourceFileReader({ ...directory }, 'source.bin', expected(facts))).toThrow(/another provider/u)
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
    const entry = [...native.entries.values()].find(entry => entry.name === 'source.bin')!
    entry.name = 'moved.bin'
    native.add(2n, 'source.bin', 'file', Buffer.from('lookalike'))
    expect(() => reader.readChunk(2)).toThrow(expect.objectContaining({ code: 'name' }))
    expect(reader.receipt).toMatchObject({ verification: 'failed', observedBytes: 0 })
    directory.close()
    expect(entry.bytes.toString()).toBe('abcXYZ!')
  })
  it('admits a drive-root source while preserving literal component and file-kind checks', () => {
    const directory = openWindowsSourceDirectory('C:\\')
    const cause: unknown = expect.objectContaining({ code: 'identity' })
    expect(() => inspectWindowsSourceFile(directory, 'private')).toThrow(expect.objectContaining({ name: 'SourceObservationError', cause }))
    expect(() => inspectWindowsSourceFile(directory, '../private')).toThrow(/literal/u)
    directory.close()
    expect(native.handles.size).toBe(0)
  })
  it('requires exact planned identity and owned chunk bounds before native reading', () => {
    const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
    expect(() => openWindowsSourceFileReader(directory, 'source.bin', { ...expected(facts), expectedIdentity: { backend: 'windows-ntfs', volumeSerial: '0'.repeat(16), fileId: '0'.repeat(32) } })).toThrow()
    const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
    expect(() => reader.readChunk(1024 * 1024 + 1)).toThrow()
    expect(native.events).not.toContain('read')
    directory.close(); expect(native.handles.size).toBe(0)
  })
})


it('records a proven change during the native read instead of unchanged observations', () => {
  const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
  const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
  native.hook = (operation, handle) => {
    if (operation === 'read' && handle !== undefined) native.entry(handle).facts = { ...native.entry(handle).facts, changeTime: 99n }
  }
  expect(() => reader.readChunk(3)).toThrow(expect.objectContaining({ code: 'changed' }))
  expect(reader.receipt).toMatchObject({ observations: 'failed', verification: 'failed' })
  directory.close(); expect(native.handles.size).toBe(0)
})

it('leaves observation verification unconfirmed for an ordinary native I/O error', () => {
  const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
  const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
  native.hook = (operation) => { if (operation === 'read') throw new PrivateStorageError('native', 'read failed', { win32Code: 5 }) }
  expect(() => reader.readChunk(3)).toThrow(expect.objectContaining({ win32Code: 5 }))
  expect(reader.receipt).toMatchObject({ observations: 'unverified', verification: 'failed' })
  directory.close()
})

it('preserves provisional inspection failure when its one close attempt also fails', () => {
  const directory = openWindowsSourceDirectory('C:\\private')
  let inspections = 0, closing = 0
  native.hook = (operation, handle) => {
    if (handle === undefined || native.entry(handle).name !== 'source.bin') return
    if (operation === 'inspect' && ++inspections === 2) throw new PrivateStorageError('changed', 'inspection failed', { win32Code: 5 })
    if (operation === 'close') { closing++; native.handles.delete(handle); throw new PrivateStorageError('native', 'close return lost', { win32Code: 6 }) }
  }
  expect(() => inspectWindowsSourceFile(directory, 'source.bin')).toThrow(expect.objectContaining({ code: 'changed', win32Code: 5, cleanupFailed: true }))
  native.hook = () => {}
  directory.close(); expect(closing).toBe(1); expect(native.handles.size).toBe(0)
})

it('returns separately owned bounded chunk backing memory', () => {
  const directory = openWindowsSourceDirectory('C:\\private'), facts = inspectWindowsSourceFile(directory, 'source.bin')
  const reader = openWindowsSourceFileReader(directory, 'source.bin', expected(facts))
  const first = reader.readChunk(2), second = reader.readChunk(2)
  expect(first.buffer).not.toBe(second.buffer)
  expect(first.buffer.byteLength).toBe(2)
  expect(second.buffer.byteLength).toBe(2)
  reader.close(); directory.close()
})

it('preserves a non-Error release cause while attempting every owned ancestor exactly once', () => {
  const directory = openWindowsSourceDirectory('C:\\private')
  const cause = { syntheticReleaseFailure: true }
  let calls = 0
  native.hook = (operation, handle) => {
    if (operation === 'close' && handle !== undefined) { calls++; native.handles.delete(handle); throw cause }
  }
  expect(() =>{  directory.close() }).toThrow(expect.objectContaining({ code: 'native', cause }))
  directory.close()
  expect(calls).toBe(2); expect(native.handles.size).toBe(0)
})

it.each(['name', 'native'] as const)('preserves %s failures from a retained source ancestor', (code) => {
  const directory = openWindowsSourceDirectory('C:\\private')
  const failure = new PrivateStorageError(code, 'ancestor verification failed')
  native.hook = (operation, handle) => {
    if (operation === 'name' && handle !== undefined && native.entry(handle).name === 'private') throw failure
  }
  expect(() => inspectWindowsSourceFile(directory, 'source.bin')).toThrow(code === 'name'
    ? expect.objectContaining({ name: 'SourceObservationError', cause: failure }) : failure)
  native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
})

it('refuses a changed TokenUser before opening a source file', () => {
  const directory = openWindowsSourceDirectory('C:\\private')
  native.sid[0] = native.sid[0]! ^ 1
  const count = native.events.filter(event => event === 'open:read-source').length
  expect(() => inspectWindowsSourceFile(directory, 'source.bin')).toThrow(expect.objectContaining({ code: 'privacy' }))
  expect(native.events.filter(event => event === 'open:read-source')).toHaveLength(count)
  directory.close(); expect(native.handles.size).toBe(0)
})

it.each([-1n, 9007199254740992n])('refuses an unrepresentable native source size: %s', (sizeBytes) => {
  const directory = openWindowsSourceDirectory('C:\\private'), entry = [...native.entries.values()].find(value => value.name === 'source.bin')!
  entry.facts = { ...entry.facts, sizeBytes }
  expect(() => inspectWindowsSourceFile(directory, 'source.bin')).toThrow(expect.objectContaining({ code: 'limit' }))
  directory.close(); expect(native.handles.size).toBe(0)
})

it('preserves a non-name native leaf verification failure without calling it a changed observation', () => {
  const directory = openWindowsSourceDirectory('C:\\private'), failure = new PrivateStorageError('native', 'leaf query failed')
  native.hook = (operation, handle) => {
    if (operation === 'name' && handle !== undefined && native.entry(handle).name === 'source.bin') throw failure
  }
  expect(() => inspectWindowsSourceFile(directory, 'source.bin')).toThrow(failure)
  native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
})

it.each(['kind', 'volume'] as const)('releases a root chain rejected by native %s observations', (change) => {
  const entry = native.entries.get(2n)!
  entry.facts = { ...entry.facts, ...(change === 'kind' ? { kind: 'file' as const }
    : { identity: { ...entry.facts.identity, volumeSerial: 'f'.repeat(16) } }) }
  expect(() => openWindowsSourceDirectory('C:\\private')).toThrow(expect.objectContaining({ code: 'identity' }))
  expect(native.handles.size).toBe(0)
})

it('releases a retained source child when a post-open ancestor query fails', () => {
  native.add(2n, 'child', 'directory')
  const directory = openWindowsSourceDirectory('C:\\private')
  let childAdmitted = false
  native.hook = (operation, handle) => {
    if (operation === 'name' && handle !== undefined && native.entry(handle).name === 'child') childAdmitted = true
    if (operation === 'token' && childAdmitted) throw new PrivateStorageError('native', 'post-open token query failed')
  }
  expect(() => openWindowsSourceChild(directory, 'child')).toThrow(expect.objectContaining({ code: 'native' }))
  expect(native.handles.size).toBe(2)
  native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
})

it('rejects a directory observation without a live link count', () => {
  const directory = openWindowsSourceDirectory('C:\\private'), entry = native.entries.get(2n)!
  entry.facts = { ...entry.facts, links: 0 }
  expect(() => inspectWindowsSourceDirectory(directory)).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
  directory.close(); expect(native.handles.size).toBe(0)
})

it.each(['unchanged', 'changed', 'native-error'] as const)('keeps no-follow link results conditional on stable parent observations: %s', (mode) => {
  const directory = openWindowsSourceDirectory('C:\\private')
  const facts = { identity: { backend: 'windows-ntfs' as const, volumeSerial: '0000000000000001', fileId: '3'.padStart(32, '0') },
    links: 1, changeToken: 'a'.repeat(64), observations: {} }
  const result: SourceLinkObservation = { kind: 'symbolic-link', literalTarget: '../bin.js', relative: true, before: facts, after: facts }
  selected.api.observeLink = (parent, name, maximum) => {
    expect(native.id(parent)).toBe(2n); expect(name).toBe('bin'); expect(maximum).toBe(32768)
    if (mode === 'native-error') throw new PrivateStorageError('unsupported', 'not a supported link')
    if (mode === 'changed') { const entry = native.entry(parent); entry.facts = { ...entry.facts, changeTime: 99n } }
    return result
  }
  if (mode === 'unchanged') expect(inspectWindowsSourceLink(directory, 'bin', 32768)).toBe(result)
  else expect(() => inspectWindowsSourceLink(directory, 'bin', 32768)).toThrow(expect.objectContaining({
    name: mode === 'changed' ? 'SourceObservationError' : 'PrivateStorageError' }))
  expect(native.handles.size).toBe(2); directory.close(); expect(native.handles.size).toBe(0)
})

it('retains native refusal status fields for an explicitly unadmitted inventory entry', () => {
  const directory = openWindowsSourceDirectory('C:\\private')
  native.hook = (operation, handle) => {
    if (operation === 'inspect' && handle !== undefined && native.entry(handle).name === 'source.bin') {
      throw new PrivateStorageError('unsupported', 'source refused', { win32Code: 50 })
    }
  }
  expect(listWindowsSourceDirectory(directory, 1).entries[0]).toMatchObject({ kind: 'unadmitted', nativeStatus: null, win32Code: 50 })
  native.hook = () => {}; directory.close(); expect(native.handles.size).toBe(0)
})
