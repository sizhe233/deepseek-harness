/** Readonly imported documents have observed identities, separate from artifact SHA admission. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readBoundedSourceDocument } from '../src/source-document-reader.ts'
import type { SourceReaderResource } from '../src/stream-native.ts'
import type { SourceFileFacts } from '../src/stream-types.ts'

function fixture() {
  const bytes = Buffer.from('original: untouched\n')
  const source: SourceFileFacts = { identity: { backend: 'posix', device: '1', inode: '2' }, sizeBytes: bytes.length,
    links: 2, changeToken: 'mtime-ctime', observations: { mode: 0o100444, uid: '1000', gid: '1000' } }
  let cursor = 0, closed = 0, opened = 0
  const state = { source, changed: false }
  const resource: SourceReaderResource = {
    inspect: () => state.source,
    read: (maximum) => { const result = Buffer.from(bytes.subarray(cursor, cursor + maximum)); cursor += result.length
      if (state.changed) state.source = { ...state.source, changeToken: 'changed' }; return result },
    close: () => { closed++ },
  }
  return { bytes, source, state, open: () => { opened++; return resource }, counts: () => ({ closed, opened }) }
}
describe('bounded original document reads', () => {
  it('reads a shared readonly document with computed digest and exact observations', () => {
    const f = fixture(), result = readBoundedSourceDocument({ maxBytes: 1024, expectedSource: f.source }, f.open)
    expect(Buffer.from(result.bytes)).toEqual(f.bytes)
    expect(result.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'))
    expect(result.source).toEqual(f.source)
    expect(f.counts()).toEqual({ opened: 1, closed: 1 })
  })
  it.each(['identity', 'sizeBytes', 'links', 'changeToken', 'observations'])('refuses stale %s and releases once', (key) => {
    const f = fixture()
    if (key === 'identity') f.state.source = { ...f.source, identity: { backend: 'posix', device: '1', inode: '3' } }
    if (key === 'sizeBytes') f.state.source = { ...f.source, sizeBytes: f.source.sizeBytes + 1 }
    if (key === 'links') f.state.source = { ...f.source, links: 1 }
    if (key === 'changeToken') f.state.source = { ...f.source, changeToken: 'new' }
    if (key === 'observations') f.state.source = { ...f.source, observations: { ...f.source.observations, mode: 0o100600 } }
    expect(() => readBoundedSourceDocument({ maxBytes: 1024, expectedSource: f.source }, f.open)).toThrow()
    expect(f.counts()).toEqual({ opened: 1, closed: 1 })
  })
  it('refuses a read-time change without returning partial bytes', () => {
    const f = fixture(); f.state.changed = true
    expect(() => readBoundedSourceDocument({ maxBytes: 1024, expectedSource: f.source }, f.open)).toThrow()
    expect(f.counts()).toEqual({ opened: 1, closed: 1 })
  })
  it('rejects an invalid maximum before acquisition', () => {
    const f = fixture()
    expect(() => readBoundedSourceDocument({ maxBytes: 64 * 1024 * 1024 + 1, expectedSource: f.source }, f.open)).toThrow()
    expect(f.counts()).toEqual({ opened: 0, closed: 0 })
  })
})
