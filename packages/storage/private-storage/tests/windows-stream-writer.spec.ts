/** Synthetic retained-resource conformance; no native Windows acceptance is inferred. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrivateStorageError } from '../src/error.ts'
import { createBoundedFileWriter, PrivateFileWriterError } from '../src/stream-writer.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import { createWindowsWriterResource } from '../src/windows-stream-writer.ts'
import type { WindowsWriterParent } from '../src/windows-stream-writer.ts'
import { FakeNative } from './fake-native.ts'

class SourceFakeNative extends FakeNative {
  override inspectSource(handle: bigint) {
    const { ownerSid: _ownerSid, daclProtected: _daclProtected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
}
function setup() {
  const native = new SourceFakeNative(), root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
  const handle = native.open(root, 'private', 'directory', 'inspect')
  let released = false
  const parent: WindowsWriterParent = { api: native.asNative(), sid: native.sid, handle, identity: native.inspect(handle).identity,
    validate() { if (released) throw new Error('parent released'); native.inspect(handle) },
    release() { expect(released).toBe(false); released = true; native.close(handle); native.close(root) } }
  const writer = (bytes: Buffer) => createBoundedFileWriter('final', { operationId: 'synthetic-write' as PrivateStreamOperationId,
    expectedBytes: bytes.length, expectedSha256: createHash('sha256').update(bytes).digest('hex'), replace: false, executable: true },
  'windows-ntfs-write-through-rename-v1', () => createWindowsWriterResource(parent, 'final'))
  return { native, parent, writer }
}

describe('Windows retained stream adapter (synthetic native model)', () => {
  it('appends distinct chunks, publishes once and reports actual Windows metadata and sync facts', () => {
    const { native, writer } = setup(), value = writer(Buffer.from('abcXYZ!'))
    value.append(Buffer.from('abc')); value.append(Buffer.from('XYZ!'))
    const receipt = value.finish()
    expect(receipt).toMatchObject({ publication: 'published', durability: 'synced', acceptedBytes: 7,
      contentVerification: 'verified', bindingVerification: 'verified', metadataVerification: 'verified',
      executable: true, executableMetadata: 'not-required', release: 'released',
      synchronization: { preFile: 'succeeded', directory: 'not-required', postFile: 'succeeded' } })
    expect([...native.entries.values()].find(entry => entry.name === 'final')?.bytes.toString()).toBe('abcXYZ!')
    const events = [...native.events]
    expect(value.finish()).toEqual(receipt); value.close(); value.abort()
    expect(native.events).toEqual(events)
    expect(native.handles.size).toBe(0)
    expect(native.events.filter(event => event === 'rename')).toHaveLength(1)
    expect(native.events.filter(event => event === 'flush')).toHaveLength(2)
  })
  it('finishes an empty stream without a write call', () => {
    const { native, writer } = setup(), value = writer(Buffer.alloc(0))
    expect(value.finish().outcome).toBe('finished')
    expect(native.events).not.toContain('write')
  })
  it('abort reports pending deletion and release-only close leaves its own staging entry', () => {
    const first = setup(), aborted = first.writer(Buffer.from('abc'))
    aborted.append(Buffer.from('a'))
    expect(aborted.abort()).toMatchObject({ publication: 'not-published', cleanup: 'delete-pending', cleanupDurability: 'unconfirmed', release: 'released' })
    expect(first.native.handles.size).toBe(0)
    const second = setup(), closed = second.writer(Buffer.from('abc'))
    closed.append(Buffer.from('a')); closed.close()
    expect(closed.receipt).toMatchObject({ publication: 'not-published', cleanup: 'withheld', outcome: 'closed' })
    expect(second.native.events).not.toContain('remove')
    expect([...second.native.entries.values()].some(entry => entry.name.startsWith('.dsh-private-'))).toBe(true)
  })
  it('fails partial appends without pretending the incomplete chunk was accepted', () => {
    const { native, writer } = setup(), value = writer(Buffer.from('abcXYZ'))
    value.append(Buffer.from('abc'))
    native.hook = (operation) => { if (operation === 'write') throw new PrivateStorageError('native', 'write failed', { win32Code: 5 }) }
    expect(() => { value.append(Buffer.from('XYZ')) }).toThrow(PrivateFileWriterError)
    expect(value.receipt).toMatchObject({ publication: 'not-published', acceptedBytes: 3, observedSizeBytes: 3, cleanup: 'delete-pending' })
    expect(native.events).not.toContain('rename')
    const events = [...native.events]
    expect(() => { value.finish() }).toThrow(PrivateFileWriterError)
    expect(native.events).toEqual(events)
  })
  it('preserves a winner created after initial target inspection', () => {
    const { native, parent, writer } = setup(), value = writer(Buffer.from('new'))
    value.append(Buffer.from('new'))
    native.add(native.id(parent.handle), 'final', 'file', Buffer.from('winner'))
    expect(() => { value.finish() }).toThrow(PrivateFileWriterError)
    expect(value.receipt.publication).toBe('not-published')
    expect([...native.entries.values()].find(entry => entry.name === 'final')?.bytes.toString()).toBe('winner')
    expect(native.events.filter(event => event === 'rename')).toHaveLength(1)
  })
  it.each(['published', 'indeterminate'] as const)('withholds deletion after a lost rename acknowledgement (%s)', (outcome) => {
    const { native, writer } = setup(), value = writer(Buffer.from('abc'))
    value.append(Buffer.from('abc'))
    const rename = native.rename.bind(native)
    native.rename = (handle, parent, name, replace) => {
      rename(handle, parent, name, replace)
      if (outcome === 'indeterminate') native.inspectSource = () => { throw new Error('observation unavailable') }
      throw new PrivateStorageError('native', 'rename return lost')
    }
    expect(() => { value.finish() }).toThrow(PrivateFileWriterError)
    expect(value.receipt).toMatchObject({ publication: outcome, durability: 'unconfirmed', cleanup: 'withheld' })
    expect(native.events).not.toContain('remove')
    expect([...native.entries.values()].find(entry => entry.name === 'final')?.bytes.toString()).toBe('abc')
  })
  it.each(['pre-flush', 'post-flush', 'final-name', 'close'] as const)('retains independent facts across %s failure', (phase) => {
    const { native, writer } = setup(), value = writer(Buffer.from('abc'))
    value.append(Buffer.from('abc'))
    const sourceHandle = [...native.handles].find(([, held]) => held.entry.name === value.receipt.stagingName)![0]
    let flushes = 0, published = false, sourceCloseAttempts = 0
    native.hook = (operation, handle) => {
      if (operation === 'rename') published = true
      if (operation === 'flush' && ++flushes === (phase === 'pre-flush' ? 1 : phase === 'post-flush' ? 2 : -1)) throw new Error('flush failed')
      if (phase === 'final-name' && published && operation === 'name') throw new Error('name failed')
      if (phase === 'close' && published && operation === 'close' && handle === sourceHandle) {
        sourceCloseAttempts++
        native.handles.delete(handle)
        throw new PrivateStorageError('native', 'close return lost', { win32Code: 6 })
      }
    }
    expect(() => { value.finish() }).toThrow(PrivateFileWriterError)
    expect(value.receipt.publication).toBe(phase === 'pre-flush' ? 'not-published' : 'published')
    if (phase !== 'pre-flush') expect(native.events).not.toContain('remove')
    expect(value.receipt.durability).toBe(phase === 'close' ? 'synced' : 'unconfirmed')
    if (phase === 'close') {
      expect(sourceCloseAttempts).toBe(1)
      expect(value.receipt).toMatchObject({ bindingVerification: 'verified', metadataVerification: 'verified', release: 'failed' })
      expect(() => { value.finish() }).toThrow(expect.objectContaining({ win32Code: 6, cleanupFailed: true }))
      expect(sourceCloseAttempts).toBe(1)
    }
  })
  it('checks file kind, link count and retained write-through mode before any append', () => {
    for (const edit of [{ links: 2 }, { writeThrough: false }, { kind: 'directory' as const }]) {
      const { native, writer } = setup(), value = writer(Buffer.from('abc'))
      const entry = [...native.entries.values()].find(entry => entry.name === value.receipt.stagingName)!
      entry.facts = { ...entry.facts, ...edit }
      expect(() => { value.append(Buffer.from('abc')) }).toThrow(PrivateFileWriterError)
      expect(native.events).not.toContain('write'); expect(native.events).not.toContain('rename')
    }
  })
  it('rejects an existing entry without creating or deleting it', () => {
    const { native, parent, writer } = setup()
    native.add(native.id(parent.handle), 'final', 'file', Buffer.from('original'))
    expect(() => writer(Buffer.from('new'))).toThrow(PrivateFileWriterError)
    expect(native.events).not.toContain('open:create')
    expect(native.events).not.toContain('remove')
    expect([...native.entries.values()].find(entry => entry.name === 'final')?.bytes.toString()).toBe('original')
  })
  it('keeps lazy unknown source facts and unsupported directory sync explicit', () => {
    const { native, parent } = setup(), resource = createWindowsWriterResource(parent, 'final')
    expect(resource.removeUnpublished()).toEqual({ deletion: 'withheld', directorySynced: false })
    expect(resource.reconcile()).toBe('indeterminate')
    expect(() => resource.verifyFinal()).toThrow(/publication is not established/u)
    expect(() => { resource.syncDirectory() }).toThrow(expect.objectContaining({ code: 'unsupported' }))
    expect(native.events).not.toContain('remove')
    resource.close(); resource.close()
    expect(() => resource.inspect()).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(native.handles.size).toBe(0)
  })
  it('removes its admitted unpublished entry at most once and never removes a published source', () => {
    const first = setup(), unpublished = createWindowsWriterResource(first.parent, 'final')
    unpublished.inspect()
    expect(unpublished.removeUnpublished().deletion).toBe('delete-pending')
    expect(unpublished.removeUnpublished().deletion).toBe('delete-pending')
    expect(first.native.events.filter(event => event === 'remove')).toHaveLength(1)
    unpublished.close()
    const second = setup(), published = createWindowsWriterResource(second.parent, 'final')
    published.inspect(); published.publish()
    expect(published.removeUnpublished().deletion).toBe('withheld')
    expect(second.native.events).not.toContain('remove'); published.close()
  })
  it('consumes the parent on invalid names and preserves pre-creation failures across later cleanup', () => {
    const first = setup()
    expect(() => createWindowsWriterResource(first.parent, '../outside')).toThrow(expect.objectContaining({ code: 'name' }))
    expect(first.native.handles.size).toBe(0)
    const second = setup(), resource = createWindowsWriterResource(second.parent, 'final')
    second.native.hook = (operation) => { if (operation === 'open:inspect') throw new PrivateStorageError('privacy', 'parent denied') }
    expect(() => resource.inspect()).toThrow(expect.objectContaining({ code: 'privacy' }))
    second.native.hook = () => {}
    expect(() => resource.inspect()).toThrow(/creation did not return/u)
    expect(resource.removeUnpublished().deletion).toBe('withheld'); resource.close()
    expect(second.native.handles.size).toBe(0)
  })
  it.each(['nonempty', 'volume', 'size-limit'])(
    'rejects unadmitted fresh source observations before any payload is written: %s', (change) => {
      const { native, parent } = setup(), resource = createWindowsWriterResource(parent, 'final')
      const inspect = native.inspect.bind(native)
      native.inspect = (handle) => {
        const facts = inspect(handle)
        if (!native.entry(handle).name.startsWith('.dsh-private-')) return facts
        return { ...facts, ...(change === 'nonempty' ? { sizeBytes: 1n } : {}),
          ...(change === 'volume' ? { identity: { ...facts.identity, volumeSerial: 'f'.repeat(16) } } : {}) }
      }
      if (change === 'size-limit') {
        resource.inspect()
        native.inspect = handle => ({ ...inspect(handle), ...native.entry(handle).name.startsWith('.dsh-private-')
          ? { sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n } : {} })
      }
      expect(() => resource.inspect()).toThrow()
      expect(native.events).not.toContain('write'); resource.close()
      expect(native.handles.size).toBe(0)
    },
  )
  it('withholds deletion when neither observed name establishes the admitted source binding', () => {
    const { native, parent } = setup(), resource = createWindowsWriterResource(parent, 'final')
    resource.inspect()
    const staging = [...native.entries].find(([, entry]) => entry.name.startsWith('.dsh-private-'))!
    native.entries.delete(staging[0])
    expect(resource.reconcile()).toBe('indeterminate')
    expect(resource.removeUnpublished().deletion).toBe('withheld')
    expect(native.events).not.toContain('remove'); resource.close()
  })
  it('does not treat an inaccessible final name as confirmed absence during reconciliation', () => {
    const { native, parent } = setup(), resource = createWindowsWriterResource(parent, 'final')
    resource.inspect()
    native.hook = (operation) => { if (operation === 'open:inspect') throw new PrivateStorageError('privacy', 'query denied') }
    expect(resource.reconcile()).toBe('indeterminate')
    expect(resource.removeUnpublished().deletion).toBe('withheld')
    native.hook = () => {}; resource.close()
  })
  it.each(['kind', 'identity', 'size'])(
    'rejects inconsistent final-name observations after publishing: %s', (change) => {
      const { native, parent } = setup(), resource = createWindowsWriterResource(parent, 'final')
      resource.inspect()
      const retained = [...native.handles].find(([, value]) => value.entry.name === resource.stagingName)![0]
      resource.publish()
      const inspect = native.inspect.bind(native)
      native.inspect = (handle) => {
        const facts = inspect(handle)
        if (handle === retained || native.entry(handle).name !== 'final') return facts
        return { ...facts, ...(change === 'kind' ? { kind: 'directory' as const } : {}),
          ...(change === 'identity' ? { identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : {}),
          ...(change === 'size' ? { sizeBytes: 1n } : {}) }
      }
      expect(() => resource.verifyFinal()).toThrow(/final stream binding changed/u)
      expect(resource.removeUnpublished().deletion).toBe('withheld')
      resource.close(); expect(native.handles.size).toBe(0)
    },
  )
})


function initialFailure(operation: () => unknown): PrivateFileWriterError {
  try { operation() } catch (error) {
    if (error instanceof PrivateFileWriterError) return error
    throw error
  }
  throw new Error('Expected a private writer admission failure')
}
describe('creation and inspection error facts', () => {
  it('retains known staging and released-parent facts when initial admission never succeeds', () => {
    const { native, writer } = setup()
    native.hook = (operation, handle) => {
      if (operation === 'inspect' && handle !== undefined && native.entry(handle).name.startsWith('.dsh-private-')) {
        throw new PrivateStorageError('native', 'initial source observation failed', { win32Code: 31 })
      }
    }
    const failure = initialFailure(() => writer(Buffer.from('abc')))
    expect(failure.win32Code).toBe(31)
    expect(failure.receipt).toMatchObject({ identity: null, publication: 'not-published', cleanup: 'withheld', release: 'released' })
    expect(failure.receipt.stagingName).toMatch(/^\.dsh-private-[0-9a-f]{40}$/u)
    expect(failure.receipt.parentIdentity?.backend).toBe('windows-ntfs')
    expect([...native.entries.values()].filter(entry => entry.name.startsWith('.dsh-private-'))).toHaveLength(1)
    expect(native.handles.size).toBe(0)
    expect(native.events.filter(event => event === 'open:create')).toHaveLength(1)
    expect(native.events).not.toContain('remove')
  })
  it('records an identity learned during failure reconciliation before safe owned cleanup', () => {
    const { native, writer } = setup()
    let failures = 0
    native.hook = (operation, handle) => {
      if (operation === 'inspect' && handle !== undefined && native.entry(handle).name.startsWith('.dsh-private-') && failures++ === 0) {
        throw new PrivateStorageError('native', 'first observation failed', { win32Code: 31 })
      }
    }
    const failure = initialFailure(() => writer(Buffer.from('abc')))
    expect(failure.win32Code).toBe(31)
    expect(failure.receipt).toMatchObject({ cleanup: 'delete-pending', release: 'released' })
    expect(failure.receipt.identity?.backend).toBe('windows-ntfs')
    expect(native.handles.size).toBe(0)
    expect([...native.entries.values()].some(entry => entry.name.startsWith('.dsh-private-'))).toBe(false)
    expect(native.events.filter(event => event === 'open:create')).toHaveLength(1)
  })
  it('keeps primary final-inspection error facts when temporary-handle close also fails', () => {
    const { native, writer } = setup(), value = writer(Buffer.from('abc'))
    value.append(Buffer.from('abc'))
    const sourceHandle = [...native.handles].find(([, held]) => held.entry.name === value.receipt.stagingName)![0]
    let published = false, closes = 0
    native.hook = (operation, handle) => {
      if (operation === 'rename') published = true
      if (!published || handle === undefined || handle === sourceHandle || native.entry(handle).name !== 'final') return
      if (operation === 'inspect') throw new PrivateStorageError('identity', 'final inspection failed', { win32Code: 5 })
      if (operation === 'close') { closes++; native.handles.delete(handle); throw new PrivateStorageError('native', 'inspection close return lost', { win32Code: 6 }) }
    }
    expect(() => value.finish()).toThrow(expect.objectContaining({ code: 'identity', win32Code: 5, cleanupFailed: true }))
    expect(value.receipt).toMatchObject({ publication: 'published', durability: 'unconfirmed', bindingVerification: 'failed', cleanup: 'withheld' })
    expect(closes).toBe(1); expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('remove')
  })
})
