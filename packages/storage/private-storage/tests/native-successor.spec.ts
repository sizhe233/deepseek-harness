/** Synthetic FFI checks for additive control/log operations; native Windows conformance is separate. */
import { describe, expect, it } from 'vitest'
import { NativeFixture } from './native-fixture.ts'

describe('additive Windows retained native operations', () => {
  it('opens logs without truncation under guarded sharing and same-handle flush access', () => {
    const fixture = new NativeFixture(), api = fixture.api()
    const handle = api.open(null, 'record.log', 'file', 'log', fixture.sid)
    const call = fixture.events.find(event => event.name === 'NtCreateFile')
    expect(call?.args[1]).toBe(0x40120080)
    expect(call?.args[6]).toBe(1)
    expect(call?.args[7]).toBe(3)
    expect(call?.args[8]).toBe(0x200062)
    expect(api.inspect(handle, fixture.sid).kind).toBe('file')
    api.flush(handle); api.close(handle)
    expect(fixture.memory.size).toBe(0)
  })
  it('observes caller quota capacity through the existing retained directory query', () => {
    const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create('directory', true)
    fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => {
      if (args[4] !== 7) return fixture.defaultCall('NtQueryVolumeInformationFile', args)
      const output = fixture.bytes(args[2]!)
      output.writeBigInt64LE(10n); output.writeBigInt64LE(3n, 8); output.writeBigInt64LE(8n, 16)
      output.writeUInt32LE(8, 24); output.writeUInt32LE(512, 28)
      fixture.bytes(args[1]!).writeBigUInt64LE(32n, 8)
      return 0
    })
    expect(api.capacity(handle)).toEqual({ allocationUnitBytes: 4096n, availableBytes: 12288n })
    expect(fixture.memory.size).toBe(0)
  })
  it.each(['negative', 'quota-overflow', 'actual-overflow', 'zero-sector', 'zero-byte', 'truncated'])(
    'rejects %s capacity facts', (condition) => {
      const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create('directory', true)
      fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => {
        if (args[4] !== 7) return fixture.defaultCall('NtQueryVolumeInformationFile', args)
        const output = fixture.bytes(args[2]!)
        output.writeBigInt64LE(condition === 'negative' ? -1n : 10n)
        output.writeBigInt64LE(condition === 'quota-overflow' ? 11n : 3n, 8)
        output.writeBigInt64LE(condition === 'actual-overflow' ? 2n : 8n, 16)
        output.writeUInt32LE(condition === 'zero-sector' ? 0 : 8, 24)
        output.writeUInt32LE(condition === 'zero-byte' ? 0 : 512, 28)
        fixture.bytes(args[1]!).writeBigUInt64LE(condition === 'truncated' ? 31n : 32n, 8)
        return 0
      })
      expect(() => api.capacity(handle)).toThrow()
      expect(fixture.memory.size).toBe(0)
    },
  )
  it('observes retired private handles without permitting them as live sources', () => {
    const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create()
    fixture.overrides.set('NtQueryInformationFile', (...args) => {
      const result = fixture.defaultCall('NtQueryInformationFile', args)
      if (args[4] === 5) { const data = fixture.bytes(args[2]!); data.writeUInt32LE(0, 16); data[20] = 1 }
      return result
    })
    expect(() => api.inspect(handle, fixture.sid)).toThrow()
    expect(() => api.inspectSource(handle)).toThrow()
    expect(api.inspectRetiredPrivate(handle, fixture.sid)).toMatchObject({ links: 0, kind: 'file' })
    expect(fixture.memory.size).toBe(0)
  })
  it('refuses inconsistent post-retirement observations without weakening live admission', () => {
    const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create()
    let standards = 0
    fixture.overrides.set('NtQueryInformationFile', (...args) => {
      const result = fixture.defaultCall('NtQueryInformationFile', args)
      if (args[4] === 5 && ++standards === 2) fixture.bytes(args[2]!).writeUInt32LE(2, 16)
      return result
    })
    expect(() => api.inspectRetiredPrivate(handle, fixture.sid)).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(fixture.memory.size).toBe(0)
  })
  it('appends every short-write continuation at fixed EOF and preserves previous bytes', () => {
    const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create('log', false, Buffer.from('old'))
    const offsets: bigint[] = [], chunks: number[] = []
    fixture.overrides.set('NtWriteFile', (...args) => {
      offsets.push(fixture.bytes(args[7]!).readBigInt64LE())
      const length = args[6] as number, count = Math.min(4, length)
      chunks.push(length)
      const object = fixture.object(args[0]!)
      object.bytes = Buffer.concat([object.bytes, fixture.bytes(args[5]!).subarray(0, count)])
      fixture.bytes(args[4]!).writeBigUInt64LE(BigInt(count), 8)
      return 0
    })
    api.append(handle, Buffer.from('first-second'))
    expect(fixture.object(handle).bytes.toString()).toBe('oldfirst-second')
    expect(offsets).toEqual([-1n, -1n, -1n])
    expect(chunks).toEqual([12, 8, 4])
    expect(fixture.memory.size).toBe(0)
  })
  it.each(['zero', 'excess', 'status'] as const)('rejects invalid append %s without treating it as acknowledged', (mode) => {
    const fixture = new NativeFixture(), api = fixture.api(), handle = fixture.create()
    fixture.overrides.set('NtWriteFile', (...args) => {
      if (mode === 'status') return -1073741790
      fixture.bytes(args[4]!).writeBigUInt64LE(mode === 'zero' ? 0n : 99n, 8)
      return 0
    })
    expect(() => { api.append(handle, Buffer.from('x')) }).toThrow()
    expect(fixture.memory.size).toBe(0)
  })
})
