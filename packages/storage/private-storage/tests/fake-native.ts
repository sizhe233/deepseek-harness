/** Synthetic in-memory syscall model for failure-state tests, never native conformance evidence. */
import { PrivateStorageError } from '../src/error.ts'
import type { NativeFacts, NativeStorageBackend as NativeStorage } from '../src/native.ts'

interface Entry { parent: bigint | null; name: string; facts: NativeFacts; bytes: Buffer }
export class FakeNative {
  readonly artifact = { koffiVersion: '3.1.1' as const, platformPackage: 'synthetic', nativeBinarySha256: '0'.repeat(64) }
  readonly events: string[] = []
  readonly handles = new Map<bigint, { entry: Entry; offset: number; listable: boolean; access?: number; share?: number }>()
  readonly entries = new Map<bigint, Entry>()
  readonly sid = Buffer.from('0102000000000005150000002a000000', 'hex')
  hook: (operation: string, handle?: bigint) => void = () => {}
  next = 10n
  nextId = 1n
  constructor() {
    this.add(null, '\\??\\C:\\', 'directory')
    this.add(1n, 'private', 'directory')
  }
  add(parent: bigint | null, name: string, kind: 'file' | 'directory', bytes = Buffer.alloc(0)): bigint {
    const id = this.nextId++
    const facts: NativeFacts = Object.freeze({ complete: true, identity: { volumeSerial: '0000000000000001', fileId: id.toString(16).padStart(32, '0') }, kind, links: 1, sizeBytes: BigInt(bytes.length), ownerSid: this.sid.toString('hex'), daclProtected: true, writeThrough: true, lastWriteTime: 1n, changeTime: 1n, attributes: 0 })
    this.entries.set(id, { parent, name, facts, bytes })
    return id
  }
  entry(handle: bigint): Entry { const value = this.handles.get(handle); if (!value) throw new Error('invalid synthetic handle'); return value.entry }
  id(handle: bigint): bigint { return BigInt(`0x${this.entry(handle).facts.identity.fileId}`) }
  event(operation: string, handle?: bigint): void { this.events.push(operation); this.hook(operation, handle) }
  tokenUser(): Buffer { this.event('token'); return Buffer.from(this.sid) }
  open(parent: bigint | null, name: string, kind: 'file' | 'directory' | 'any', mode: string): bigint {
    this.event(`open:${mode}`)
    const parentId = parent === null ? null : this.id(parent)
    let entry = [...this.entries.values()].find(item => item.parent === parentId && item.name === name)
    if (mode === 'create' || mode === 'log' && entry === undefined) {
      if (entry) throw new PrivateStorageError('collision', 'synthetic create')
      entry = this.entries.get(this.add(parentId, name, kind === 'any' ? 'file' : kind))!
    }
    if (!entry) throw new PrivateStorageError('not-found', 'synthetic open')
    const access = mode === 'log' ? 2 : mode === 'create' ? kind === 'directory' ? 5 : 7 : mode === 'delete' ? 4
      : kind === 'directory' || mode === 'read' || mode === 'read-source' ? 1 : mode === 'lock' ? 3 : 0
    const share = mode === 'lock' || kind === 'directory' ? 3 : mode === 'create' || mode === 'read-source' || mode === 'log' ? 1 : mode === 'read' ? 5 : 7
    for (const opened of this.handles.values()) {
      if (opened.entry === entry && ((access & ~(opened.share ?? 7)) !== 0 || ((opened.access ?? 0) & ~share) !== 0)) {
        throw new PrivateStorageError('sharing', 'synthetic sharing denial', { win32Code: 32 })
      }
    }
    const handle = this.next++
    this.handles.set(handle, { entry, offset: 0, listable: kind === 'directory', access, share })
    return handle
  }
  close(handle: bigint): void { this.event('close', handle); this.handles.delete(handle) }
  inspect(handle: bigint): NativeFacts { this.event('inspect', handle); return this.entry(handle).facts }
  inspectSource(handle: bigint) {
    const { ownerSid: _owner, daclProtected: _protected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
  admitSourceFilesystem(handle: bigint) {
    this.event('source-filesystem', handle)
    return { filesystem: 'NTFS' as const, flags: 8, deviceType: 7 as const, deviceCharacteristics: 0 }
  }
  admitFilesystem(handle: bigint): void { this.event('filesystem', handle) }
  verifyName(handle: bigint, name: string): void { this.event('name', handle); if (this.entry(handle).name !== name) throw new PrivateStorageError('name', 'synthetic alias') }
  read(handle: bigint, output: Buffer): number {
    this.event('read', handle)
    const opened = this.handles.get(handle)!
    const count = opened.entry.bytes.copy(output, 0, opened.offset)
    opened.offset += count
    return count
  }
  write(handle: bigint, bytes: Buffer): void {
    this.event('write', handle)
    const opened = this.handles.get(handle)!
    const entry = opened.entry
    const end = opened.offset + bytes.length
    const output = Buffer.alloc(Math.max(entry.bytes.length, end))
    entry.bytes.copy(output)
    bytes.copy(output, opened.offset)
    opened.offset = end
    entry.bytes = output
    entry.facts = { ...entry.facts, sizeBytes: BigInt(output.length) }
  }
  append(handle: bigint, bytes: Buffer): void {
    const opened = this.handles.get(handle)
    if (opened === undefined) throw new Error('invalid synthetic log handle')
    opened.offset = opened.entry.bytes.length
    this.write(handle, bytes)
  }
  flush(handle: bigint): void { this.event('flush', handle) }
  rename(handle: bigint, parent: bigint, name: string, replace: boolean): void {
    this.event('rename', handle)
    const parentId = this.id(parent)
    const existing = [...this.entries.entries()].find(([, item]) => item.parent === parentId && item.name === name)
    if (existing && !replace) throw new PrivateStorageError('collision', 'synthetic rename', { nativeStatus: 0xC0000035 })
    if (existing) this.entries.delete(existing[0])
    const entry = this.entry(handle)
    entry.parent = parentId; entry.name = name
  }
  remove(handle: bigint): void { this.event('remove', handle); this.entries.delete(this.id(handle)) }
  lock(handle: bigint): () => void { this.event('lock', handle); return () => { this.event('unlock', handle) } }
  names(handle: bigint, maximum: number): string[] {
    this.event('names', handle)
    if (!this.handles.get(handle)?.listable) throw new PrivateStorageError('native', 'FILE_LIST_DIRECTORY required')
    const names = [...this.entries.values()].filter(item => item.parent === this.id(handle)).map(item => item.name)
    if (names.length > maximum) throw new PrivateStorageError('limit', 'synthetic audit')
    return names
  }
  asNative(): NativeStorage { return this as object as NativeStorage }
}
