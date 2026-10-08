/** Bounded private-record model checks; native policy admission is tested separately. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readBoundedPrivateRecord } from '../src/private-record-reader.ts'
import type { SourceReaderResource } from '../src/stream-native.ts'

function fixture(input = Buffer.from('{"revision":1}\n')) {
  const state = { cursor: 0, closed: 0, token: 'first', closeFails: false, inspectFails: false, size: input.length,
    shared: false, oversized: false, content: Buffer.from(input), mutateAfterRead: false }
  const resource: SourceReaderResource = {
    inspect: () => {
      if (state.inspectFails) throw new Error('injected inspect')
      return { identity: { backend: 'posix', device: '1', inode: '2' }, sizeBytes: state.size, links: 1,
        changeToken: state.token, observations: { mode: 0o100600 } }
    },
    read: (count) => {
      const chunk = Buffer.from(state.content.subarray(state.cursor, state.cursor + count)); state.cursor += chunk.length
      if (state.mutateAfterRead) state.token = 'changed'
      if (state.shared) return new Uint8Array(new SharedArrayBuffer(chunk.length))
      if (state.oversized) return Buffer.alloc(count + 1)
      return chunk
    },
    close: () => { state.closed++; if (state.closeFails) throw new Error('injected close') },
  }
  return { state, resource, input }
}

describe('private records with observed digests', () => {
  it.each([Buffer.alloc(0), Buffer.from('{"revision":1}\n'), Buffer.alloc(1024 * 1024 + 3, 19)])
  ('reads one stable private record and computes its digest after exact EOF', (input) => {
    const f = fixture(input), result = readBoundedPrivateRecord(input.length, () => f.resource)
    expect(Buffer.from(result.bytes).equals(input)).toBe(true)
    expect(result.sha256).toBe(createHash('sha256').update(input).digest('hex'))
    expect(f.state.closed).toBe(1)
    expect(Object.isFrozen(result.source.observations)).toBe(true)
  })
  it.each([-1, NaN, 0.5, 64 * 1024 * 1024 + 1])('refuses limit %s before native open', (limit) => {
    let opened = false
    expect(() => readBoundedPrivateRecord(limit, () => { opened = true; return fixture().resource })).toThrow(RangeError)
    expect(opened).toBe(false)
  })
  it.each(['too-large', 'negative', 'fractional', 'underflow', 'overflow', 'changed', 'shared', 'oversized', 'inspect', 'close'])
  ('refuses %s without returning partial data and releases once', (failure) => {
    const f = fixture()
    if (failure === 'too-large') f.state.size = 1025
    if (failure === 'negative') f.state.size = -1
    if (failure === 'fractional') f.state.size = 0.5
    if (failure === 'underflow') f.state.content = Buffer.from('x')
    if (failure === 'overflow') f.state.content = Buffer.alloc(f.input.length + 1)
    if (failure === 'changed') f.state.mutateAfterRead = true
    if (failure === 'shared') f.state.shared = true
    if (failure === 'oversized') f.state.oversized = true
    if (failure === 'inspect') f.state.inspectFails = true
    if (failure === 'close') f.state.closeFails = true
    expect(() => readBoundedPrivateRecord(1024, () => f.resource)).toThrow(AggregateError)
    expect(f.state.closed).toBe(1)
  })
})
