/** Opaque native environment ownership with private monotonic IDs, never JavaScript-owned Win32 handles. */
import { createHash } from 'node:crypto'
import type { WindowsPrivateOwner, WindowsPrivateFile, WindowsPrivateOwnerRuntimeIdentity } from '@deepseek-ai/node-addon-system/windows-private-owner'
import { PrivateStorageError } from './error.ts'
import type { PrivateStorageErrorCode } from './error.ts'
import { decodeNativeIdentity, decodeNativeMetadata } from './native-observations.ts'
import { decodeWindowsLink } from './windows-link-data.ts'
import type { SourceLinkFacts, SourceLinkObservation } from './source-link.ts'
import { privateDescriptor, validateSid, verifyPrivateDescriptor } from './policy.ts'
import type { Handle, NativeFacts, NativeSourceFacts, NativeFilesystemFacts, NativeStorageBackend } from './native.ts'

const classifications = new Set<PrivateStorageErrorCode>(['unavailable', 'unsupported', 'name', 'privacy', 'identity', 'changed',
  'limit', 'not-found', 'collision', 'sharing', 'busy', 'closed', 'native'])
function nativeFailure(error: unknown): PrivateStorageError {
  if (error instanceof PrivateStorageError) return error
  const field = (name: string): unknown => error !== null && typeof error === 'object' && name in error
    ? Reflect.get(error, name) : undefined
  const integer = (name: string): number | null => {
    const value = field(name)
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null
  }
  const nativeStatus = integer('nativeStatus'), win32Code = integer('win32Code'), declared = field('code')
  let code: PrivateStorageErrorCode = typeof declared === 'string' && classifications.has(declared as PrivateStorageErrorCode)
    ? declared as PrivateStorageErrorCode : 'native'
  if (code === 'native') {
    if (nativeStatus === 0xc0000034 || nativeStatus === 0xc000003a || win32Code === 2 || win32Code === 3) code = 'not-found'
    else if (nativeStatus === 0xc0000035 || win32Code === 80 || win32Code === 183) code = 'collision'
    else if (nativeStatus === 0xc0000043 || win32Code === 32) code = 'sharing'
    else if (nativeStatus === 0xc0000054 || win32Code === 33) code = 'busy'
    else if (nativeStatus === 0xc0000022 || win32Code === 5) code = 'privacy'
    else if (field('pending') === true) code = 'unavailable'
  }
  const failure = new PrivateStorageError(code, 'native owner operation failed', {
    ...nativeStatus === null ? {} : { nativeStatus }, ...win32Code === null ? {} : { win32Code }, cleanupFailed: field('cleanupFailed') === true,
  })
  failure.cause = error
  return failure
}

/** Native-owned production backend; its numeric IDs index opaque capabilities only within this provider instance. */
export class OwnedNativeStorage implements NativeStorageBackend {
  readonly artifact: NativeStorageBackend['artifact']
  readonly ownershipArtifact: WindowsPrivateOwnerRuntimeIdentity
  private readonly owner: WindowsPrivateOwner
  private readonly files = new Map<Handle, WindowsPrivateFile>()
  private nextId = 1n
  constructor(owner: WindowsPrivateOwner, artifact: NativeStorageBackend['artifact'], identity: WindowsPrivateOwnerRuntimeIdentity) {
    this.owner = owner; this.artifact = artifact; this.ownershipArtifact = identity
  }
  private invoke<T>(operation: () => T): T { try { return operation() } catch (error) { throw nativeFailure(error) } }
  private file(id: Handle): WindowsPrivateFile {
    const file = this.files.get(id)
    if (file === undefined) throw new PrivateStorageError('closed', 'native capability was retired or belongs to another provider')
    return file
  }
  private query(handle: Handle, cls: number, length: number, volume = false): Buffer {
    const value = this.invoke(() => Buffer.from(this.owner.query(this.file(handle), cls, length, volume)))
    if (value.length > length || value.length < (length === 65540 ? 4 : length)) throw new PrivateStorageError('native', 'incomplete native query')
    return value
  }
  tokenUser(): Buffer {
    const sid = this.invoke(() => Buffer.from(this.owner.tokenUser()))
    validateSid(sid)
    return sid
  }
  close(handle: Handle): void {
    const file = this.file(handle)
    this.files.delete(handle)
    this.invoke(() => { this.owner.close(file) })
  }
  open(parent: Handle | null, name: string, kind: 'file' | 'directory' | 'any',
    mode: 'inspect' | 'read' | 'read-source' | 'create' | 'lock' | 'delete' | 'log', sid: Buffer): Handle {
    const descriptor = mode === 'create' || mode === 'log' ? privateDescriptor(sid, kind === 'directory') : null
    const file = this.invoke(() => this.owner.open(parent === null ? null : this.file(parent), name, kind, mode, descriptor))
    const id = this.nextId++
    this.files.set(id, file)
    return id
  }
  private filesystem(handle: Handle, writable: boolean): NativeFilesystemFacts {
    if (this.invoke(() => this.owner.fileType(this.file(handle))) !== 1) throw new PrivateStorageError('unsupported', 'disk file required')
    const device = this.query(handle, 4, 8, true)
    if (device.readUInt32LE() !== 7 || (device.readUInt32LE(4) & (writable ? 0x305a : 0x3058)) !== 0
      || this.query(handle, 51, 1)[0] !== 0) throw new PrivateStorageError('unsupported', 'persistent local disk required')
    const volume = this.invoke(() => this.owner.volumeInfo(this.file(handle)))
    if (volume.filesystem !== 'NTFS' || (volume.flags & 8) === 0 || writable && (volume.flags & 0x80000) !== 0) {
      throw new PrivateStorageError('unsupported', 'admitted ACL-capable NTFS required')
    }
    if (this.query(handle, 71, 4).readUInt32LE() !== 0) throw new PrivateStorageError('unsupported', 'case-sensitive directory')
    return Object.freeze({ filesystem: 'NTFS', flags: volume.flags, deviceType: 7, deviceCharacteristics: device.readUInt32LE(4) })
  }
  admitFilesystem(handle: Handle): void { this.filesystem(handle, true) }
  admitSourceFilesystem(handle: Handle): NativeFilesystemFacts { return this.filesystem(handle, false) }
  capacity(handle: Handle): { allocationUnitBytes: bigint; availableBytes: bigint } {
    this.admitFilesystem(handle)
    const bytes = this.query(handle, 7, 32, true)
    const total = bytes.readBigInt64LE(), caller = bytes.readBigInt64LE(8), actual = bytes.readBigInt64LE(16)
    const sectors = bytes.readUInt32LE(24), sectorBytes = bytes.readUInt32LE(28)
    if (total < 0n || caller < 0n || actual < 0n || caller > total || caller > actual || sectors === 0 || sectorBytes === 0) {
      throw new PrivateStorageError('native', 'invalid filesystem capacity observations')
    }
    const allocationUnitBytes = BigInt(sectors) * BigInt(sectorBytes)
    return Object.freeze({ allocationUnitBytes, availableBytes: caller * allocationUnitBytes })
  }
  verifyName(handle: Handle, expected: string): void {
    const bytes = this.query(handle, 48, 65540), length = bytes.readUInt32LE()
    if (length % 2 || length > bytes.length - 4) throw new PrivateStorageError('native', 'normalized name bounds')
    const name = bytes.toString('utf16le', 4, 4 + length)
    if (name.slice(name.lastIndexOf('\\') + 1) !== expected) throw new PrivateStorageError('name', 'literal long-name binding required')
  }
  private security(handle: Handle): Buffer {
    const bytes = this.invoke(() => Buffer.from(this.owner.security(this.file(handle))))
    if (bytes.length < 20 || bytes.length > 65536) throw new PrivateStorageError('privacy', 'security descriptor bounds')
    return bytes
  }
  private objectFacts(handle: Handle, singleLink: boolean, retired = false): Omit<NativeFacts, 'ownerSid' | 'daclProtected'> {
    if (this.invoke(() => this.owner.fileType(this.file(handle))) !== 1) throw new PrivateStorageError('unsupported', 'disk object required')
    const facts = decodeNativeMetadata(this.query(handle, 4, 40), this.query(handle, 5, 24), this.query(handle, 16, 4), singleLink, retired)
    const identity = decodeNativeIdentity(this.invoke(() => Buffer.from(this.owner.fileId(this.file(handle)))))
    return Object.freeze({ ...facts, identity })
  }
  inspect(handle: Handle, sid: Buffer, privacy = true): NativeFacts {
    const facts = this.objectFacts(handle, true)
    if (privacy) verifyPrivateDescriptor(this.security(handle), sid, facts.kind === 'directory')
    return Object.freeze({ ...facts, ownerSid: sid.toString('hex'), daclProtected: true })
  }
  inspectSource(handle: Handle): NativeSourceFacts {
    const facts = this.objectFacts(handle, false)
    return Object.freeze({ ...facts, securityDescriptorSha256: createHash('sha256').update(this.security(handle)).digest('hex') })
  }
  observeLink(parent: Handle, name: string, maximum: number): SourceLinkObservation {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32768) throw new RangeError('link target bound must be 1 through 32768')
    const parentIdentity = this.inspectSource(parent).identity
    const file = this.invoke(() => this.owner.open(this.file(parent), name, 'any', 'read-link', null))
    const handle = this.nextId++
    this.files.set(handle, file)
    const inspect = (): { facts: SourceLinkFacts; literalTarget: string; relative: boolean } => {
      this.verifyName(handle, name)
      const basic = this.query(handle, 4, 40), standard = this.query(handle, 5, 24), mode = this.query(handle, 16, 4)
      const attributes = basic.readUInt32LE(32)
      if ((attributes & 0x400) === 0) throw new PrivateStorageError('unsupported', 'symbolic-link reparse leaf required')
      const plain = Buffer.from(basic); plain.writeUInt32LE(attributes & ~0x400, 32)
      const metadata = decodeNativeMetadata(plain, standard, mode, false)
      const identity = decodeNativeIdentity(this.invoke(() => Buffer.from(this.owner.fileId(file))))
      if (metadata.links < 1 || identity.volumeSerial !== parentIdentity.volumeSerial
        || this.invoke(() => this.owner.fileType(file)) !== 1) throw new PrivateStorageError('identity', 'live same-volume disk link required')
      const bytes = this.invoke(() => Buffer.from(this.owner.reparse(file))), target = decodeWindowsLink(bytes, maximum)
      const observations = Object.freeze({ attributes, sizeBytes: metadata.sizeBytes.toString(),
        lastWriteTime: metadata.lastWriteTime.toString(), changeTime: metadata.changeTime.toString(),
        securityDescriptorSha256: createHash('sha256').update(this.security(handle)).digest('hex'),
        reparseSha256: createHash('sha256').update(bytes).digest('hex') })
      return { ...target, facts: Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...identity }),
        links: metadata.links, observations, changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex') }) }
    }
    let result: SourceLinkObservation
    try {
      const before = inspect(), after = inspect()
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new PrivateStorageError('changed', 'retained symbolic-link observations changed')
      result = Object.freeze({ kind: 'symbolic-link', literalTarget: before.literalTarget, relative: before.relative,
        before: before.facts, after: after.facts })
    } catch (error) {
      try { this.close(handle) } catch (cleanup) { throw new AggregateError([error, cleanup], 'link observation and release failed') }
      throw error
    }
    this.close(handle)
    return result
  }
  inspectRetiredPrivate(handle: Handle, sid: Buffer): NativeSourceFacts & { readonly deletePending: boolean } {
    const facts = this.objectFacts(handle, false, true), security = this.security(handle)
    verifyPrivateDescriptor(security, sid, false)
    const standard = this.query(handle, 5, 24)
    if (standard.readUInt8(20) > 1 || standard.readUInt32LE(16) !== facts.links || standard[21] !== 0) {
      throw new PrivateStorageError('changed', 'retired record observations changed')
    }
    return Object.freeze({ ...facts, securityDescriptorSha256: createHash('sha256').update(security).digest('hex'), deletePending: standard[20] === 1 })
  }
  read(handle: Handle, output: Buffer): number {
    const bytes = this.invoke(() => this.owner.read(this.file(handle), output.length))
    if (bytes.byteLength > output.length) throw new PrivateStorageError('native', 'read count')
    output.set(bytes)
    return bytes.byteLength
  }
  private writeAll(handle: Handle, input: Buffer, append: boolean): void {
    let offset = 0
    while (offset < input.length) {
      const chunk = input.subarray(offset, Math.min(offset + 65536, input.length))
      const written = this.invoke(() => this.owner.write(this.file(handle), chunk, append))
      if (!Number.isSafeInteger(written) || written < 1 || written > chunk.length) throw new PrivateStorageError('native', 'write progress')
      offset += written
    }
  }
  write(handle: Handle, input: Buffer): void { this.writeAll(handle, input, false) }
  append(handle: Handle, input: Buffer): void { this.writeAll(handle, input, true) }
  flush(handle: Handle): void { this.invoke(() => { this.owner.flush(this.file(handle)) }) }
  rename(handle: Handle, parent: Handle, name: string, replace: boolean): void {
    this.invoke(() => { this.owner.rename(this.file(handle), this.file(parent), name, replace) })
  }
  remove(handle: Handle): void { this.invoke(() => { this.owner.remove(this.file(handle)) }) }
  lock(handle: Handle): () => void {
    const file = this.file(handle)
    this.invoke(() => { this.owner.lock(file) })
    let released = false
    return () => { if (released) return; released = true; this.invoke(() => { this.owner.unlock(file) }) }
  }
  names(handle: Handle, maximum: number): string[] { return [...this.invoke(() => this.owner.names(this.file(handle), maximum))] }
}
