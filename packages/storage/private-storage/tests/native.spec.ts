import { beforeEach, describe, expect, it } from 'vitest'
import { NativeFixture } from './native-fixture.ts'
import { loadNativeStorage } from '../src/native.ts'
import { PrivateStorageError } from '../src/error.ts'
import type { NativeStorage } from '../src/native.ts'

let fixture: NativeFixture, api: NativeStorage, handle: bigint
beforeEach(() => { fixture = new NativeFixture(); api = fixture.api(); handle = fixture.create() })
function fail(name: string, code = 5): void { fixture.lastError = code; fixture.overrides.set(name, () => 0) }
function queryChange(cls: number, edit: (bytes: Buffer, status: Buffer) => void): void {
  fixture.overrides.set('NtQueryInformationFile', (...args) => {
    const value = fixture.defaultCall('NtQueryInformationFile', args)
    if (args[4] === cls) edit(fixture.bytes(args[2]!), fixture.bytes(args[1]!))
    return value
  })
}

describe('native ABI packing and retained allocation ownership (synthetic FFI)', () => {
  it('rejects non-Windows loading without touching native dependencies', () => {
    if (process.platform !== 'win32') expect(() => loadNativeStorage()).toThrow(/unavailable/u)
  })
  it('packs root-relative no-reparse, synchronous exclusive write-through creates and exact descriptors', () => {
    const opened = api.open(handle, 'literal', 'file', 'create', fixture.sid)
    const call = fixture.events.find(item => item.name === 'NtCreateFile')!
    expect(call.args[1]).toBe(0x130083)
    expect(call.args[6]).toBe(1)
    expect(call.args[7]).toBe(2)
    expect(call.args[8]).toBe(0x200062)
    expect(fixture.object(opened).name).toBe('literal')
    expect(fixture.memory.size).toBe(0)
    api.close(opened)
  })
  it.each([['directory', 'inspect', 3, 0x1200a1], ['file', 'read', 5, 0x120081], ['file', 'lock', 3, 0x120083], ['any', 'delete', 7, 0x130080], ['any', 'inspect', 7, 0x120080]] as const)('packs %s/%s access without privilege escalation', (kind, mode, share, access) => {
    api.open(null, 'entry', kind, mode, fixture.sid)
    const call = fixture.events.find(item => item.name === 'NtCreateFile')!
    expect(call.args[1]).toBe(access); expect(call.args[6]).toBe(share); expect(call.args[7]).toBe(1)
    expect(fixture.memory.size).toBe(0)
  })
  it.each([[0xc0000034, 'not-found'], [0xc000003a, 'not-found'], [0xc0000035, 'collision'], [0xc0000043, 'sharing'], [0xc0000003, 'unsupported'], [0xc00000bb, 'unsupported'], [0xc0000022, 'native']])('preserves unsigned native status %s', (status, code) => {
    fixture.overrides.set('NtCreateFile', () => status | 0)
    expect(() => api.open(handle, 'record', 'file', 'read', fixture.sid)).toThrow(expect.objectContaining({ code, nativeStatus: status }))
    expect(fixture.memory.size).toBe(0)
  })
  it('rejects invalid returned handles', () => {
    fixture.overrides.set('NtCreateFile', () => 0)
    expect(() => api.open(null, 'record', 'file', 'read', fixture.sid)).toThrow(/invalid returned handle/u)
    fixture.overrides.set('NtCreateFile', (...args) => { fixture.bytes(args[0]!).writeBigUInt64LE(0xffffffffffffffffn); return 0 })
    expect(() => api.open(null, 'record', 'file', 'read', fixture.sid)).toThrow(/invalid returned handle/u)
  })
  it('retains buffers until a pending synchronous operation completes', () => {
    fixture.overrides.set('NtCreateFile', (...args) => { fixture.defaultCall('NtCreateFile', args); fixture.bytes(args[3]!).writeInt32LE(0); return 259 })
    api.open(handle, 'record', 'file', 'read', fixture.sid)
    expect(fixture.events.some(item => item.name === 'WaitForSingleObject')).toBe(true)
    expect(fixture.memory.size).toBe(0)
  })
  it.each([false, true])('quarantines uncertain pending calls and poisons further operations (valid handle=%s)', (validHandle) => {
    fixture.overrides.set('NtCreateFile', (...args) => { if (validHandle) fixture.defaultCall('NtCreateFile', args); return 259 })
    fixture.overrides.set('WaitForSingleObject', () => 0xffffffff)
    expect(() => api.open(handle, 'record', 'file', 'read', fixture.sid)).toThrow(/completion uncertain/u)
    expect(fixture.memory.size).toBe(6)
    expect(() => api.tokenUser()).toThrow(/unsettled/u)
  })
  it('creates protected write-through directories and handles failed pending completion observations', () => {
    api.open(handle, 'child', 'directory', 'create', fixture.sid)
    expect(fixture.events.find(item => item.name === 'NtCreateFile')!.args[1]).toBe(0x1300a1)
    fixture.overrides.set('NtCreateFile', (...args) => { fixture.defaultCall('NtCreateFile', args); fixture.bytes(args[3]!).writeUInt32LE(259); return 259 })
    expect(() => api.open(handle, 'child', 'directory', 'create', fixture.sid)).toThrow(/completion uncertain/u)
    fixture = new NativeFixture(); api = fixture.api()
    fixture.overrides.set('NtCreateFile', (...args) => { fixture.defaultCall('NtCreateFile', args); return 259 })
    fixture.overrides.set('WaitForSingleObject', () => { throw new Error('completion unavailable') })
    expect(() => api.open(null, 'entry', 'directory', 'inspect', fixture.sid)).toThrow(/completion uncertain/u)
  })
  it('reports close failure without retrying an uncertain handle', () => { fail('CloseHandle', 6); expect(() => { api.close(handle) }).toThrow(expect.objectContaining({ win32Code: 6 })) })
})

describe('TokenUser ownership and exact security inspection (synthetic FFI)', () => {
  it('queries only TOKEN_QUERY and copies the complete bounded TokenUser SID', () => {
    expect(api.tokenUser()).toEqual(fixture.sid)
    expect(fixture.events.find(item => item.name === 'OpenProcessToken')!.args[1]).toBe(8)
    expect(fixture.events.find(item => item.name === 'OpenThreadToken')!.args[1]).toBe(8)
    expect(fixture.memory.size).toBe(0)
  })
  it('rejects impersonation, failed thread queries and restricted tokens', () => {
    fixture.overrides.set('OpenThreadToken', (...args) => { fixture.bytes(args[3]!).writeBigUInt64LE(3n); return 1 })
    expect(() => api.tokenUser()).toThrow(/impersonation/u)
    fixture.overrides.set('OpenThreadToken', () => { fixture.lastError = 5; return 0 })
    expect(() => api.tokenUser()).toThrow(/OpenThreadToken/u)
    fixture.overrides.delete('OpenThreadToken'); fail('OpenProcessToken')
    expect(() => api.tokenUser()).toThrow(/OpenProcessToken/u)
    fixture.overrides.delete('OpenProcessToken'); fixture.overrides.set('IsTokenRestricted', () => 1)
    expect(() => api.tokenUser()).toThrow(/restricted/u)
  })
  it.each(['unexpected-size-success', 'size-error', 'small-size', 'large-size', 'read-error', 'returned-overflow', 'pointer-underflow', 'pointer-overflow', 'sid-overflow'])('rejects malformed TokenUser %s', (fault) => {
    fixture.overrides.set('GetTokenInformation', (...args) => {
      const value = fixture.defaultCall('GetTokenInformation', args)
      const size = fixture.bytes(args[4]!)
      if (args[2] === null) {
        if (fault === 'unexpected-size-success') return 1
        if (fault === 'size-error') fixture.lastError = 5
        if (fault === 'small-size') size.writeUInt32LE(8)
        if (fault === 'large-size') size.writeUInt32LE(65537)
      } else {
        if (fault === 'read-error') return 0
        if (fault === 'returned-overflow') size.writeUInt32LE(33)
        if (fault === 'pointer-underflow') fixture.bytes(args[2]!).writeBigUInt64LE((args[2] as bigint) - 1n)
        if (fault === 'pointer-overflow') fixture.bytes(args[2]!).writeBigUInt64LE((args[2] as bigint) + 32n)
        if (fault === 'sid-overflow') fixture.bytes(args[2]!)[17] = 15
      }
      return value
    })
    expect(() => api.tokenUser()).toThrow(PrivateStorageError)
    expect(fixture.memory.size).toBe(0)
  })
  it('inspects full-width identities and complete descriptors without numeric truncation', () => {
    expect(api.inspect(handle, fixture.sid)).toMatchObject({ complete: true, kind: 'file', links: 1, sizeBytes: 3n, identity: { volumeSerial: 'fedcba9876543210', fileId: '56341290785634121032547698badcfe' }, writeThrough: true })
    const dir = fixture.create('child', true)
    expect(api.inspect(dir, fixture.sid).kind).toBe('directory')
    expect(fixture.memory.size).toBe(0)
    api.inspect(handle, fixture.sid, false)
  })
  it.each(['not-disk', 'reparse', 'multiple-links', 'delete-pending', 'bad-kind', 'negative-size', 'id-error', 'zero-id', 'security-error', 'null-security', 'security-size', 'free-error'])('rejects inspection fault %s', (fault) => {
    if (fault === 'not-disk') fixture.overrides.set('GetFileType', () => 3)
    if (fault === 'reparse') queryChange(4, bytes => bytes.writeUInt32LE(0x400, 32))
    if (['multiple-links', 'delete-pending', 'bad-kind', 'negative-size'].includes(fault)) queryChange(5, (bytes) => {
      if (fault === 'multiple-links') bytes.writeUInt32LE(2, 16)
      if (fault === 'delete-pending') bytes[20] = 1
      if (fault === 'bad-kind') bytes[21] = 2
      if (fault === 'negative-size') bytes.writeBigInt64LE(-1n, 8)
    })
    if (fault === 'id-error') fail('GetFileInformationByHandleEx')
    if (fault === 'zero-id') fixture.overrides.set('GetFileInformationByHandleEx', () => 1)
    if (fault === 'security-error') fixture.overrides.set('GetSecurityInfo', () => 5)
    if (fault === 'null-security') fixture.overrides.set('GetSecurityInfo', () => 0)
    if (fault === 'security-size') fixture.overrides.set('GetSecurityDescriptorLength', () => 65537)
    if (fault === 'free-error') fixture.overrides.set('LocalFree', (...args) => { fixture.defaultCall('LocalFree', args); return 1n })
    expect(() => api.inspect(handle, fixture.sid)).toThrow(PrivateStorageError)
    expect(fixture.memory.size).toBe(0)
  })
})

describe('NTFS, name, I/O and lock admission (synthetic FFI)', () => {
  it('admits NTFS by handle and rejects an alternate literal spelling', () => {
    api.admitFilesystem(handle); api.verifyName(handle, 'record')
    expect(() => { api.verifyName(handle, 'RECORD') }).toThrow(/literal long-name/u)
  })
  it.each(['not-disk', 'device', 'remote-bit', 'remote-file', 'volume-error', 'filesystem', 'no-acl', 'readonly', 'case-sensitive', 'query-short', 'query-long', 'name-odd', 'name-overflow'])('rejects filesystem/name fault %s', (fault) => {
    if (fault === 'not-disk') fixture.overrides.set('GetFileType', () => 2)
    if (fault === 'device' || fault === 'remote-bit') fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => { fixture.defaultCall('NtQueryVolumeInformationFile', args); fixture.bytes(args[2]!).writeUInt32LE(fault === 'device' ? 8 : 7); fixture.bytes(args[2]!).writeUInt32LE(fault === 'remote-bit' ? 16 : 0, 4); return 0 })
    if (fault === 'remote-file') queryChange(51, (bytes) => { bytes[0] = 1 })
    if (fault === 'case-sensitive') queryChange(71, bytes => bytes.writeUInt32LE(1))
    if (fault === 'volume-error') fail('GetVolumeInformationByHandleW')
    if (['filesystem', 'no-acl', 'readonly'].includes(fault)) fixture.overrides.set('GetVolumeInformationByHandleW', (...args) => {
      fixture.defaultCall('GetVolumeInformationByHandleW', args)
      if (fault === 'filesystem') Buffer.from('ReFS\0', 'utf16le').copy(fixture.bytes(args[6]!))
      if (fault === 'no-acl') fixture.bytes(args[5]!).writeUInt32LE(0)
      if (fault === 'readonly') fixture.bytes(args[5]!).writeUInt32LE(0x80008)
      return 1
    })
    if (fault === 'query-short' || fault === 'query-long') queryChange(51, (_bytes, status) => status.writeBigUInt64LE(fault === 'query-short' ? 0n : 2n, 8))
    if (fault === 'name-odd' || fault === 'name-overflow') queryChange(48, bytes => bytes.writeUInt32LE(fault === 'name-odd' ? 1 : 65540))
    expect(() => {
      if (fault.startsWith('name')) api.verifyName(handle, 'record')
      else api.admitFilesystem(handle)
    }).toThrow(PrivateStorageError)
    expect(fixture.memory.size).toBe(0)
  })
  it('reads and writes bounded chunks and requires both full flushes in callers', () => {
    const bytes = Buffer.alloc(3); expect(api.read(handle, bytes)).toBe(3); expect(bytes.toString()).toBe('abc')
    expect(api.read(handle, Buffer.alloc(1))).toBe(0)
    fixture.object(handle).bytes = Buffer.alloc(0)
    api.write(handle, Buffer.alloc(131073, 42)); expect(fixture.object(handle).bytes).toHaveLength(131073)
    expect(fixture.events.filter(item => item.name === 'WriteFile')).toHaveLength(3)
    api.write(handle, Buffer.alloc(0)); api.flush(handle)
    const release = api.lock(handle); release(); release()
    expect(fixture.events.filter(item => item.name === 'UnlockFileEx')).toHaveLength(1)
    expect(fixture.memory.size).toBe(0)
  })
  it.each(['read-error', 'read-count', 'write-error', 'write-zero', 'write-count', 'flush-error', 'lock-busy', 'lock-sharing', 'unlock-error'])('rejects I/O fault %s and releases allocations', (fault) => {
    if (fault === 'read-error') fail('ReadFile')
    if (fault === 'read-count') fixture.overrides.set('ReadFile', (...args) => { fixture.bytes(args[3]!).writeUInt32LE(100); return 1 })
    if (fault === 'write-error') fail('WriteFile')
    if (fault === 'write-zero' || fault === 'write-count') fixture.overrides.set('WriteFile', (...args) => { fixture.bytes(args[3]!).writeUInt32LE(fault === 'write-zero' ? 0 : 100); return 1 })
    if (fault === 'flush-error') fail('FlushFileBuffers')
    if (fault === 'lock-busy' || fault === 'lock-sharing') fail('LockFileEx', fault === 'lock-busy' ? 33 : 32)
    if (fault === 'unlock-error') fail('UnlockFileEx')
    expect(() => {
      if (fault.startsWith('read')) api.read(handle, Buffer.alloc(3))
      else if (fault.startsWith('write')) api.write(handle, Buffer.from('abc'))
      else if (fault === 'flush-error') api.flush(handle)
      else { const release = api.lock(handle); release() }
    }).toThrow(PrivateStorageError)
    expect(fixture.memory.size).toBe(0)
  })
  it('packs native same-parent rename and checked-handle deletion, without path moves', () => {
    fixture.overrides.set('NtSetInformationFile', (...args) => {
      const input = fixture.bytes(args[2]!)
      if (args[4] === 65) { expect([0, 3]).toContain(input.readUInt32LE()); expect(input.readBigUInt64LE(8)).toBe(777n); expect(input.toString('utf16le', 20, 20 + input.readUInt32LE(16))).toBe('final') }
      else { expect(args[4]).toBe(13); expect(input[0]).toBe(1) }
      return 0
    })
    api.rename(handle, 777n, 'final', false); api.rename(handle, 777n, 'final', true); api.remove(handle)
    expect(fixture.memory.size).toBe(0)
  })
  it('enumerates retained directories with bounds, excluding only dot entries', () => {
    expect(api.names(handle, 2)).toEqual(['record', '目录'])
    fixture.enumeration = 0
    expect(() => api.names(handle, 1)).toThrow(/limit/u)
  })
  it.each([0, 8])('bounds repeated dot-only pages with maximum %s', (maximum) => {
    let calls = 0
    fixture.overrides.set('NtQueryDirectoryFile', (...args) => {
      expect(++calls).toBeLessThanOrEqual(maximum + 3)
      const status = fixture.bytes(args[4]!), bytes = fixture.bytes(args[5]!)
      bytes.fill(0); bytes.writeUInt32LE(2, 8); bytes.writeUInt16LE(46, 12)
      status.writeBigUInt64LE(14n, 8)
      return 0
    })
    expect(() => api.names(handle, maximum)).toThrow(expect.objectContaining({ code: 'limit' }))
    expect(calls).toBe(maximum + 3)
    expect(fixture.memory.size).toBe(0)
  })
  it('permits both real dot entries in an empty directory with no remaining child allowance', () => {
    fixture.overrides.set('NtQueryDirectoryFile', (...args) => {
      const value = fixture.defaultCall('NtQueryDirectoryFile', args)
      if (value !== 0) return value
      fixture.bytes(args[5]!).writeUInt32LE(0, 16)
      fixture.bytes(args[4]!).writeBigUInt64LE(32n, 8)
      return 0
    })
    expect(api.names(handle, 0)).toEqual([])
    expect(fixture.memory.size).toBe(0)
  })
  it('retains the child-name ceiling when the filesystem omits dot entries', () => {
    fixture.overrides.set('NtQueryDirectoryFile', (...args) => {
      const value = fixture.defaultCall('NtQueryDirectoryFile', args)
      if (value !== 0) return value
      const bytes = fixture.bytes(args[5]!), status = fixture.bytes(args[4]!)
      bytes.copyWithin(0, 32)
      status.writeBigUInt64LE(status.readBigUInt64LE(8) - 32n, 8)
      return 0
    })
    expect(() => api.names(handle, 1)).toThrow(/directory audit entry count/u)
    expect(fixture.memory.size).toBe(0)
  })
  it.each(['result-short', 'result-long', 'record-overflow', 'name-odd', 'empty-name', 'name-overflow', 'next-short', 'next-unaligned'])('rejects malformed enumeration %s', (fault) => {
    fixture.overrides.set('NtQueryDirectoryFile', (...args) => {
      fixture.defaultCall('NtQueryDirectoryFile', args)
      const status = fixture.bytes(args[4]!), bytes = fixture.bytes(args[5]!)
      if (fault === 'result-short') status.writeBigUInt64LE(8n, 8)
      if (fault === 'result-long') status.writeBigUInt64LE(65537n, 8)
      if (fault === 'record-overflow') bytes.writeUInt32LE(65532)
      if (fault === 'name-odd') bytes.writeUInt32LE(1, 8)
      if (fault === 'empty-name') bytes.writeUInt32LE(0, 8)
      if (fault === 'name-overflow') bytes.writeUInt32LE(65536, 8)
      if (fault === 'next-short') bytes.writeUInt32LE(4)
      if (fault === 'next-unaligned') bytes.writeUInt32LE(15)
      return 0
    })
    expect(() => api.names(handle, 10)).toThrow(PrivateStorageError)
    expect(fixture.memory.size).toBe(0)
  })
})


it.each([0x2, 0x8, 0x10, 0x40, 0x1000, 0x2000])('rejects nonpersistent or unsupported device characteristic %s', (flag) => {
  fixture.overrides.set('NtQueryVolumeInformationFile', (...args) => {
    fixture.defaultCall('NtQueryVolumeInformationFile', args)
    fixture.bytes(args[2]!).writeUInt32LE(flag, 4)
    return 0
  })
  expect(() => { api.admitFilesystem(handle) }).toThrow(/persistent writable local disk required/u)
  expect(fixture.events.some(event => event.name === 'NtCreateFile')).toBe(false)
})


it('frees allocations when view construction fails before the ownership scope can register them', () => {
  fixture.k.view = () => { throw new Error('view unavailable') }
  expect(() => api.tokenUser()).toThrow(/view unavailable/u)
  expect(fixture.memory.size).toBe(0)
})
