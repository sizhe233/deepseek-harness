/** Synthetic private-log lifecycle; real append/flush/backpressure cases remain native requirements. */
import { describe, expect, it } from 'vitest'
import { openWindowsPrivateLogSink } from '../src/windows-log-sink.ts'
import { PrivateLogSinkError } from '../src/log-error.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { WindowsWriterParent } from '../src/windows-stream-writer.ts'
import { FakeNative } from './fake-native.ts'
function failure(operation: () => unknown): PrivateLogSinkError {
  try { operation() } catch (error) { if (error instanceof PrivateLogSinkError) return error; throw error }
  throw new Error('Expected log failure')
}
function fixture(existing = Buffer.from('older\n')) {
  const native = new FakeNative()
  native.add(2n, 'output.log', 'file', existing)
  const root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
  const directory = native.open(root, 'private', 'directory', 'inspect')
  let released = false
  const parent: WindowsWriterParent = { api: native.asNative(), sid: native.sid, handle: directory,
    identity: native.inspect(directory).identity,
    validate() { if (released) throw new PrivateStorageError('closed', 'parent closed'); native.inspect(directory) },
    release() { if (released) return; released = true; native.close(directory); native.close(root) },
  }
  return { native, parent }
}
describe('Windows append-only private log sink', () => {
  it.each(['readonly', 'negative', 'directory', 'hardlink', 'buffered', 'volume'] as const)(
    'refuses inadmissible existing log %s facts before exposing a sink', (kind) => {
      const { native, parent } = fixture(), entry = [...native.entries.values()].find(value => value.name === 'output.log')
      if (entry === undefined) throw new Error('model log missing')
      entry.facts = { ...entry.facts, ...kind === 'readonly' ? { attributes: 1 } : kind === 'negative' ? { sizeBytes: -1n }
        : kind === 'directory' ? { kind: 'directory' as const } : kind === 'hardlink' ? { links: 2 }
          : kind === 'buffered' ? { writeThrough: false } : { identity: { ...entry.facts.identity, volumeSerial: 'f'.repeat(16) } } }
      expect(() => openWindowsPrivateLogSink(parent, 'output.log', 64)).toThrow()
      expect(native.handles.size).toBe(0); expect(native.events).not.toContain('write')
    })
  it.each([0, 65537, 1.5, NaN])('refuses invalid %s chunk bound and releases the supplied parent', (maximum) => {
    const { native, parent } = fixture()
    expect(() => openWindowsPrivateLogSink(parent, 'output.log', maximum)).toThrow()
    expect(native.handles.size).toBe(0)
  })
  it('retains an acquisition error when releasing its parent also fails', () => {
    const { native, parent } = fixture(), release = parent.release.bind(parent)
    parent.release = () => { release(); throw new Error('parent release acknowledgement lost') }
    expect(failure(() => openWindowsPrivateLogSink(parent, '../invalid', 1))).toMatchObject({ code: 'name', cleanupFailed: true })
    expect(native.handles.size).toBe(0)
  })
  it('rejects append after close and detects closure during caller-owned chunk access', () => {
    const f = fixture(), sink = openWindowsPrivateLogSink(f.parent, 'output.log', 64)
    const chunk = new Uint8Array(1)
    Object.defineProperty(chunk, 'byteLength', { get() { sink.close(); return 1 } })
    expect(() =>{  sink.append(chunk) }).toThrow()
    expect(f.native.handles.size).toBe(0)
    expect(() =>{  sink.append(Buffer.from('again')) }).toThrow()
    const second = fixture(), closed = openWindowsPrivateLogSink(second.parent, 'output.log', 64)
    closed.close(); expect(() =>{  closed.append(Buffer.from('again')) }).toThrow()
  })
  it.each(['size', 'identity', 'short', 'overshoot', 'missing-observation'] as const)(
    'preserves explicit append uncertainty after %s drift', (kind) => {
      const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
      const entry = [...native.entries.values()].find(value => value.name === 'output.log')
      if (entry === undefined) throw new Error('model log missing')
      if (kind === 'size') entry.facts = { ...entry.facts, sizeBytes: 7n }
      else if (kind === 'identity') entry.facts = { ...entry.facts, identity: { ...entry.facts.identity, fileId: 'f'.repeat(32) } }
      else native.append = (_handle, bytes) => {
        entry.facts = { ...entry.facts, sizeBytes: entry.facts.sizeBytes + BigInt(kind === 'short' ? 1 : bytes.length + 1) }
        if (kind === 'missing-observation') native.hook = (operation) => { if (operation === 'inspect') throw new Error('query refused') }
      }
      expect(() =>{  sink.append(Buffer.from('data')) }).toThrow()
      expect(sink.receipt.outcome).toBe('failed')
      if (kind === 'overshoot' || kind === 'missing-observation') expect(sink.receipt.lastAppend).toMatchObject({ confirmedBytes: null, outcome: 'indeterminate' })
      native.hook = () => {}; expect(() => sink.close()).toThrow(); expect(native.handles.size).toBe(0)
    })
  it.each(['before', 'flush'] as const)('reports %s-flush refusal and settles every owned resource on close', (kind) => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
    native.hook = (operation) => { if (operation === (kind === 'before' ? 'inspect' : 'flush')) throw new Error('flush path refused') }
    expect(failure(() => sink.close())).toMatchObject({ receipt: { release: 'released', durability: 'unconfirmed' } })
    expect(native.handles.size).toBe(0)
  })
  it('preserves old bytes and appends sequential chunks before same-handle flush and close', () => {
    const { native, parent } = fixture()
    const sink = openWindowsPrivateLogSink(parent, 'output.log', 65536)
    sink.append(Buffer.from('first\n')); sink.append(Buffer.from('second\n'))
    expect(sink.receipt).toMatchObject({ acceptedBytes: '13', initialSizeBytes: '6', observedSizeBytes: '19', durability: 'unconfirmed' })
    expect(sink.flush()).toMatchObject({ synchronization: 'succeeded', durability: 'synced', release: 'retained' })
    const result = sink.close()
    expect(result).toMatchObject({ outcome: 'closed', durability: 'synced', release: 'released' })
    expect(sink.close()).toEqual(result)
    expect([...native.entries.values()].find(entry => entry.name === 'output.log')?.bytes.toString()).toBe('older\nfirst\nsecond\n')
    expect(native.handles.size).toBe(0)
    expect(native.events).not.toContain('remove'); expect(native.events).not.toContain('rename')
  })
  it('privately creates an absent log and refuses other writers or DELETE opens while retained', () => {
    const { native, parent } = fixture()
    const sink = openWindowsPrivateLogSink(parent, 'fresh.log', 64)
    expect(() => native.open(parent.handle, 'fresh.log', 'file', 'log')).toThrow(expect.objectContaining({ win32Code: 32 }))
    expect(() => native.open(parent.handle, 'fresh.log', 'file', 'delete')).toThrow(expect.objectContaining({ win32Code: 32 }))
    const inspected = native.open(parent.handle, 'fresh.log', 'file', 'inspect'); native.close(inspected)
    sink.append(Buffer.from('fresh')); sink.close()
    expect(native.handles.size).toBe(0)
  })
  it.each(['oversize', 'shared', 'empty'] as const)('refuses %s chunks before native writes and closes without retries', (kind) => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 8)
    const chunk = kind === 'oversize' ? Buffer.alloc(9) : kind === 'shared' ? new Uint8Array(new SharedArrayBuffer(2)) : Buffer.alloc(0)
    expect(() =>{  sink.append(chunk) }).toThrow()
    expect(native.events).not.toContain('write')
    expect(failure(() => sink.close())).toMatchObject({ receipt: { release: 'released' } })
    expect(native.handles.size).toBe(0)
  })
  it('records an observed partial append while preserving its primary native error', () => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
    native.append = (handle, bytes) => { native.write(handle, bytes.subarray(0, 2)); throw new PrivateStorageError('native', 'disk full', { win32Code: 112 }) }
    const file = [...native.handles.entries()].find(([, value]) => value.entry.name === 'output.log')
    if (file === undefined) throw new Error('model log handle missing')
    file[1].offset = file[1].entry.bytes.length
    expect(failure(() =>{  sink.append(Buffer.from('chunk')) })).toMatchObject({ win32Code: 112,
      receipt: { acceptedBytes: '0', lastAppend: { requestedBytes: 5, confirmedBytes: 2, outcome: 'partial' } } })
    expect(failure(() => sink.close())).toMatchObject({ win32Code: 112, receipt: { release: 'released' } })
    expect(native.handles.size).toBe(0)
  })
  it('keeps a successful flush fact when later close acknowledgement fails and never retries the retired handle', () => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
    sink.append(Buffer.from('next'))
    let closes = 0
    native.hook = (operation, handle) => {
      if (operation === 'close' && handle !== undefined && native.entry(handle).name === 'output.log') {
        closes++; native.handles.delete(handle); throw new PrivateStorageError('native', 'lost close', { win32Code: 6 })
      }
    }
    expect(failure(() => sink.close())).toMatchObject({ cleanupFailed: true, win32Code: 6,
      receipt: { synchronization: 'succeeded', durability: 'synced', release: 'failed' } })
    expect(() => sink.close()).toThrow()
    expect(closes).toBe(1); expect(native.handles.size).toBe(0)
  })
  it('retains an earlier append error while independently reporting an uncertain final close', () => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
    native.append = () => { throw new PrivateStorageError('native', 'append denied', { win32Code: 112 }) }
    expect(failure(() =>{  sink.append(Buffer.from('bytes')) })).toMatchObject({ win32Code: 112 })
    native.hook = (operation, handle) => {
      if (operation === 'close' && handle !== undefined && native.entry(handle).name === 'output.log') {
        native.handles.delete(handle); throw new Error('close return lost')
      }
    }
    expect(failure(() => sink.close())).toMatchObject({ win32Code: 112, cleanupFailed: true,
      receipt: { release: 'failed', lastAppend: { requestedBytes: 5, confirmedBytes: 0, outcome: 'partial' } } })
    expect(native.handles.size).toBe(0)
  })
  it('retains successful flush when post-flush privacy verification fails', () => {
    const { native, parent } = fixture(), sink = openWindowsPrivateLogSink(parent, 'output.log', 64)
    let flushed = false
    native.hook = (operation, handle) => {
      if (operation === 'flush') flushed = true
      if (flushed && operation === 'inspect' && handle !== undefined && native.entry(handle).name === 'output.log') {
        throw new PrivateStorageError('privacy', 'changed ACL', { win32Code: 5 })
      }
    }
    expect(failure(() => sink.flush())).toMatchObject({ receipt: { synchronization: 'succeeded', durability: 'synced' } })
    native.hook = () => {}
    expect(failure(() => sink.close())).toMatchObject({ receipt: { release: 'released', durability: 'synced' } })
    expect(native.handles.size).toBe(0)
  })
})
