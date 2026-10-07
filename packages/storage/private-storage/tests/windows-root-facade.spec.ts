/** Actual root facade with synthetic native resources; native and packed interoperability gates stay separate. */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNative } from './fake-native.ts'
import type { NativeStorageBackend as NativeStorage } from '../src/native.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import * as storage from '../src/index.ts'
const selected = vi.hoisted((): { api: NativeStorage | undefined } => ({ api: undefined }))
vi.mock('../src/native.ts', async original => ({ ...await original<object>(), loadNativeStorage: () => selected.api }))
class FacadeNative extends FakeNative {
  readonly ownershipArtifact = { platform: 'win32' as const, architecture: 'x64' as const, nodeApi: 8 as const,
    entry: { name: 'synthetic-entry', version: '0.1.3', file: 'entry.js', sha256: 'a'.repeat(64) },
    platformPackage: { name: 'synthetic-platform', version: '0.1.3', binary: 'owner.node', sha256: 'b'.repeat(64), bytes: 10 } }
  override inspectSource(handle: bigint) {
    const { ownerSid: _owner, daclProtected: _protected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
  inspectRetiredPrivate(handle: bigint) {
    const facts = this.inspectSource(handle), retired = !this.entries.has(this.id(handle))
    return { ...facts, links: retired ? 0 : facts.links, deletePending: retired }
  }
  capacity(_handle: bigint) { return { allocationUnitBytes: 4096n, availableBytes: 65536n } }
}
const actualPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let native: FacadeNative
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); native = new FacadeNative(); selected.api = native.asNative() })
afterEach(() => { Object.defineProperty(process, 'platform', actualPlatform) })
const manifest = (bytes: Buffer) => ({ operationId: 'facade-operation' as PrivateStreamOperationId, expectedBytes: bytes.length,
  expectedSha256: createHash('sha256').update(bytes).digest('hex'), replace: false as const, executable: false })
describe('canonical Windows stream/control root facade', () => {
  it('refuses a retained root parent whose native kind changes after the directory admission check', () => {
    const source = native.inspectSource.bind(native)
    native.inspectSource = (handle) => {
      const afterPrivateAdmission = native.events.at(-1) === 'filesystem'
      const facts = source(handle)
      return afterPrivateAdmission && native.entry(handle).name === 'private' ? { ...facts, kind: 'file' as const } : facts
    }
    expect(() => storage.openPrivateStreamRoot('C:\\private\\managed', { create: true })).toThrow(expect.objectContaining({
      name: 'PrivateStreamRootError', code: 'identity' }))
    expect(native.handles.size).toBe(0)
  })
  it.each(['type-query', 'directory-facts', 'file-facts'] as const)('consumes temporary inspection ownership after %s failure', (phase) => {
    const name = phase === 'directory-facts' ? 'child' : 'asset'
    native.add(2n, name, phase === 'directory-facts' ? 'directory' : 'file', Buffer.from('data'))
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false })
    let inspections = 0
    native.hook = (operation, handle) => {
      if (operation !== 'inspect' || handle === undefined || native.entry(handle).name !== name) return
      inspections++
      if (inspections === (phase === 'type-query' ? 1 : phase === 'directory-facts' ? 5 : 4)) throw new Error(`${phase} failed`)
    }
    expect(() => storage.inspectPrivateStreamEntry(root, name)).toThrow(`${phase} failed`)
    native.hook = () => {}; root.close(); expect(native.handles.size).toBe(0)
  })
  it('routes source children, complete inventories and no-follow link observations through the Windows owner', () => {
    native.add(2n, 'child', 'directory')
    const root = storage.openSourceDirectory('C:\\private'), child = storage.openSourceChild(root, 'child')
    expect(storage.listSourceDirectory(child, 0)).toMatchObject({ complete: true, entries: [], admission: 'complete' })
    const facts = { identity: child.identity, links: 1, observations: {}, changeToken: 'a'.repeat(64) }
    const observation = { kind: 'symbolic-link' as const, literalTarget: '../bin.js', relative: true, before: facts, after: facts }
    native.asNative().observeLink = () => observation
    expect(storage.inspectSourceLink(root, 'bin', { maxBytes: 32768 })).toBe(observation)
    expect(storage.streamCapabilities()).toMatchObject({ available: true, backend: 'windows-ntfs', acceptance: 'unverified' })
    root.close(); child.close(); expect(native.handles.size).toBe(0)
  })
  it('rejects management lease identity changes before granting control-record authority', () => {
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false }), lease = storage.acquireManagementLease(root, 'writer.lock')
    const inspect = native.inspect.bind(native)
    native.inspect = (handle) => { const facts = inspect(handle); return native.entry(handle).name === 'writer.lock'
      ? { ...facts, identity: { ...facts.identity, fileId: 'f'.repeat(32) } } : facts }
    expect(() =>{  storage.assertManagementLease(root, lease) }).toThrow(expect.objectContaining({ code: 'identity' }))
    native.inspect = inspect; lease.close(); root.close(); expect(native.handles.size).toBe(0)
  })
  it('streams newly observed bytes after the root closes without manufacturing an expected artifact digest', () => {
    const bytes = Buffer.alloc(1024 * 1024 + 19, 0x5a)
    native.add(2n, 'observed.bin', 'file', bytes)
    const root = storage.openSourceDirectory('C:\\private'), expectedSource = storage.inspectSourceFile(root, 'observed.bin')
    const reader = storage.openObservedSourceFileReader(root, 'observed.bin', { expectedSource, maxBytes: 1024 ** 3 })
    root.close()
    expect(reader.readChunk(1024 * 1024).length).toBe(1024 * 1024)
    expect(reader.readChunk(1024 * 1024).length).toBe(19)
    expect(reader.finish()).toMatchObject({ kind: 'observed-source', verification: 'observed', release: 'released',
      eof: true, actualSha256: createHash('sha256').update(bytes).digest('hex'), observedBytes: bytes.length })
    expect(native.handles.size).toBe(0)
  })
  it('reports actual final-root publication and keeps preexisting root durability unclaimed', () => {
    const existing = storage.openPrivateStreamRoot('C:\\private', { create: false })
    expect(existing.receipt).toMatchObject({ kind: 'existing-root', durability: 'not-attempted',
      publications: [], bindingVerification: 'verified', privacyVerification: 'verified', release: 'retained' })
    existing.directory.close()
    const made = storage.openPrivateStreamRoot('C:\\private\\managed', { create: true })
    expect(made.receipt).toMatchObject({ kind: 'created', durability: 'synced', bindingVerification: 'verified',
      parentIdentity: { backend: 'windows-ntfs', fileId: '00000000000000000000000000000002' },
      publications: [{ publication: 'published', durability: 'synced', bindingVerification: 'verified' }] })
    made.directory.close(); expect(native.handles.size).toBe(0)
    expect(() => storage.openPrivateStreamRoot('C:\\missing\\managed', { create: true })).toThrow()
    expect([...native.entries.values()].some(value => value.name === 'missing')).toBe(false)
    expect(() => storage.openPrivateStreamRoot('C:\\', { create: true })).toThrow()
    expect(native.handles.size).toBe(0)
  })
  it('retains established publication facts when releasing the separate parent guard fails', () => {
    let opening = true, failed = false
    native.hook = (operation, handle) => {
      if (operation === 'rename') opening = false
      if (!opening && !failed && operation === 'close' && handle !== undefined && native.id(handle) === 2n) {
        failed = true; native.handles.delete(handle); throw new Error('lost parent-close return')
      }
    }
    let caught: unknown
    try { storage.openPrivateStreamRoot('C:\\private\\managed', { create: true }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(storage.PrivateStreamRootError)
    if (!(caught instanceof storage.PrivateStreamRootError)) throw new Error('Expected root receipt failure')
    expect(caught.receipt).toMatchObject({ kind: 'created', durability: 'synced', release: 'failed' })
    expect(caught.cleanupFailed).toBe(true); expect(native.handles.size).toBe(0)
  })
  it('keeps source-document digest observation distinct from manifest-bound artifact reading', () => {
    const bytes = Buffer.from('source document')
    native.add(2n, 'document.txt', 'file', bytes)
    const root = storage.openSourceDirectory('C:\\private')
    const facts = storage.inspectSourceFile(root, 'document.txt')
    const observed = storage.readSourceDocument(root, 'document.txt', { expectedSource: facts, maxBytes: 64 })
    expect(Buffer.from(observed.bytes)).toEqual(bytes)
    expect(observed).toMatchObject({ sha256: manifest(bytes).expectedSha256, source: facts })
    const reader = storage.openSourceFileReader(root, 'document.txt', { expectedIdentity: facts.identity,
      expectedBytes: bytes.length, expectedSha256: manifest(bytes).expectedSha256 })
    root.close()
    expect(Buffer.from(reader.readChunk(64))).toEqual(bytes)
    expect(reader.finish()).toMatchObject({ verification: 'verified', release: 'released' })
    expect(native.handles.size).toBe(0)
  })
  it('supports complete directory and bounded private file auditing through opaque tagged capabilities', () => {
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false })
    expect(root.identity.backend).toBe('windows-ntfs')
    const made = storage.createPrivateStreamChild(root, 'generation')
    expect(made.receipt).toMatchObject({ publication: 'published', durability: 'synced', bindingVerification: 'verified',
      mechanism: 'windows-ntfs-write-through-directory-rename-v1', synchronization: { child: 'not-required', parent: 'not-required' } })
    const bytes = Buffer.from('generated')
    const writer = storage.createPrivateFileWriter(made.directory, 'asset', manifest(bytes)); writer.append(bytes); writer.finish()
    const listed = storage.listPrivateStreamDirectory(made.directory, 1)
    expect(listed.entries).toHaveLength(1)
    const file = storage.inspectPrivateStreamEntry(made.directory, 'asset')
    if (file.kind !== 'file') throw new Error('model expected regular file')
    expect(file.facts).toMatchObject({ privateVerified: true, executable: null, links: 1 })
    const reader = storage.openPrivateFileReader(made.directory, 'asset', { expectedIdentity: file.facts.identity,
      expectedBytes: file.facts.sizeBytes, expectedSha256: manifest(bytes).expectedSha256 })
    expect(Buffer.from(reader.readChunk(1024))).toEqual(bytes); expect(reader.finish().verification).toBe('verified')
    expect(storage.observePrivateStreamCapacity(root)).toMatchObject({ availableBytes: '65536', allocationUnitBytes: '4096',
      availableEntries: null, scope: 'observed-filesystem-capacity' })
    expect(storage.inspectPrivateStreamEntry(root, 'generation')).toMatchObject({ kind: 'directory', facts: { links: 1, privateVerified: true } })
    const reopened = storage.openPrivateStreamChild(root, 'generation'); reopened.close()
    made.directory.close(); root.close(); expect(native.handles.size).toBe(0)
  })
  it('keeps management leases caller-owned while replacing only the fixed generated namespace', () => {
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false })
    const initial = Buffer.from('first'), writer = storage.createPrivateFileWriter(root, 'current.json', manifest(initial))
    writer.append(initial); writer.finish()
    const lease = storage.acquireManagementLease(root, 'writer.lock')
    storage.assertManagementLease(root, lease)
    const owner = storage.createControlRecordOwner(root, lease, ['current.json'])
    expect(() => owner.read('other.json', { maxBytes: 64 })).toThrow()
    const current = owner.read('current.json', { maxBytes: 64 }), next = Buffer.from('second')
    const transaction = owner.replace('current.json', { operationId: 'replace-operation' as PrivateStreamOperationId,
      expectedCurrent: { source: current.source, sha256: current.sha256 }, expectedBytes: next.length,
      expectedSha256: manifest(next).expectedSha256, validateCurrent(value) { expect(value.sha256).toBe(current.sha256); return 'verified' } })
    transaction.append(next); expect(transaction.finish().replacementVerification).toBe('verified')
    storage.assertManagementLease(root, lease)
    expect(Buffer.from(storage.readPrivateRecord(root, 'current.json', { maxBytes: 64 }).bytes)).toEqual(next)
    lease.close(); expect(() => owner.read('current.json', { maxBytes: 64 })).toThrow()
    root.close(); expect(native.handles.size).toBe(0)
  })
  it('rejects cloned directory/lease wrappers and excluded lock/staging record names', () => {
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false }), lease = storage.acquireManagementLease(root, '.dsh-writer.lock')
    expect(() => storage.listPrivateStreamDirectory({ ...root }, 1)).toThrow()
    expect(() =>{  storage.assertManagementLease(root, { ...lease }) }).toThrow()
    for (const names of [['.dsh-writer.lock'], ['.dsh-private-owned'], ['Record', 'record'], []]) {
      expect(() => storage.createControlRecordOwner(root, lease, names)).toThrow()
    }
    lease.close(); root.close(); expect(native.handles.size).toBe(0)
  })
  it('keeps an opened log alive after the caller closes its directory wrapper', () => {
    const root = storage.openPrivateStreamDirectory('C:\\private', { create: false })
    const sink = storage.openPrivateLogSink(root, 'output.log', { maxChunkBytes: 65536 })
    root.close(); sink.append(Buffer.from('output'))
    expect(sink.close()).toMatchObject({ outcome: 'closed', durability: 'synced', synchronization: 'succeeded', release: 'released' })
    expect(native.handles.size).toBe(0)
  })
})
