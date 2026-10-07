/** Generated-record transaction models, with no native Windows acceptance claim. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createBoundedControlRecordWriter } from '../src/control-record.ts'
import { openWindowsControlRecordResource } from '../src/windows-control-record.ts'
import { openWindowsPrivateRecordResource } from '../src/windows-private-record.ts'
import { readBoundedPrivateRecord } from '../src/private-record-reader.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { WindowsWriterParent } from '../src/windows-stream-writer.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import { FakeNative } from './fake-native.ts'
class ControlNative extends FakeNative {
  override inspectSource(handle: bigint) {
    const { ownerSid: _owner, daclProtected: _protected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
  inspectRetiredPrivate(handle: bigint) {
    const facts = this.inspectSource(handle)
    const retired = !this.entries.has(this.id(handle))
    return { ...facts, links: retired ? 0 : facts.links, deletePending: retired }
  }
}
function fixture() {
  const native = new ControlNative()
  native.add(2n, 'current.json', 'file', Buffer.from('revision-one'))
  let held = true
  const retain = (): WindowsWriterParent => {
    const root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
    const directory = native.open(root, 'private', 'directory', 'inspect')
    let closed = false
    return { api: native.asNative(), sid: native.sid, handle: directory, identity: native.inspect(directory).identity,
      validate() { if (closed) throw new PrivateStorageError('closed', 'closed parent'); native.inspect(directory) },
      release() { if (closed) return; closed = true; native.close(directory); native.close(root) },
    }
  }
  const current = readBoundedPrivateRecord(100, () => openWindowsPrivateRecordResource(retain(), 'current.json'))
  const next = Buffer.from('revision-two')
  let validations = 0
  const open = () => createBoundedControlRecordWriter('current.json', {
    operationId: 'control-operation' as PrivateStreamOperationId, expectedCurrent: { source: current.source, sha256: current.sha256 },
    expectedBytes: next.length, expectedSha256: createHash('sha256').update(next).digest('hex'),
    validateCurrent(observed) { expect(Buffer.from(observed.bytes).toString()).toBe('revision-one'); validations++; return 'verified' },
  }, 'windows-ntfs-write-through-rename-v1', () => openWindowsControlRecordResource(retain(), 'current.json',
    () => { if (!held) throw new PrivateStorageError('closed', 'lease released') }, retain))
  return { native, open, next, retain, releaseLease: () => { held = false }, validations: () => validations }
}
describe('Windows generated control-record replacement', () => {
  it('verifies the retained old record/revision before staging and observes its retirement separately', () => {
    const { native, open, next, validations } = fixture()
    const writer = open()
    expect(validations()).toBe(1)
    writer.append(next)
    const receipt = writer.finish()
    expect(receipt).toMatchObject({ currentVerification: 'verified', revisionVerification: 'verified', replacementVerification: 'verified',
      staging: { publication: 'published', durability: 'synced', contentVerification: 'verified', release: 'released' }, release: 'released' })
    expect(receipt.replacement?.replacedAfter.observations).toMatchObject({ links: 0, deletePending: true })
    expect([...native.entries.values()].find(entry => entry.name === 'current.json')?.bytes.toString()).toBe('revision-two')
    expect(native.handles.size).toBe(0)
  })
  it('requires the same caller-owned lease again immediately before replacement', () => {
    const { native, open, next, releaseLease } = fixture()
    const writer = open(); writer.append(next); releaseLease()
    const staging: unknown = expect.objectContaining({ publication: 'not-published' })
    const receipt: unknown = expect.objectContaining({ staging, release: 'released' })
    expect(() => writer.finish()).toThrow(expect.objectContaining({ code: 'closed', receipt }))
    expect([...native.entries.values()].find(entry => entry.name === 'current.json')?.bytes.toString()).toBe('revision-one')
    expect(native.events).not.toContain('rename'); expect(native.handles.size).toBe(0)
  })
  it('preserves published state after a lost rename acknowledgement without retrying or deleting the final record', () => {
    const { native, open, next } = fixture(), writer = open()
    writer.append(next)
    const rename = native.rename.bind(native)
    let calls = 0
    native.rename = (...args) => { calls++; rename(...args); throw new PrivateStorageError('native', 'lost rename acknowledgement', { win32Code: 5 }) }
    const staging: unknown = expect.objectContaining({ publication: 'published', durability: 'unconfirmed', cleanup: 'withheld' })
    const receipt: unknown = expect.objectContaining({ staging })
    expect(() => writer.finish()).toThrow(expect.objectContaining({ win32Code: 5, receipt }))
    expect(() => writer.finish()).toThrow()
    expect(calls).toBe(1)
    expect([...native.entries.values()].find(entry => entry.name === 'current.json')?.bytes.toString()).toBe('revision-two')
    expect(native.events).not.toContain('remove'); expect(native.handles.size).toBe(0)
  })
  it('keeps one staging authority and rejects reuse of a closed current-record capability', () => {
    const { native, retain } = fixture(), resource = openWindowsControlRecordResource(retain(), 'current.json', () => {}, retain)
    const staging = resource.createStaging()
    expect(() => resource.createStaging()).toThrow(/already consumed/u)
    expect(() => { staging.syncDirectory() }).toThrow(expect.objectContaining({ code: 'unsupported' }))
    staging.close(); resource.close(); resource.close()
    expect(() => resource.inspectCurrent()).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(native.handles.size).toBe(0)
  })
  it('rejects metadata changes after current-record admission and before creating staging', () => {
    const { native, retain } = fixture(), resource = openWindowsControlRecordResource(retain(), 'current.json', () => {}, retain)
    resource.inspectCurrent()
    const target = [...native.entries.values()].find(entry => entry.name === 'current.json')!
    target.facts = { ...target.facts, changeTime: target.facts.changeTime + 1n }
    expect(() => resource.createStaging()).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
    expect(native.events).not.toContain('rename'); resource.close(); expect(native.handles.size).toBe(0)
  })
  it.each(['parent-kind', 'parent-identity', 'target-binding'])(
    'requires unchanged same-parent binding immediately before replacement: %s', (change) => {
      const { native, open, next } = fixture(), writer = open()
      writer.append(next)
      const source = native.inspectSource.bind(native), inspect = native.inspect.bind(native)
      const admitted = new Set(native.handles.keys())
      native.inspectSource = (handle) => {
        const facts = source(handle)
        if (native.entry(handle).name !== 'private') return facts
        return { ...facts, ...(change === 'parent-kind' ? { kind: 'file' as const } : {}),
          ...(change === 'parent-identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}) }
      }
      native.inspect = (handle) => {
        const facts = inspect(handle)
        return change === 'target-binding' && !admitted.has(handle) && native.entry(handle).name === 'current.json'
          ? { ...facts, identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : facts
      }
      expect(() => writer.finish()).toThrow()
      expect(writer.receipt).toMatchObject({ staging: { publication: 'not-published' } })
      expect(native.events).not.toContain('rename'); expect(native.handles.size).toBe(0)
    },
  )
  it.each(['identity', 'kind', 'size', 'still-linked', 'query-refused'])(
    'keeps publication separate from unconfirmed retirement of the original record: %s', (change) => {
      const { native, open, next } = fixture(), writer = open()
      writer.append(next)
      const retired = native.inspectRetiredPrivate.bind(native)
      native.inspectRetiredPrivate = (handle) => {
        if (change === 'query-refused') throw new PrivateStorageError('native', 'retired query refused', { win32Code: 31 })
        const facts = retired(handle)
        return { ...facts, ...(change === 'identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}),
          ...(change === 'kind' ? { kind: 'directory' as const } : {}), ...(change === 'size' ? { sizeBytes: facts.sizeBytes + 1n } : {}),
          ...(change === 'still-linked' ? { links: 1, deletePending: false } : {}) }
      }
      expect(() => writer.finish()).toThrow()
      expect(writer.receipt).toMatchObject({ staging: { publication: 'published' } })
      expect(writer.receipt.replacementVerification).not.toBe('verified')
      expect(native.events).not.toContain('remove'); expect(native.handles.size).toBe(0)
    },
  )
})
