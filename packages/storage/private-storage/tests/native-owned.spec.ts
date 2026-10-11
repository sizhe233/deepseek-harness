/** Coarse-owner adapter models; the actual native owner must pass independent Windows Worker tests. */
import { describe, expect, it } from 'vitest'
import type { WindowsPrivateFile, WindowsPrivateOwner, WindowsPrivateOwnerRuntimeIdentity } from '@deepseek-ai/node-addon-system/windows-private-owner'
import { OwnedNativeStorage } from '../src/native-owned.ts'
import { linkBytes } from './link-fixture.ts'
import { NativeFixture } from './native-fixture.ts'
import { privateDescriptor } from '../src/policy.ts'
import { PrivateStorageError } from '../src/error.ts'
const identity: WindowsPrivateOwnerRuntimeIdentity = { platform: 'win32', architecture: 'x64', nodeApi: 8,
  entry: { name: 'synthetic-entry', version: '0.1.3', file: 'entry.js', sha256: 'a'.repeat(64) },
  platformPackage: { name: 'synthetic-platform', version: '0.1.3', binary: 'owner.node', sha256: 'b'.repeat(64), bytes: 10 } }
function model() {
  const fixture = new NativeFixture(), files = new WeakMap<WindowsPrivateFile, bigint>()
  const locked = new Set<WindowsPrivateFile>()
  const get = (file: WindowsPrivateFile): bigint => {
    const handle = files.get(file)
    if (handle === undefined) throw Object.assign(new Error('closed owner file'), { code: 'closed', win32Code: 6 })
    return handle
  }
  const owner: WindowsPrivateOwner = {
    tokenUser: () => Buffer.from(fixture.sid),
    reparse: () => { throw new Error('No modeled link requested') },
    open(_parent, name, kind) {
      const file = Object.freeze({}) as WindowsPrivateFile
      files.set(file, fixture.create(name, kind === 'directory', Buffer.alloc(0)))
      return file
    },
    close(file) { get(file); files.delete(file); locked.delete(file) },
    query(file, cls, length, volume) {
      const output = fixture.allocate(length), status = fixture.allocate(16)
      try {
        if (volume && cls === 7) {
          const bytes = fixture.bytes(output)
          bytes.writeBigInt64LE(10n); bytes.writeBigInt64LE(3n, 8); bytes.writeBigInt64LE(8n, 16)
          bytes.writeUInt32LE(8, 24); bytes.writeUInt32LE(512, 28)
          fixture.bytes(status).writeBigUInt64LE(32n, 8)
        } else fixture.call(volume ? 'NtQueryVolumeInformationFile' : 'NtQueryInformationFile', [get(file), status, output, length, cls])
        return Buffer.from(fixture.bytes(output).subarray(0, Number(fixture.bytes(status).readBigUInt64LE(8))))
      } finally { fixture.k.free(output); fixture.k.free(status) }
    },
    fileType(file) { get(file); return 1 },
    fileId(file) {
      const output = fixture.allocate(24)
      try { fixture.call('GetFileInformationByHandleEx', [get(file), 18, output, 24]); return Buffer.from(fixture.bytes(output)) }
      finally { fixture.k.free(output) }
    },
    volumeInfo(file) { get(file); return { filesystem: 'NTFS', flags: 8 } },
    security: file => privateDescriptor(fixture.sid, fixture.object(get(file)).directory),
    read(file, maximum) {
      const value = fixture.object(get(file)), bytes = Buffer.from(value.bytes.subarray(value.offset, value.offset + maximum))
      value.offset += bytes.length
      return bytes
    },
    write(file, bytes, append) {
      const value = fixture.object(get(file)), offset = append ? value.bytes.length : value.offset
      const output = Buffer.alloc(Math.max(value.bytes.length, offset + bytes.length))
      value.bytes.copy(output); output.set(bytes, offset); value.bytes = output; value.offset = offset + bytes.length
      return bytes.length
    },
    flush(file) { get(file) },
    rename(file, parent, name) { get(parent); fixture.object(get(file)).name = name },
    remove(file) { get(file) },
    lock(file) { get(file); if (locked.has(file)) throw Object.assign(new Error('contended'), { win32Code: 33 }); locked.add(file) },
    unlock(file) { get(file); locked.delete(file) },
    names(file) { get(file); return ['one'] },
    observeProcess: () => { throw new Error('Process observation is a separate native capability') },
    statistics: () => ({ owners: 1, fileRecords: 0, openProcesses: 0, openFiles: 0, openTokens: 0, localAllocBlocks: 0,
      heapBlocks: fixture.memory.size, pendingContexts: 0, unconfirmedReleases: 0 }),
  }
  const api = new OwnedNativeStorage(owner, { koffiVersion: '3.1.1', platformPackage: 'synthetic-koffi', nativeBinarySha256: 'c'.repeat(64) }, identity)
  return { api, owner, fixture, get }
}
describe('native environment-owned TypeScript adapter', () => {
  it.each(['bound', 'attributes', 'volume', 'disk-type', 'release'] as const)('rejects incomplete link evidence and retains close uncertainty: %s', (failure) => {
    const { api, owner } = model(), sid = api.tokenUser(), parent = api.open(null, '\\??\\C:\\', 'directory', 'inspect', sid)
    const query = owner.query.bind(owner), open = owner.open.bind(owner), close = owner.close.bind(owner), fileId = owner.fileId.bind(owner)
    let link: WindowsPrivateFile | undefined, closes = 0
    owner.open = (...args) => { link = open(...args); return link }
    owner.query = (file, cls, bytes, volume) => {
      const result = Buffer.from(query(file, cls, bytes, volume))
      if (file === link && cls === 4 && !volume && failure !== 'attributes') result.writeUInt32LE(result.readUInt32LE(32) | 0x400, 32)
      return result
    }
    owner.fileId = (file) => { const bytes = Buffer.from(fileId(file)); if (file === link && failure === 'volume') bytes.writeBigUInt64LE(99n); return bytes }
    owner.fileType = file => file === link && failure === 'disk-type' ? 2 : 1
    owner.reparse = () => { throw new Error('native link query failed') }
    owner.close = (file) => { if (file === link) closes++; close(file); if (file === link && failure === 'release') throw new Error('link close failed') }
    expect(() => api.observeLink(parent, 'bin', failure === 'bound' ? 0 : 32768)).toThrow(failure === 'bound' ? RangeError : failure === 'release' ? AggregateError : Error)
    expect(closes).toBe(failure === 'bound' ? 0 : 1)
    owner.close = close; api.close(parent)
  })
  it('reads only the opened link and refuses changed observations with one close attempt', () => {
    const { api, owner } = model(), sid = api.tokenUser(), parent = api.open(null, '\\??\\C:\\', 'directory', 'inspect', sid)
    const query = owner.query.bind(owner), open = owner.open.bind(owner), close = owner.close.bind(owner)
    let link: WindowsPrivateFile | undefined, closes = 0, changed = false, reads = 0
    owner.open = (...args) => { expect(args[3]).toBe('read-link'); expect(args[2]).toBe('any'); link = open(...args); return link }
    owner.query = (file, cls, bytes, volume) => {
      const result = Buffer.from(query(file, cls, bytes, volume))
      if (file === link && cls === 4 && !volume) result.writeUInt32LE(result.readUInt32LE(32) | 0x400, 32)
      return result
    }
    owner.reparse = () => { reads++; return linkBytes(changed && reads % 2 === 0 ? '../changed' : '../original') }
    owner.close = (file) => { if (file === link) closes++; close(file) }
    expect(api.observeLink(parent, 'bin', 32768)).toMatchObject({ kind: 'symbolic-link', literalTarget: '../original', relative: true })
    expect(closes).toBe(1)
    changed = true
    expect(() => api.observeLink(parent, 'bin', 32768)).toThrow(expect.objectContaining({ code: 'changed' }))
    expect(closes).toBe(2); api.close(parent)
  })
  it('preserves opaque source identity, metadata, strict private policy and sequential I/O', () => {
    const { api, fixture } = model(), sid = api.tokenUser()
    const root = api.open(null, '\\??\\C:\\', 'directory', 'inspect', sid)
    api.admitFilesystem(root)
    expect(api.admitSourceFilesystem(root)).toMatchObject({ filesystem: 'NTFS', deviceType: 7 })
    expect(api.capacity(root)).toEqual({ allocationUnitBytes: 4096n, availableBytes: 12288n })
    const file = api.open(root, 'stage', 'file', 'create', sid)
    expect(api.inspect(file, sid)).toMatchObject({ kind: 'file', links: 1, daclProtected: true, sizeBytes: 0n })
    expect(api.inspectSource(file)).toHaveProperty('securityDescriptorSha256')
    api.verifyName(file, 'stage'); api.write(file, Buffer.from('first')); api.append(file, Buffer.from('second')); api.flush(file)
    expect(api.inspect(file, sid).sizeBytes).toBe(11n)
    const release = api.lock(file); release(); release()
    api.rename(file, root, 'final', false); api.verifyName(file, 'final')
    expect(api.names(root, 1)).toEqual(['one'])
    api.remove(file); api.close(file); api.close(root)
    expect(fixture.memory.size).toBe(0)
    expect(api.ownershipArtifact).toBe(identity)
  })
  it('never reuses a retired private ID or retries a possibly completed native close', () => {
    const { api, owner } = model(), sid = api.tokenUser(), first = api.open(null, '\\??\\C:\\', 'directory', 'inspect', sid)
    const close = owner.close.bind(owner); let calls = 0
    owner.close = (file) => { calls++; close(file); throw Object.assign(new Error('lost return'), { win32Code: 6, cleanupFailed: true }) }
    expect(() =>{  api.close(first) }).toThrow(expect.objectContaining({ win32Code: 6, cleanupFailed: true }))
    expect(() =>{  api.close(first) }).toThrow(expect.objectContaining({ code: 'closed' }))
    owner.close = close
    const next = api.open(null, '\\??\\C:\\', 'directory', 'inspect', sid)
    expect(next).not.toBe(first); expect(calls).toBe(1)
    expect(() => api.inspect(first, sid)).toThrow(expect.objectContaining({ code: 'closed' }))
    api.close(next)
  })
  it.each([[2, 'not-found'], [183, 'collision'], [32, 'sharing'], [33, 'busy'], [5, 'privacy']] as const)(
    'preserves native Win32 classification %s', (win32Code, code) => {
      const { api, owner } = model()
      owner.tokenUser = () => { throw Object.assign(new Error('synthetic native failure'), { win32Code }) }
      expect(() => api.tokenUser()).toThrow(expect.objectContaining({ code, win32Code }))
    },
  )
  it('retains pending refusal and an established primary storage error without inventing success', () => {
    const { api, owner } = model()
    owner.tokenUser = () => { throw Object.assign(new Error('unconfirmed completion'), { pending: true, cleanupFailed: true }) }
    expect(() => api.tokenUser()).toThrow(expect.objectContaining({ code: 'unavailable', cleanupFailed: true }))
    const cause = new PrivateStorageError('privacy', 'known primary', { nativeStatus: 0xc0000022 })
    owner.tokenUser = () => { throw cause }
    expect(() => api.tokenUser()).toThrow(cause)
  })
  it('repeats only confirmed short-write tails and never lets the caller choose an offset', () => {
    const { api, owner } = model(), root = api.open(null, '\\??\\C:\\', 'directory', 'inspect', api.tokenUser())
    const write = owner.write.bind(owner), parts: string[] = []
    owner.write = (file, bytes, append) => { parts.push(Buffer.from(bytes).toString()); return write(file, bytes.subarray(0, 2), append) }
    api.append(root, Buffer.from('abcdef'))
    expect(parts).toEqual(['abcdef', 'cdef', 'ef'])
    owner.write = () => 0
    expect(() =>{  api.write(root, Buffer.from('x')) }).toThrow(/write progress/u)
    api.close(root)
  })
  it('reads detached bounded bytes at the native cursor and reports only actual EOF', () => {
    const { api, owner } = model(), sid = api.tokenUser()
    const file = api.open(null, 'record', 'file', 'create', sid)
    api.write(file, Buffer.from('abc'))
    owner.read = () => Buffer.from('ab')
    const output = Buffer.alloc(4, 0x7a)
    expect(api.read(file, output)).toBe(2); expect(output.toString()).toBe('abzz')
    owner.read = () => Buffer.alloc(0)
    expect(api.read(file, output)).toBe(0)
    owner.read = () => Buffer.alloc(5)
    expect(() => api.read(file, output)).toThrow(/read count/u)
    api.close(file)
  })
  it.each([
    { nativeStatus: 0xc0000034, code: 'not-found' }, { nativeStatus: 0xc000003a, code: 'not-found' },
    { nativeStatus: 0xc0000035, code: 'collision' }, { nativeStatus: 0xc0000043, code: 'sharing' },
    { nativeStatus: 0xc0000054, code: 'busy' }, { nativeStatus: 0xc0000022, code: 'privacy' },
    { win32Code: 3, code: 'not-found' }, { win32Code: 80, code: 'collision' },
  ])('retains actual NTSTATUS or alternate Win32 error facts: $code', ({ code, ...fields }) => {
    const { api, owner } = model()
    owner.tokenUser = () => { throw Object.assign(new Error('native refusal'), fields) }
    expect(() => api.tokenUser()).toThrow(expect.objectContaining({ code, ...fields }))
  })
  it.each([null, 17, 'failure', { code: 'made-up', nativeStatus: -1, win32Code: 0x100000000 },
    { nativeStatus: 0.5, win32Code: NaN }])('keeps untyped native failure causes without inventing numeric status: %j', (cause) => {
    const { api, owner } = model()
    owner.tokenUser = () => { throw cause }
    expect(() => api.tokenUser()).toThrow(expect.objectContaining({ code: 'native', cause }))
  })
  it('preserves a declared native refusal and refuses invalid token bytes', () => {
    const { api, owner } = model()
    owner.tokenUser = () => { throw Object.assign(new Error('unsupported'), { code: 'unsupported' }) }
    expect(() => api.tokenUser()).toThrow(expect.objectContaining({ code: 'unsupported' }))
    owner.tokenUser = () => Buffer.alloc(0)
    expect(() => api.tokenUser()).toThrow()
  })
  it.each(['pipe', 'remote-device', 'virtual-device', 'remote-file', 'non-ntfs', 'no-acls', 'readonly', 'case-sensitive'])(
    'refuses unsupported private storage before returning facts: %s', (kind) => {
      const { api, owner } = model(), root = api.open(null, 'root', 'directory', 'inspect', api.tokenUser())
      const query = owner.query.bind(owner)
      if (kind === 'pipe') owner.fileType = () => 3
      if (kind === 'non-ntfs') owner.volumeInfo = () => ({ filesystem: 'FAT32', flags: 8 })
      if (kind === 'no-acls') owner.volumeInfo = () => ({ filesystem: 'NTFS', flags: 0 })
      if (kind === 'readonly') owner.volumeInfo = () => ({ filesystem: 'NTFS', flags: 0x80008 })
      owner.query = (file, cls, bytes, volume) => {
        const result = Buffer.from(query(file, cls, bytes, volume))
        if (volume && cls === 4 && kind === 'remote-device') result.writeUInt32LE(0x14)
        if (volume && cls === 4 && kind === 'virtual-device') result.writeUInt32LE(0x40, 4)
        if (!volume && cls === 51 && kind === 'remote-file') result[0] = 1
        if (!volume && cls === 71 && kind === 'case-sensitive') result.writeUInt32LE(1)
        return result
      }
      expect(() =>{  api.admitFilesystem(root) }).toThrow(expect.objectContaining({ code: 'unsupported' }))
      if (kind === 'readonly') expect(api.admitSourceFilesystem(root)).toMatchObject({ flags: 0x80008 })
      api.close(root)
    },
  )
  it.each(['negative-total', 'negative-caller', 'negative-actual', 'over-total', 'over-actual', 'zero-sectors', 'zero-sector-size'])(
    'refuses inconsistent filesystem capacity: %s', (kind) => {
      const { api, owner } = model(), root = api.open(null, 'root', 'directory', 'inspect', api.tokenUser())
      const query = owner.query.bind(owner)
      owner.query = (file, cls, bytes, volume) => {
        const value = Buffer.from(query(file, cls, bytes, volume))
        if (volume && cls === 7) {
          if (kind === 'negative-total') value.writeBigInt64LE(-1n)
          if (kind === 'negative-caller') value.writeBigInt64LE(-1n, 8)
          if (kind === 'negative-actual') value.writeBigInt64LE(-1n, 16)
          if (kind === 'over-total') value.writeBigInt64LE(11n, 8)
          if (kind === 'over-actual') value.writeBigInt64LE(9n, 8)
          if (kind === 'zero-sectors') value.writeUInt32LE(0, 24)
          if (kind === 'zero-sector-size') value.writeUInt32LE(0, 28)
        }
        return value
      }
      expect(() => api.capacity(root)).toThrow(/capacity observations/u)
      api.close(root)
    },
  )
  it.each([0, 3, 65541])('refuses incomplete or overlong normalized name results: %s', (length) => {
    const { api, owner } = model(), root = api.open(null, 'root', 'directory', 'inspect', api.tokenUser())
    owner.query = () => Buffer.alloc(length)
    expect(() =>{  api.verifyName(root, 'root') }).toThrow(/incomplete native query/u)
    api.close(root)
  })
  it.each([1, 10])('refuses malformed normalized-name lengths: %s', (length) => {
    const { api, owner } = model(), root = api.open(null, 'root', 'directory', 'inspect', api.tokenUser())
    owner.query = () => { const bytes = Buffer.alloc(6); bytes.writeUInt32LE(length); return bytes }
    expect(() =>{  api.verifyName(root, 'root') }).toThrow(/normalized name bounds/u)
    api.close(root)
  })
  it('requires literal name binding and complete security while keeping source privacy distinct', () => {
    const { api, owner } = model(), sid = api.tokenUser(), file = api.open(null, 'root', 'file', 'inspect', sid)
    expect(() =>{  api.verifyName(file, 'ROOT') }).toThrow(expect.objectContaining({ code: 'name' }))
    owner.security = () => Buffer.alloc(19)
    expect(() => api.inspectSource(file)).toThrow(/security descriptor bounds/u)
    expect(api.inspect(file, sid, false).kind).toBe('file')
    owner.security = () => Buffer.alloc(65537)
    expect(() => api.inspect(file, sid)).toThrow(/security descriptor bounds/u)
    owner.fileType = () => 3
    expect(() => api.inspectSource(file)).toThrow(/disk object required/u)
    api.close(file)
  })
  it('binds retired-file observations across both complete standard queries', () => {
    const { api, owner } = model(), sid = api.tokenUser(), file = api.open(null, 'old', 'file', 'read', sid)
    const query = owner.query.bind(owner)
    let standards = 0
    owner.query = (value, cls, bytes, volume) => {
      const result = Buffer.from(query(value, cls, bytes, volume))
      if (!volume && cls === 5) { standards++; result[20] = 1; result.writeUInt32LE(0, 16) }
      return result
    }
    expect(api.inspectRetiredPrivate(file, sid)).toMatchObject({ deletePending: true, links: 0 })
    const retired = owner.query.bind(owner)
    owner.query = (value, cls, bytes, volume) => {
      const result = Buffer.from(retired(value, cls, bytes, volume))
      if (cls === 5 && standards % 2 === 0) result.writeUInt32LE(1, 16)
      return result
    }
    expect(() => api.inspectRetiredPrivate(file, sid)).toThrow(/retired record observations changed/u)
    api.close(file)
  })
})
