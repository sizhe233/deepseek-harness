/** Synthetic source-policy checks; actual Windows source-stream acceptance remains separate. */
import { beforeEach, describe, expect, it } from 'vitest'
import { NativeFixture } from './native-fixture.ts'
import { FakeNative } from './fake-native.ts'
import type { NativeStorage } from '../src/native.ts'

let fixture: NativeFixture, api: NativeStorage, file: bigint
beforeEach(() => { fixture = new NativeFixture(); api = fixture.api(); file = fixture.create() })

function query(cls: number, edit: (bytes: Buffer) => void): void {
  fixture.overrides.set('NtQueryInformationFile', (...args) => {
    const result = fixture.defaultCall('NtQueryInformationFile', args)
    if (args[4] === cls) edit(fixture.bytes(args[2]!))
    return result
  })
}

describe('distinct readonly source observations (synthetic FFI)', () => {
  it('admits ordinary source hardlinks without asserting destination privacy', () => {
    query(5, (bytes) => { bytes.writeUInt32LE(3, 16) })
    const facts = api.inspectSource(file)
    expect(facts.links).toBe(3)
    expect(facts.identity).toEqual({ volumeSerial: 'fedcba9876543210', fileId: '56341290785634121032547698badcfe' })
    expect(facts).not.toHaveProperty('ownerSid')
    expect(facts).not.toHaveProperty('daclProtected')
    expect(facts.securityDescriptorSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => api.inspect(file, fixture.sid)).toThrow(/single-link/u)
    expect(fixture.memory.size).toBe(0)
  })
  it('observes broad or inherited source security without repairing it or confusing it with private admission', () => {
    const before = api.inspectSource(file)
    fixture.overrides.set('GetSecurityInfo', (...args) => {
      const result = fixture.defaultCall('GetSecurityInfo', args)
      const descriptor = fixture.bytes(fixture.bytes(args[7]!).readBigUInt64LE())
      descriptor.writeUInt16LE(descriptor.readUInt16LE(2) & ~0x1000, 2)
      return result
    })
    const after = api.inspectSource(file)
    expect(after.securityDescriptorSha256).not.toBe(before.securityDescriptorSha256)
    expect(() => api.inspect(file, fixture.sid)).toThrow()
    expect(fixture.events.some(row => row.name === 'NtSetInformationFile')).toBe(false)
    expect(fixture.memory.size).toBe(0)
  })
  it('keeps complete signed time and size observations through the retained handle', () => {
    query(4, (bytes) => { bytes.writeBigInt64LE(0x123456789abcden, 16); bytes.writeBigInt64LE(-9n, 24) })
    expect(api.inspectSource(file)).toMatchObject({ lastWriteTime: 0x123456789abcden, changeTime: -9n, sizeBytes: 3n })
    expect(Object.isFrozen(api.inspectSource(file))).toBe(true)
  })
  it.each([0x400, 0x1000, 0x40000, 0x400000])('refuses reparse/recalled attributes %s for sources', (attribute) => {
    query(4, (bytes) => { bytes.writeUInt32LE(attribute, 32) })
    expect(() => api.inspectSource(file)).toThrow(/reparse or recalled/u)
    expect(fixture.memory.size).toBe(0)
  })
  it.each(['zero-links', 'delete-pending', 'invalid-kind'])('refuses invalid source observation %s', (fault) => {
    query(5, (bytes) => {
      if (fault === 'zero-links') bytes.writeUInt32LE(0, 16)
      else if (fault === 'delete-pending') bytes[20] = 1
      else bytes[21] = 2
    })
    expect(() => api.inspectSource(file)).toThrow()
    expect(fixture.memory.size).toBe(0)
  })
  it('does not turn a failed source security query into an empty or private descriptor', () => {
    fixture.overrides.set('GetSecurityInfo', () => 5)
    expect(() => api.inspectSource(file)).toThrow(expect.objectContaining({ win32Code: 5 }))
    expect(fixture.memory.size).toBe(0)
  })
})

describe('source volume admission (synthetic FFI)', () => {
  it('allows actual readonly local NTFS while keeping destination refusal', () => {
    fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => {
      const result = fixture.defaultCall('NtQueryVolumeInformationFile', args)
      fixture.bytes(args[2]!).writeUInt32LE(2, 4)
      return result
    })
    fixture.overrides.set('GetVolumeInformationByHandleW', (...args) => {
      const result = fixture.defaultCall('GetVolumeInformationByHandleW', args)
      fixture.bytes(args[5]!).writeUInt32LE(0x80008)
      return result
    })
    expect(api.admitSourceFilesystem(file)).toEqual({ filesystem: 'NTFS', flags: 0x80008, deviceType: 7, deviceCharacteristics: 2 })
    expect(() => { api.admitFilesystem(file) }).toThrow(/persistent writable local disk/u)
    expect(fixture.memory.size).toBe(0)
  })
  it.each([0x10, 0x40, 0x1000, 0x2000])('refuses unsupported source backing flag %s', (flag) => {
    fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => {
      const result = fixture.defaultCall('NtQueryVolumeInformationFile', args)
      fixture.bytes(args[2]!).writeUInt32LE(flag, 4)
      return result
    })
    expect(() => api.admitSourceFilesystem(file)).toThrow(/persistent local source disk/u)
  })
  it('refuses a source filesystem without observed persistent ACL support', () => {
    fixture.overrides.set('GetVolumeInformationByHandleW', (...args) => {
      const result = fixture.defaultCall('GetVolumeInformationByHandleW', args)
      fixture.bytes(args[5]!).writeUInt32LE(0)
      return result
    })
    expect(() => api.admitSourceFilesystem(file)).toThrow(/ACL-capable source NTFS/u)
  })
})

it('the synthetic native writer advances its real per-handle cursor across distinct chunks', () => {
  const native = new FakeNative(), root = native.open(null, '\\??\\C:\\', 'directory', 'inspect')
  const parent = native.open(root, 'private', 'directory', 'inspect')
  const handle = native.open(parent, 'record', 'file', 'create')
  native.write(handle, Buffer.from('abc'))
  native.write(handle, Buffer.from('XYZ!'))
  expect(native.entry(handle).bytes.toString()).toBe('abcXYZ!')
  expect(native.inspect(handle).sizeBytes).toBe(7n)
  expect(native.handles.get(handle)?.offset).toBe(7)
})


it('opens source streams with READ sharing only while retaining legacy byte reader sharing', () => {
  const source = api.open(null, 'source.bin', 'file', 'read-source', fixture.sid)
  const call = fixture.events.filter(event => event.name === 'NtCreateFile').at(-1)!
  expect(call.args[1]).toBe(0x120081)
  expect(call.args[6]).toBe(1)
  expect(call.args[7]).toBe(1)
  expect(call.args[8]).toBe(0x200060)
  api.close(source)
  const legacy = api.open(null, 'legacy.bin', 'file', 'read', fixture.sid)
  expect(fixture.events.filter(event => event.name === 'NtCreateFile').at(-1)!.args[6]).toBe(5)
  api.close(legacy)
  expect(fixture.memory.size).toBe(0)
})
