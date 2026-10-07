import { describe, expect, it } from 'vitest'
import { PrivateStorageError } from '../src/error.ts'
import { MAX_PRIVATE_BYTES, privateDescriptor, sameIdentity, splitRootPath, validateLimit, validateName, validateSid, verifyPrivateDescriptor } from '../src/policy.ts'

const sid = Buffer.from('0102000000000005150000002a000000', 'hex')

describe('literal private storage policy', () => {
  it.each(['record', 'hello world', '配置😀.json', 'com0', 'nulled.txt'])('accepts literal name %s', (name) => { validateName(name) })
  it.each(['', '.', '..', '../x', 'x/y', 'x\\y', 'C:x', 'C:\\x', '\\\\server\\x', 'x:ads', '*.txt', '?', 'x.', 'x ', 'NUL', 'aux.txt', 'COM1.a', 'COM1 .txt', 'NUL  .log', 'x\u0085', 'x\u009f', 'LPT².log', 'COM³', 'CONIN$', 'CONOUT$.x', 'x\0', 'x\n', 'x\u007f', '\ud800', '\ud800A', '\udc00', 'x'.repeat(256)])('rejects ambiguous name %s', (name) => { expect(() => { validateName(name) }).toThrow(PrivateStorageError) })
  it('splits only literal absolute drive paths', () => {
    expect(splitRootPath('C:\\Users\\literal')).toEqual({ volume: '\\??\\C:\\', components: ['Users', 'literal'] })
    for (const path of ['C:\\', 'C:x', '/tmp/x', 'C:/x', 'C:\\x\\', '\\\\server\\share', '\\\\?\\C:\\x', `C:\\${'x'.repeat(32761)}`]) expect(() => splitRootPath(path)).toThrow(PrivateStorageError)
  })
  it('bounds allocations and compares every identity field', () => {
    validateLimit(0); validateLimit(MAX_PRIVATE_BYTES)
    for (const size of [-1, 0.1, Infinity, NaN, MAX_PRIVATE_BYTES + 1]) expect(() => { validateLimit(size) }).toThrow(PrivateStorageError)
    expect(sameIdentity({ volumeSerial: '1', fileId: '2' }, { volumeSerial: '1', fileId: '2' })).toBe(true)
    expect(sameIdentity({ volumeSerial: '1', fileId: '2' }, { volumeSerial: '3', fileId: '2' })).toBe(false)
    expect(sameIdentity({ volumeSerial: '1', fileId: '2' }, { volumeSerial: '1', fileId: '3' })).toBe(false)
  })
})

describe('bounded exact security descriptors', () => {
  it.each([false, true])('round trips explicit descriptors (directory=%s)', (directory) => {
    const bytes = privateDescriptor(sid, directory)
    verifyPrivateDescriptor(bytes, sid, directory)
    expect(bytes.readUInt16LE(2)).toBe(0x9004)
    expect(bytes.readUInt32LE(20 + sid.length + 12)).toBe(0x1f01ff)
    expect(() => { verifyPrivateDescriptor(bytes, sid, !directory) }).toThrow(PrivateStorageError)
  })
  it('rejects malformed or oversized SID encodings', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(7), Buffer.alloc(8), Buffer.from('0110000000000005', 'hex'), Buffer.concat([sid, Buffer.alloc(1)]), sid.subarray(0, sid.length - 1)]) expect(() => { validateSid(bytes) }).toThrow(PrivateStorageError)
  })
  it.each([
    ['revision', (b: Buffer) => { b[0] = 2 }],
    ['reserved', (b: Buffer) => { b[1] = 1 }],
    ['unprotected', (b: Buffer) => { b.writeUInt16LE(0x8004, 2) }],
    ['null DACL', (b: Buffer) => { b.writeUInt32LE(0, 16) }],
    ['absent DACL', (b: Buffer) => { b.writeUInt16LE(0x9000, 2) }],
    ['defaulted owner', (b: Buffer) => { b.writeUInt16LE(0x9005, 2) }],
    ['defaulted DACL', (b: Buffer) => { b.writeUInt16LE(0x900c, 2) }],
    ['owner header offset', (b: Buffer) => { b.writeUInt32LE(8, 4) }],
    ['owner pointer beyond data', (b: Buffer) => { b.writeUInt32LE(b.length, 4) }],
    ['owner SID invalid', (b: Buffer) => { b[20] = 2 }],
    ['owner SID truncated', (b: Buffer) => { b[21] = 15 }],
    ['foreign owner', (b: Buffer) => { b[32] = 44 }],
    ['unexpected group', (b: Buffer) => { b.writeUInt32LE(20, 8) }],
    ['unexpected SACL', (b: Buffer) => { b.writeUInt32LE(20, 12) }],
    ['ACL overflow', (b: Buffer) => { b.writeUInt16LE(65535, 38) }],
    ['empty ACL', (b: Buffer) => { b.writeUInt16LE(0, 40) }],
    ['ACL revision', (b: Buffer) => { b[36] = 4 }],
    ['ACL reserved', (b: Buffer) => { b[37] = 1 }],
    ['ACL reserved2', (b: Buffer) => { b[42] = 1 }],
    ['ACL too short', (b: Buffer) => { b.writeUInt16LE(8, 38) }],
    ['overlapping owner', (b: Buffer) => { b.writeUInt32LE(52, 4) }],
    ['unknown ACE', (b: Buffer) => { b[44] = 99 }],
    ['object ACE', (b: Buffer) => { b[44] = 5 }],
    ['callback ACE', (b: Buffer) => { b[44] = 9 }],
    ['deny ACE', (b: Buffer) => { b[44] = 1 }],
    ['inherited ACE', (b: Buffer) => { b[45] = 16 }],
    ['broad mask', (b: Buffer) => { b.writeUInt32LE(0xffffffff, 48) }],
    ['ACE undersize', (b: Buffer) => { b.writeUInt16LE(8, 46) }],
    ['ACE overflow', (b: Buffer) => { b.writeUInt16LE(65535, 46) }],
    ['foreign beneficiary', (b: Buffer) => { b[64] = 44 }],
    ['SID trailing data', (b: Buffer) => { b[53] = 1 }],
    ['SID excessive subauthorities', (b: Buffer) => { b[53] = 16 }],
  ] as const)('rejects %s without repair', (_label, mutate) => {
    const bytes = privateDescriptor(sid, false)
    mutate(bytes)
    const before = Buffer.from(bytes)
    expect(() => { verifyPrivateDescriptor(bytes, sid, false) }).toThrow(PrivateStorageError)
    expect(bytes).toEqual(before)
  })
  it('requires bounded complete descriptors', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(19), Buffer.alloc(65537)]) {
      expect(() => { verifyPrivateDescriptor(bytes, sid, false) }).toThrow(PrivateStorageError)
    }
  })
})
