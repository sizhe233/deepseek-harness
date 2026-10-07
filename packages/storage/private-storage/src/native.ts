/** Lazy retained-handle Windows calls. No pathname fallback or privilege changes. */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type koffi from 'koffi'
import { ABI } from './abi.ts'
import { decodeNativeIdentity, decodeNativeMetadata } from './native-observations.ts'
import { OwnedNativeStorage } from './native-owned.ts'
import { loadWindowsPrivateOwner, inspectWindowsPrivateOwnerRuntime } from '@deepseek-ai/node-addon-system/windows-private-owner'
import { PrivateStorageError } from './error.ts'
import { privateDescriptor, validateSid, verifyPrivateDescriptor } from './policy.ts'
import type { PrivateFacts, PrivateStorageCapabilities } from './types.ts'
import type { SourceLinkObservation } from './source-link.ts'

/** Internal OS handle, never a Node file descriptor or public capability. */
export type Handle = bigint

type Pointer = bigint | Buffer | null
interface Calls {
  closeHandle(this: void, handle: Handle): number
  getLastError(this: void): number
  getCurrentProcess(this: void): Handle
  getCurrentThread(this: void): Handle
  openThreadToken(this: void, thread: Handle, access: number, self: number, output: Pointer): number
  openProcessToken(this: void, process: Handle, access: number, output: Pointer): number
  getTokenInformation(this: void, token: Handle, cls: number, output: Pointer, size: number, needed: Pointer): number
  isTokenRestricted(this: void, token: Handle): number
  getSecurityInfo(
    this: void, handle: Handle, kind: number, fields: number,
    owner: null, group: null, dacl: null, sacl: null,
    descriptor: Pointer,
  ): number
  getSecurityDescriptorLength(this: void, descriptor: Pointer): number
  localFree(this: void, pointer: Pointer): Pointer
  getFileType(this: void, handle: Handle): number
  getFileInformationByHandleEx(this: void, handle: Handle, cls: number, output: Pointer, length: number): number
  getVolumeInformationByHandleW(
    this: void, handle: Handle, name: null, nameLength: number,
    serial: Pointer, component: Pointer, flags: Pointer, filesystem: Pointer,
    length: number,
  ): number
  readFile(this: void, handle: Handle, output: Pointer, length: number, count: Pointer, overlapped: null): number
  writeFile(this: void, handle: Handle, input: Pointer, length: number, count: Pointer, overlapped: null): number
  flushFileBuffers(this: void, handle: Handle): number
  lockFileEx(this: void, handle: Handle, flags: number, reserved: number, low: number, high: number, overlapped: Pointer): number
  unlockFileEx(this: void, handle: Handle, reserved: number, low: number, high: number, overlapped: Pointer): number
  waitForSingleObject(this: void, handle: Handle, timeout: number): number
  ntCreateFile(
    this: void, output: Pointer, access: number, attributes: Pointer,
    status: Pointer, size: null, fileAttributes: number, share: number,
    disposition: number, options: number, ea: null, eaLength: number,
  ): number
  ntQueryInformationFile(this: void, handle: Handle, status: Pointer, output: Pointer, length: number, cls: number): number
  ntQueryVolumeInformationFile(this: void, handle: Handle, status: Pointer, output: Pointer, length: number, cls: number): number
  ntWriteFile(
    this: void, handle: Handle, event: null, callback: null, context: null, status: Pointer,
    input: Pointer, length: number, offset: Pointer, key: null,
  ): number
  ntSetInformationFile(this: void, handle: Handle, status: Pointer, input: Pointer, length: number, cls: number): number
  ntQueryDirectoryFile(
    this: void, handle: Handle, event: null, callback: null,
    context: null, status: Pointer, output: Pointer, length: number,
    cls: number, single: number, name: null, restart: number,
  ): number
}

type Koffi = typeof koffi
const require = createRequire(import.meta.url)
let loaded: NativeStorageBackend | undefined

function bindCalls(k: Koffi): { calls: Calls; libraries: ReturnType<Koffi['load']>[] } {
  const kernel = k.load('kernel32.dll')
  const security = k.load('advapi32.dll')
  const nt = k.load('ntdll.dll')
  const bind = (library: ReturnType<Koffi['load']>, name: string, result: string, args: string[]) => library.func('__stdcall', name, result, args)
  return { libraries: [kernel, security, nt], calls: {
    closeHandle: bind(kernel, 'CloseHandle', 'int', ['void *']) as Calls['closeHandle'],
    getLastError: bind(kernel, 'GetLastError', 'uint32', []) as Calls['getLastError'],
    getCurrentProcess: bind(kernel, 'GetCurrentProcess', 'void *', []) as Calls['getCurrentProcess'],
    getCurrentThread: bind(kernel, 'GetCurrentThread', 'void *', []) as Calls['getCurrentThread'],
    openThreadToken: bind(security, 'OpenThreadToken', 'int', ['void *', 'uint32', 'int', 'void *']) as Calls['openThreadToken'],
    openProcessToken: bind(security, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *']) as Calls['openProcessToken'],
    getTokenInformation: bind(security, 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *']) as Calls['getTokenInformation'],
    isTokenRestricted: bind(security, 'IsTokenRestricted', 'int', ['void *']) as Calls['isTokenRestricted'],
    getSecurityInfo: bind(security, 'GetSecurityInfo', 'uint32', ['void *', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *', 'void *']) as Calls['getSecurityInfo'],
    getSecurityDescriptorLength: bind(security, 'GetSecurityDescriptorLength', 'uint32', ['void *']) as Calls['getSecurityDescriptorLength'],
    localFree: bind(kernel, 'LocalFree', 'void *', ['void *']) as Calls['localFree'],
    getFileType: bind(kernel, 'GetFileType', 'uint32', ['void *']) as Calls['getFileType'],
    getFileInformationByHandleEx: bind(kernel, 'GetFileInformationByHandleEx', 'int', ['void *', 'int', 'void *', 'uint32']) as Calls['getFileInformationByHandleEx'],
    getVolumeInformationByHandleW: bind(kernel, 'GetVolumeInformationByHandleW', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32']) as Calls['getVolumeInformationByHandleW'],
    readFile: bind(kernel, 'ReadFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *']) as Calls['readFile'],
    writeFile: bind(kernel, 'WriteFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *']) as Calls['writeFile'],
    flushFileBuffers: bind(kernel, 'FlushFileBuffers', 'int', ['void *']) as Calls['flushFileBuffers'],
    lockFileEx: bind(kernel, 'LockFileEx', 'int', ['void *', 'uint32', 'uint32', 'uint32', 'uint32', 'void *']) as Calls['lockFileEx'],
    unlockFileEx: bind(kernel, 'UnlockFileEx', 'int', ['void *', 'uint32', 'uint32', 'uint32', 'void *']) as Calls['unlockFileEx'],
    waitForSingleObject: bind(kernel, 'WaitForSingleObject', 'uint32', ['void *', 'uint32']) as Calls['waitForSingleObject'],
    ntCreateFile: bind(nt, 'NtCreateFile', 'int32', ['void *', 'uint32', 'void *', 'void *', 'void *', 'uint32', 'uint32', 'uint32', 'uint32', 'void *', 'uint32']) as Calls['ntCreateFile'],
    ntQueryInformationFile: bind(nt, 'NtQueryInformationFile', 'int32', ['void *', 'void *', 'void *', 'uint32', 'int']) as Calls['ntQueryInformationFile'],
    ntQueryVolumeInformationFile: bind(nt, 'NtQueryVolumeInformationFile', 'int32', ['void *', 'void *', 'void *', 'uint32', 'int']) as Calls['ntQueryVolumeInformationFile'],
    ntWriteFile: bind(nt, 'NtWriteFile', 'int32', ['void *', 'void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *', 'void *']) as Calls['ntWriteFile'],
    ntSetInformationFile: bind(nt, 'NtSetInformationFile', 'int32', ['void *', 'void *', 'void *', 'uint32', 'int']) as Calls['ntSetInformationFile'],
    ntQueryDirectoryFile: bind(nt, 'NtQueryDirectoryFile', 'int32', ['void *', 'void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'int', 'uint8', 'void *', 'uint8']) as Calls['ntQueryDirectoryFile'],
  } }
}

class Memory {
  readonly pointer: bigint
  readonly bytes: Buffer
  quarantined = false
  constructor(private readonly k: Koffi, length: number) {
    this.pointer = k.alloc('uint8', length) as bigint
    try {
      this.bytes = Buffer.from(k.view(this.pointer, length))
      this.bytes.fill(0)
    } catch (error) {
      k.free(this.pointer)
      throw error
    }
  }
  close(): void { if (!this.quarantined) this.k.free(this.pointer) }
}

/** Internal inspection includes stable change markers for bounded reads. */
export interface NativeFacts extends PrivateFacts {
  readonly lastWriteTime: bigint
  readonly changeTime: bigint
  readonly attributes: number
}

/** Same-handle source observations without destination owner/DACL or single-link assertions. */
export interface NativeSourceFacts extends Omit<NativeFacts, 'ownerSid' | 'daclProtected'> {
  readonly securityDescriptorSha256: string
}

/** Actual admitted local NTFS volume observations; source admission may allow read-only backing. */
export interface NativeFilesystemFacts {
  readonly filesystem: 'NTFS'
  readonly flags: number
  readonly deviceType: 7
  readonly deviceCharacteristics: number
}

/** One process-realm owner for DLLs, stable native buffers and typed failures. */
export class NativeStorage {
  private poisoned = false
  private readonly pending: Memory[] = []
  private readonly calls: Calls
  private readonly libraries: ReturnType<Koffi['load']>[]
  constructor(private readonly k: Koffi, readonly artifact: NonNullable<PrivateStorageCapabilities['nativeArtifact']>) {
    const loadedCalls = bindCalls(k)
    this.calls = loadedCalls.calls
    this.libraries = loadedCalls.libraries
  }

  private memory<const L extends readonly number[], T>(lengths: L, operation: (memory: { [K in keyof L]: Memory }) => T): T {
    if (this.poisoned) throw new PrivateStorageError('unavailable', 'unsettled native operation')
    const blocks: Memory[] = []
    try {
      for (const length of lengths) blocks.push(new Memory(this.k, length))
      return operation(blocks as { [K in keyof L]: Memory })
    } finally { for (const block of blocks.reverse()) block.close() }
  }

  private win32(operation: string): never {
    const code = this.calls.getLastError()
    throw new PrivateStorageError(code === 32 ? 'sharing' : code === 33 ? 'busy' : 'native', operation, { win32Code: code })
  }

  private status(operation: string, value: number): void {
    const status = value >>> 0
    if (status === 0) return
    const code = status === 0xC0000034 || status === 0xC000003A ? 'not-found'
      : status === 0xC0000035 ? 'collision' : status === 0xC0000043 ? 'sharing'
        : status === 0xC0000003 || status === 0xC00000BB ? 'unsupported' : 'native'
    throw new PrivateStorageError(code, operation, { nativeStatus: status })
  }

  private complete(value: number, handle: Handle, status: Memory, blocks: readonly Memory[]): number {
    if ((value >>> 0) !== 0x103) return value
    let waited = 0xFFFFFFFF
    try { if (handle !== 0n) waited = this.calls.waitForSingleObject(handle, 0xFFFFFFFF) }
    catch (_waitError) { /* Unknown completion retains native memory and poisons this backend below. */ }
    if (waited !== 0 || status.bytes.readUInt32LE(0) === 0x103) {
      this.poisoned = true
      for (const block of blocks) { block.quarantined = true; this.pending.push(block) }
      throw new PrivateStorageError('unavailable', 'native completion uncertain')
    }
    return status.bytes.readInt32LE(0)
  }

  /** Close an owned handle exactly once; the caller must invalidate its capability first. */
  close(handle: Handle): void {
    // Keep the DLL owners live until after the synchronous native invocation.
    if (this.libraries.length !== 3 || !this.calls.closeHandle(handle)) this.win32('CloseHandle')
  }

  /** Query only the current process TokenUser; reject thread impersonation and restricted tokens. */
  tokenUser(): Buffer {
    return this.memory([8, 4], ([slot, size]) => {
      if (this.calls.openThreadToken(this.calls.getCurrentThread(), 8, 1, slot.pointer)) {
        this.close(slot.bytes.readBigUInt64LE())
        throw new PrivateStorageError('unsupported', 'thread impersonation')
      }
      const threadError = this.calls.getLastError()
      if (threadError !== 1008) throw new PrivateStorageError('native', 'OpenThreadToken', { win32Code: threadError })
      slot.bytes.fill(0)
      if (!this.calls.openProcessToken(this.calls.getCurrentProcess(), 8, slot.pointer)) this.win32('OpenProcessToken')
      const token = slot.bytes.readBigUInt64LE()
      try {
        if (this.calls.isTokenRestricted(token)) throw new PrivateStorageError('unsupported', 'restricted process token')
        if (this.calls.getTokenInformation(token, 1, null, 0, size.pointer)) throw new PrivateStorageError('native', 'TokenUser size query')
        if (this.calls.getLastError() !== 122) this.win32('TokenUser size query')
        const length = size.bytes.readUInt32LE()
        if (length < 16 || length > 65536) throw new PrivateStorageError('privacy', 'TokenUser bounds')
        return this.memory([length], ([info]) => {
          if (!this.calls.getTokenInformation(token, 1, info.pointer, length, size.pointer)) this.win32('TokenUser')
          const returned = size.bytes.readUInt32LE()
          const offset = info.bytes.readBigUInt64LE() - this.k.address(info.pointer)
          if (returned > length || offset < 16n || offset + 8n > BigInt(returned)) throw new PrivateStorageError('privacy', 'TokenUser SID pointer')
          const begin = Number(offset)
          const sidLength = 8 + 4 * info.bytes.readUInt8(begin + 1)
          if (begin + sidLength > returned) throw new PrivateStorageError('privacy', 'TokenUser SID length')
          const sid = Buffer.from(info.bytes.subarray(begin, begin + sidLength))
          validateSid(sid)
          return sid
        })
      } finally { this.close(token) }
    })
  }

  /** Open exactly one component, or the validated trusted volume bootstrap, without reparsing. */
  open(parent: Handle | null, name: string, kind: 'file' | 'directory' | 'any', mode: 'inspect' | 'read' | 'read-source' | 'create' | 'lock' | 'delete' | 'log', sid: Buffer): Handle {
    const text = Buffer.from(name, 'utf16le')
    const descriptor = mode === 'create' || mode === 'log' ? privateDescriptor(sid, kind === 'directory') : Buffer.alloc(0)
    return this.memory([8, ABI.unicodeString, ABI.objectAttributes, ABI.ioStatus, text.length + 2, descriptor.length || 1], (blocks) => {
      const [result, unicode, attributes, status, nameBuffer, sd] = blocks as [Memory, Memory, Memory, Memory, Memory, Memory]
      text.copy(nameBuffer.bytes)
      descriptor.copy(sd.bytes)
      unicode.bytes.writeUInt16LE(text.length, 0)
      unicode.bytes.writeUInt16LE(text.length + 2, 2)
      unicode.bytes.writeBigUInt64LE(this.k.address(nameBuffer.pointer), 8)
      attributes.bytes.writeUInt32LE(ABI.objectAttributes, 0)
      attributes.bytes.writeBigUInt64LE(parent ?? 0n, 8)
      attributes.bytes.writeBigUInt64LE(this.k.address(unicode.pointer), 16)
      attributes.bytes.writeUInt32LE(0x1040, 24)
      if (descriptor.length) attributes.bytes.writeBigUInt64LE(this.k.address(sd.pointer), 32)
      const access = 0x120080 | (kind === 'directory' ? 0x21 : mode === 'read' || mode === 'read-source' ? 1 : mode === 'lock' ? 3 : 0)
        | (mode === 'log' ? 0x40000000 : 0)
        | (mode === 'create' ? 0x10000 | (kind === 'file' ? 3 : 0) : mode === 'delete' ? 0x10000 : 0)
      const share = mode === 'lock' || kind === 'directory' ? 3 : mode === 'create' || mode === 'read-source' || mode === 'log' ? 1 : mode === 'read' ? 5 : 7
      const options = 0x200020 | (kind === 'directory' ? 1 : kind === 'file' ? 0x40 : 0) | (mode === 'create' || mode === 'log' ? 2 : 0)
      const value = this.calls.ntCreateFile(result.pointer, access, attributes.pointer, status.pointer, null, 0x80, share, mode === 'create' ? 2 : mode === 'log' ? 3 : 1, options, null, 0)
      const handle = result.bytes.readBigUInt64LE()
      const completed = this.complete(value, handle, status, blocks)
      this.status('NtCreateFile', completed)
      if (handle === 0n || handle === 0xFFFFFFFFFFFFFFFFn) throw new PrivateStorageError('native', 'invalid returned handle')
      return handle
    })
  }

  private query(handle: Handle, cls: number, length: number, volume = false): Buffer {
    return this.memory([ABI.ioStatus, length], (blocks) => {
      const [status, result] = blocks as [Memory, Memory]
      const call = volume ? this.calls.ntQueryVolumeInformationFile : this.calls.ntQueryInformationFile
      this.status('native query', this.complete(call(handle, status.pointer, result.pointer, length, cls), handle, status, blocks))
      const returned = status.bytes.readBigUInt64LE(8)
      if (returned > BigInt(length) || returned < BigInt(length === 65540 ? 4 : length)) throw new PrivateStorageError('native', 'incomplete native query')
      return Buffer.from(result.bytes.subarray(0, Number(returned)))
    })
  }

  /** Admit disk-local NTFS with persistent ACLs, no remote device and ordinary case comparison. */
  admitFilesystem(handle: Handle): void { this.filesystem(handle, true) }

  /** Admit a retained source directory on local NTFS without requiring writable backing. */
  admitSourceFilesystem(handle: Handle): NativeFilesystemFacts { return this.filesystem(handle, false) }

  private filesystem(handle: Handle, writable: boolean): NativeFilesystemFacts {
    if (this.calls.getFileType(handle) !== 1) throw new PrivateStorageError('unsupported', 'disk file required')
    const device = this.query(handle, 4, 8, true)
    if (device.readUInt32LE(0) !== 7 || (device.readUInt32LE(4) & (writable ? 0x305A : 0x3058)) !== 0
      || this.query(handle, 51, 1)[0] !== 0) throw new PrivateStorageError('unsupported', writable ? 'persistent writable local disk required' : 'persistent local source disk required')
    const flags = this.memory([4, 4, 4, 64], ([serial, component, attributes, filesystem]) => {
      if (!this.calls.getVolumeInformationByHandleW(handle, null, 0, serial.pointer, component.pointer, attributes.pointer, filesystem.pointer, 32)) this.win32('GetVolumeInformationByHandleW')
      const name = filesystem.bytes.toString('utf16le').split('\0')[0]
      const flags = attributes.bytes.readUInt32LE()
      if (name !== 'NTFS' || (flags & 8) === 0 || (writable && (flags & 0x80000) !== 0)) throw new PrivateStorageError('unsupported', writable ? 'writable ACL-capable NTFS required' : 'ACL-capable source NTFS required')
      return flags
    })
    if (this.query(handle, 71, 4).readUInt32LE() !== 0) throw new PrivateStorageError('unsupported', 'case-sensitive directory')
    return Object.freeze({ filesystem: 'NTFS', flags, deviceType: 7, deviceCharacteristics: device.readUInt32LE(4) })
  }

  /** Observe caller-available allocation units through the retained directory; this never reserves storage. */
  capacity(handle: Handle): { allocationUnitBytes: bigint; availableBytes: bigint } {
    this.admitFilesystem(handle)
    const value = this.query(handle, 7, 32, true)
    const total = value.readBigInt64LE(0), caller = value.readBigInt64LE(8), actual = value.readBigInt64LE(16)
    const sectors = value.readUInt32LE(24), bytes = value.readUInt32LE(28)
    if (total < 0n || caller < 0n || actual < 0n || caller > total || caller > actual || sectors === 0 || bytes === 0) {
      throw new PrivateStorageError('native', 'invalid filesystem capacity observations')
    }
    const allocationUnitBytes = BigInt(sectors) * BigInt(bytes)
    return Object.freeze({ allocationUnitBytes, availableBytes: caller * allocationUnitBytes })
  }

  /** Reject DOS short aliases and case-only alternative spellings by normalized handle name. */
  verifyName(handle: Handle, expected: string): void {
    const bytes = this.query(handle, 48, 65540)
    const length = bytes.readUInt32LE()
    if (length % 2 || length > bytes.length - 4) throw new PrivateStorageError('native', 'normalized name bounds')
    const full = bytes.toString('utf16le', 4, 4 + length)
    if (full.slice(full.lastIndexOf('\\') + 1) !== expected) throw new PrivateStorageError('name', 'literal long-name binding required')
  }

  private security<T>(handle: Handle, observe: (descriptor: Buffer) => T): T {
    return this.memory([8], ([slot]) => {
      const result = this.calls.getSecurityInfo(handle, 1, 5, null, null, null, null, slot.pointer)
      if (result !== 0) throw new PrivateStorageError('native', 'GetSecurityInfo', { win32Code: result })
      const pointer = slot.bytes.readBigUInt64LE()
      if (pointer === 0n) throw new PrivateStorageError('privacy', 'missing security descriptor')
      try {
        const length = this.calls.getSecurityDescriptorLength(pointer)
        if (length < 20 || length > 65536) throw new PrivateStorageError('privacy', 'security descriptor bounds')
        return observe(Buffer.from(this.k.view(pointer, length)))
      } finally {
        const remaining = this.calls.localFree(pointer)
        if (remaining !== null && remaining !== 0n) throw new PrivateStorageError('native', 'LocalFree')
      }
    })
  }

  /** Inspect the same handle; ancestors may omit only the owner-only privacy check. */
  inspect(handle: Handle, sid: Buffer, privacy = true): NativeFacts {
    const facts = this.objectFacts(handle, true)
    if (privacy) this.security(handle, (descriptor) => { verifyPrivateDescriptor(descriptor, sid, facts.kind === 'directory') })
    return Object.freeze({ ...facts, ownerSid: sid.toString('hex'), daclProtected: true })
  }

  /** Observe a live no-reparse source, including hardlinked files, without asserting private security. */
  inspectSource(handle: Handle): NativeSourceFacts {
    const facts = this.objectFacts(handle, false)
    const securityDescriptorSha256 = this.security(handle, descriptor => createHash('sha256').update(descriptor).digest('hex'))
    return Object.freeze({ ...facts, securityDescriptorSha256 })
  }

  /** Observe a previously admitted retired record; this result grants no live-file admission. */
  inspectRetiredPrivate(handle: Handle, sid: Buffer): NativeSourceFacts & { readonly deletePending: boolean } {
    const facts = this.objectFacts(handle, false, true)
    const securityDescriptorSha256 = this.security(handle, (descriptor) => {
      verifyPrivateDescriptor(descriptor, sid, false)
      return createHash('sha256').update(descriptor).digest('hex')
    })
    const standard = this.query(handle, 5, ABI.standard)
    if (standard.readUInt8(20) > 1 || standard.readUInt32LE(16) !== facts.links || standard[21] !== 0) {
      throw new PrivateStorageError('changed', 'retired record observations changed')
    }
    return Object.freeze({ ...facts, securityDescriptorSha256, deletePending: standard[20] === 1 })
  }

  private objectFacts(handle: Handle, singleLink: boolean, retired = false): Omit<NativeFacts, 'ownerSid' | 'daclProtected'> {
    if (this.calls.getFileType(handle) !== 1) throw new PrivateStorageError('unsupported', 'disk object required')
    const basic = this.query(handle, 4, ABI.basic)
    const standard = this.query(handle, 5, ABI.standard)
    const mode = this.query(handle, 16, ABI.mode)
    const facts = decodeNativeMetadata(basic, standard, mode, singleLink, retired)
    const identity = this.memory([ABI.fileId], ([id]) => {
      if (!this.calls.getFileInformationByHandleEx(handle, 18, id.pointer, ABI.fileId)) this.win32('FILE_ID_INFO')
      return decodeNativeIdentity(id.bytes)
    })
    return Object.freeze({ ...facts, identity })
  }

  /** Read at most one bounded chunk through the retained synchronous handle. */
  read(handle: Handle, output: Buffer): number {
    return this.memory([4], ([count]) => {
      if (!this.calls.readFile(handle, output, output.length, count.pointer, null)) this.win32('ReadFile')
      const bytes = count.bytes.readUInt32LE()
      if (bytes > output.length) throw new PrivateStorageError('native', 'ReadFile count')
      return bytes
    })
  }

  /** Write all bytes, rejecting zero progress and impossible native counts. */
  write(handle: Handle, input: Buffer): void {
    this.memory([4], ([count]) => {
      let offset = 0
      while (offset < input.length) {
        const chunk = input.subarray(offset, Math.min(offset + 65536, input.length))
        if (!this.calls.writeFile(handle, chunk, chunk.length, count.pointer, null)) this.win32('WriteFile')
        const bytes = count.bytes.readUInt32LE()
        if (bytes === 0 || bytes > chunk.length) throw new PrivateStorageError('native', 'WriteFile progress')
        offset += bytes
      }
    })
  }

  /** Append at the kernel EOF sentinel; callers cannot select offsets or overwrite existing bytes. */
  append(handle: Handle, input: Buffer): void {
    this.memory([ABI.ioStatus, 8], (blocks) => {
      const [status, end] = blocks as [Memory, Memory]
      end.bytes.writeBigInt64LE(-1n)
      let offset = 0
      while (offset < input.length) {
        const chunk = input.subarray(offset, Math.min(offset + 65536, input.length))
        const returned = this.calls.ntWriteFile(handle, null, null, null, status.pointer, chunk, chunk.length, end.pointer, null)
        this.status('NtWriteFile append', this.complete(returned, handle, status, blocks))
        const written = status.bytes.readBigUInt64LE(8)
        if (written === 0n || written > BigInt(chunk.length)) throw new PrivateStorageError('native', 'append progress')
        offset += Number(written)
      }
    })
  }

  /** Full data, metadata and device-cache flush, without weaker flags. */
  flush(handle: Handle): void { if (!this.calls.flushFileBuffers(handle)) this.win32('FlushFileBuffers') }

  /** Rename the retained write-through source relative to an admitted parent. */
  rename(handle: Handle, parent: Handle, name: string, replace: boolean): void {
    const text = Buffer.from(name, 'utf16le')
    this.memory([ABI.ioStatus, ABI.renameSize + text.length], (blocks) => {
      const [status, rename] = blocks as [Memory, Memory]
      rename.bytes.writeUInt32LE(replace ? 3 : 0)
      rename.bytes.writeBigUInt64LE(parent, ABI.renameRoot)
      rename.bytes.writeUInt32LE(text.length, ABI.renameLength)
      text.copy(rename.bytes, ABI.renameName)
      this.status('NtSetInformationFile rename', this.complete(this.calls.ntSetInformationFile(handle, status.pointer, rename.pointer, rename.bytes.length, 65), handle, status, blocks))
    })
  }

  /** Set deletion disposition only on the checked retained object. */
  remove(handle: Handle): void {
    this.memory([ABI.ioStatus, 1], (blocks) => {
      const [status, disposition] = blocks as [Memory, Memory]
      disposition.bytes[0] = 1
      this.status('NtSetInformationFile disposition', this.complete(this.calls.ntSetInformationFile(handle, status.pointer, disposition.pointer, 1, 13), handle, status, blocks))
    })
  }

  /** Acquire a nonblocking exclusive byte-range lease; its OVERLAPPED survives until release. */
  lock(handle: Handle): () => void {
    const overlapped = new Memory(this.k, ABI.overlapped)
    try {
      if (!this.calls.lockFileEx(handle, 3, 0, 1, 0, overlapped.pointer)) this.win32('LockFileEx')
    } catch (error) { overlapped.close(); throw error }
    let released = false
    return () => {
      if (released) return
      released = true
      try { if (!this.calls.unlockFileEx(handle, 0, 1, 0, overlapped.pointer)) this.win32('UnlockFileEx') }
      finally { overlapped.close() }
    }
  }

  /** Enumerate through a retained directory under caller-held cooperative quiescence. */
  names(handle: Handle, maximum: number): string[] {
    return this.memory([ABI.ioStatus, 65536], (blocks) => {
      const [status, data] = blocks as [Memory, Memory]
      const names: string[] = []
      let restart = 1
      let records = 0
      for (;;) {
        const result = this.calls.ntQueryDirectoryFile(
          handle, null, null, null, status.pointer, data.pointer, data.bytes.length, 12, 0, null, restart,
        )
        const value = this.complete(result, handle, status, blocks)
        if ((value >>> 0) === 0x80000006) return names
        this.status('NtQueryDirectoryFile', value)
        restart = 0
        const length = Number(status.bytes.readBigUInt64LE(8))
        if (length < 12 || length > data.bytes.length) throw new PrivateStorageError('native', 'directory result bounds')
        let offset = 0
        for (;;) {
          if (offset + 12 > length) throw new PrivateStorageError('native', 'directory record bounds')
          const next = data.bytes.readUInt32LE(offset)
          const size = data.bytes.readUInt32LE(offset + 8)
          if (size % 2 || size === 0 || offset + 12 + size > length || (next !== 0 && (next < 12 + size || next % 4))) throw new PrivateStorageError('native', 'directory name bounds')
          // Count dot entries as scanned work so nonprogressing pages cannot evade the audit limit.
          if (++records > maximum + 2) throw new PrivateStorageError('limit', 'directory audit scanned record count')
          const name = data.bytes.toString('utf16le', offset + 12, offset + 12 + size)
          if (name !== '.' && name !== '..') names.push(name)
          if (names.length > maximum) throw new PrivateStorageError('limit', 'directory audit entry count')
          if (next === 0) break
          offset += next
        }
      }
    })
  }
}

/** Retained operation interface shared by the FFI model and native environment-owned production provider. */
export type NativeStorageBackend = Pick<NativeStorage, keyof NativeStorage> & {
  readonly ownershipArtifact?: import('@deepseek-ai/node-addon-system/windows-private-owner').WindowsPrivateOwnerRuntimeIdentity
  observeLink(parent: Handle, name: string, maximum: number): SourceLinkObservation
}

/**
 * Load pinned Windows x64 payloads and require native environment ownership; never compile or fall back.
 * @returns Environment-owned native calls with actual selected artifact identities.
 */
export function loadNativeStorage(): NativeStorageBackend {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new PrivateStorageError('unavailable', 'Windows x64 backend required')
  if (loaded) return loaded
  try {
    const entry = require.resolve('koffi')
    const fromKoffi = createRequire(entry)
    const platformPackage = '@koromix/koffi-win32-x64'
    const platformEntry = fromKoffi.resolve(platformPackage)
    const staticEntry = realpathSync(join(dirname(entry), 'src/koffi/src/static.cjs'))
    const fromStatic = createRequire(staticEntry)
    if (realpathSync(fromStatic.resolve(platformPackage)) !== realpathSync(platformEntry)) {
      throw new PrivateStorageError('unavailable', 'shadowed platform dependency')
    }
    const binary = realpathSync(join(dirname(platformEntry), 'win32_x64', 'koffi.node'))
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(platformEntry), 'package.json'), 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== '3.1.1') throw new PrivateStorageError('unavailable', 'pinned platform package required')
    const selected: unknown = fromKoffi(binary)
    if (fromKoffi(platformPackage) !== selected) throw new PrivateStorageError('unavailable', 'platform native export mismatch')
    const k = require('koffi') as Koffi & { readonly default: unknown }
    if (k.version !== '3.1.1' || k.default !== selected
      || !Object.keys(require.cache).some(path => path.endsWith('.node') && realpathSync(path) === binary)) {
      throw new PrivateStorageError('unavailable', 'selected native binary mismatch')
    }
    const nativeArtifact = Object.freeze({ koffiVersion: '3.1.1' as const, platformPackage, nativeBinarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') })
    const owner = loadWindowsPrivateOwner()
    const identity = inspectWindowsPrivateOwnerRuntime()
    loaded = new OwnedNativeStorage(owner, nativeArtifact, identity)
    return loaded
  } catch (error) {
    if (error instanceof PrivateStorageError) throw error
    throw new PrivateStorageError('unavailable', 'pinned native dependency unavailable')
  }
}
