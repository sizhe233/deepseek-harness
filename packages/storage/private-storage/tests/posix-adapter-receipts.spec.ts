/** Synthetic native-return tests; these do not admit a persistent destination or certify a native platform. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { PosixObjectFacts, PosixStorageCreationFacts, PosixStorageDirectory, PosixStorageFacts,
  PosixStorageFile, PosixStorageLease, PosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import * as api from '../src/native-posix.ts'
import { PrivateStreamRootError } from '../src/root-opening.ts'
import { SourceObservationError } from '../src/stream-error.ts'

const selected = vi.hoisted(() => ({ native: undefined as PosixStoragePrimitives | undefined }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({ loadPosixStoragePrimitives: () => selected.native }))
const facts: PosixStorageFacts = { kind: 'directory', dev: '1', ino: '1', uid: '1000', gid: '1000', mode: 0o40700,
  nlink: '2', size: '0', mtimeNs: '1', ctimeNs: '1', platform: 'linux',
  filesystem: { type: '61267', name: 'ext-family', readOnly: false, fsid: 'model', blockSize: '4096' },
  acl: { model: 'linux-posix-mode-mask', entries: 0, defaultEntries: 0, supported: true }, bindingVerified: true,
  created: false, creationSync: { directory: false, parent: false }, bytesRead: '0', bytesWritten: '0', published: false, removed: false }
const fileFacts: PosixStorageFacts = { ...facts, kind: 'regular', ino: '3', mode: 0o100700, nlink: '1', size: '4' }
function fixture() {
  const parent = {} as PosixStorageDirectory, child = {} as PosixStorageDirectory,
    file = {} as PosixStorageFile, lease = {} as PosixStorageLease
  const objects = new Map<object, PosixStorageFacts>([[parent, facts], [child, { ...facts, ino: '2',
    parentBinding: { name: 'managed', before: facts, after: facts } }], [file, fileFacts], [lease, { ...fileFacts, leaseHeld: true }]])
  const unavailable = (): never => { throw new Error('Unrequested model operation') }
  let cursor = 0
  const native = {
    observeProcessBirth: unavailable,
    openDirectory: vi.fn((_path: string, policy: 'source' | 'private') => policy === 'source' ? parent : child),
    openChild: vi.fn(() => child),
    createPrivateChild: vi.fn(() => ({ capability: child, facts: objects.get(child)!, parentBeforeFacts: facts,
      parentAfterFacts: facts, published: true as const, mechanism: 'mkdirat' as const,
      creationSync: { directory: true as const, parent: true as const } })),
    openSource: vi.fn(() => file), openPrivateRecord: vi.fn(() => file), openPrivateOutput: vi.fn(() => file),
    createFile: unavailable, acquireLease: vi.fn(() => lease), replacePrivateRecord: unavailable,
    inspect: vi.fn((capability: object): PosixStorageFacts => objects.get(capability)!),
    inspectBinding: vi.fn((_parent: PosixStorageDirectory, _name: string): PosixObjectFacts | null => fileFacts),
    inspectFileBinding: unavailable,
    inspectSourceLink: vi.fn(() => ({ targetBytes: Buffer.from('../target'),
      before: { ...fileFacts, kind: 'symlink' as const }, after: { ...fileFacts, kind: 'symlink' as const },
      bindingVerified: true as const, released: true as const })),
    listDirectory: vi.fn(() => ({ entries: [{ name: 'output', facts: fileFacts }, { name: 'child', facts },
      { name: 'link', facts: { ...fileFacts, kind: 'symlink' as const } }],
    parentBeforeFacts: objects.get(child)!, parentAfterFacts: objects.get(child)!, complete: true as const })),
    listSourceDirectory: vi.fn(() => ({ entries: [], parentBeforeFacts: facts, parentAfterFacts: facts, complete: true as const })),
    observeCapacity: vi.fn(() => ({ filesystem: facts.filesystem, allocationUnitBytes: '4096', availableBytes: '8192',
      freeEntries: '10', availableEntries: '7', parentBeforeFacts: objects.get(child)!, parentAfterFacts: objects.get(child)!, reservation: false as const })),
    read: vi.fn((_file: PosixStorageFile, count: number) => { const bytes = Buffer.from('data').subarray(cursor, cursor + count); cursor += bytes.length; return bytes }),
    write: unavailable, setExecutable: unavailable, syncFile: unavailable, syncDirectory: unavailable,
    publish: unavailable, removeUnpublished: unavailable, close: vi.fn(() => ({ closed: true })),
  }
  selected.native = native
  return { native, objects, parent, child, file, lease,
    source: () => api.openPosixSourceDirectory('/model'), private: () => api.openPosixPrivateDirectory('/model/managed', { create: false }) }
}
function creation(state: PosixStorageCreationFacts['entryCreationState'], sync: boolean, released: boolean): PosixStorageCreationFacts {
  return { kind: 'directory', entryCreated: state === 'created', entryCreationState: state,
    facts: state === 'created' ? { ...facts, ino: '2' } : null, bindingVerified: state === 'created',
    creationSync: { directory: sync, parent: sync }, release: { attempted: true, completed: released, errno: released ? null : 5 },
    cleanup: { attempted: false, removed: false, directorySynced: false } }
}
function caught(operation: () => unknown): unknown { try { operation() } catch (error) { return error }; throw new Error('Expected failure') }

it.each([false, true])('releases a rejected root capability, preserving close uncertainty: %s', (failClose) => {
  const f = fixture(), problem = new Error('native inspect failed'), release = new Error('native close failed')
  f.native.inspect.mockImplementation(() => { throw problem })
  if (failClose) f.native.close.mockImplementation(() => { throw release })
  const error = caught(f.source)
  if (failClose) expect(error).toMatchObject({ errors: [problem, release] })
  else expect(error).toBe(problem)
  expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.parent)
})

it.each(['/', 'relative', '/model/'])('rejects a root without a literal final component: %s', (path) => {
  const f = fixture()
  expect(() => api.openPosixPrivateStreamRoot(path, { create: true })).toThrow(RangeError)
  expect(f.native.openDirectory).not.toHaveBeenCalled()
})

it.each(['created', 'not-created', 'indeterminate'] as const)('preserves native root-creation evidence after %s failure', (state) => {
  for (const sync of [false, true]) for (const released of [false, true]) {
    const f = fixture(), error = Object.assign(new Error('root creation failed'), { creation: creation(state, sync, released) })
    f.native.openDirectory.mockImplementation((_path, policy) => { if (policy === 'private') throw error; return f.parent })
    const failure = caught(() => api.openPosixPrivateStreamRoot('/model/managed', { create: true }))
    expect(failure).toBeInstanceOf(PrivateStreamRootError)
    expect(failure).toMatchObject({ cause: error, receipt: { kind: state === 'created' ? 'created' : 'indeterminate',
      identity: state === 'created' ? { backend: 'posix', device: '1', inode: '2' } : null,
      durability: sync ? 'synced' : 'unconfirmed', release: released ? 'released' : 'failed' } })
    expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.parent)
  }
})

it('reports both root opening and parent cleanup failures without retrying release', () => {
  const f = fixture(), problem = new Error('creation failed'), release = new Error('release failed')
  f.native.openDirectory.mockImplementation((_path, policy) => { if (policy === 'private') throw problem; return f.parent })
  f.native.close.mockImplementation(() => { throw release })
  expect(caught(() => api.openPosixPrivateStreamRoot('/model/managed', { create: false }))).toMatchObject({
    receipt: { release: 'failed' }, cause: { errors: [problem, release] } })
  expect(f.native.close).toHaveBeenCalledTimes(1)
})

it('qualifies Darwin root creation from its own synchronization observations', () => {
  const f = fixture()
  f.objects.set(f.child, { ...f.objects.get(f.child)!, platform: 'darwin', created: true, creationSync: { directory: true, parent: true } })
  const result = api.openPosixPrivateStreamRoot('/model/managed', { create: true })
  expect(result.receipt.publications[0]).toMatchObject({ mechanism: 'darwin-directory-fsync-v1', durability: 'synced' })
  result.directory.close()
})

it('reports Darwin child synchronization and makes wrapper release idempotent', () => {
  const f = fixture()
  f.objects.set(f.child, { ...facts, platform: 'darwin' })
  const directory = f.private(), result = api.createPosixPrivateStreamChild(directory, 'child')
  expect(result.receipt).toMatchObject({ mechanism: 'darwin-directory-fsync-v1', durability: 'synced' })
  result.directory.close(); result.directory.close(); directory.close(); directory.close()
  expect(f.native.close).toHaveBeenCalledTimes(2)
})

it('refuses a child with incomplete native publication or binding flags', () => {
  for (const change of ['publication', 'binding'] as const) {
    const f = fixture(), directory = f.private()
    const result = f.native.createPrivateChild()
    // Native returns cross an untyped addon interface; a false success flag must never be coerced.
    f.native.createPrivateChild.mockReturnValue({ ...result, parentBeforeFacts: f.objects.get(f.child)!,
      ...(change === 'publication' ? { published: false as true } : { facts: { ...result.facts, bindingVerified: false } }) })
    expect(caught(() => api.createPosixPrivateStreamChild(directory, 'child'))).toMatchObject({ receipt: {
      publication: change === 'publication' ? 'indeterminate' : 'published',
      bindingVerification: change === 'binding' ? 'unverified' : 'verified', release: 'released' } })
    expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.child); directory.close()
  }
})

it('does not invent creation evidence for an ordinary child failure', () => {
  const f = fixture(), directory = f.private(), failure = new Error('native child creation refused')
  f.native.createPrivateChild.mockImplementation(() => { throw failure })
  expect(caught(() => api.createPosixPrivateStreamChild(directory, 'child'))).toMatchObject({ cause: failure,
    receipt: { publication: 'not-published', identity: null, release: 'released' } })
  expect(f.native.close).not.toHaveBeenCalled(); directory.close()
})

it.each([false, true])('rejects an unheld management lease and reports admission/release errors: %s', (failClose) => {
  const f = fixture(), directory = f.private()
  f.objects.set(f.lease, { ...fileFacts, leaseHeld: false })
  if (failClose) f.native.close.mockImplementation(() => { throw new Error('lease close failed') })
  const error = caught(() => api.acquirePosixManagementLease(directory, 'management.lock'))
  expect(error).toBeInstanceOf(failClose ? AggregateError : Error)
  expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.lease)
})

it('checks native lease ownership again without consuming the caller lease', () => {
  const f = fixture(), directory = f.private(), lease = api.acquirePosixManagementLease(directory, 'management.lock')
  api.assertPosixManagementLease(directory, lease)
  f.objects.set(f.lease, { ...fileFacts, leaseHeld: false })
  expect(() =>{  api.assertPosixManagementLease(directory, lease) }).toThrow('no longer held')
  expect(f.native.close).not.toHaveBeenCalled(); lease.close(); directory.close()
})

it.each([false, true])('opens independent private children and cleans rejected child observations: %s', (invalid) => {
  const f = fixture(), directory = f.private()
  if (invalid) f.objects.set(f.child, { ...facts, kind: 'regular' })
  if (invalid) {
    expect(() => api.openPosixPrivateStreamChild(directory, 'child')).toThrow('unverified')
    expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.child)
    f.native.close.mockImplementation(() => { throw new Error('child close failed') })
    expect(() => api.openPosixPrivateStreamChild(directory, 'child')).toThrow(AggregateError)
  } else {
    const child = api.openPosixPrivateStreamChild(directory, 'child')
    directory.close(); child.close()
    expect(f.native.close).toHaveBeenCalledTimes(2)
  }
})

it.each(['created', 'not-created', 'indeterminate'] as const)('records native %s child publication diagnostics', (state) => {
  for (const sync of [false, true]) for (const released of [false, true]) {
    const f = fixture(), directory = f.private(), error = Object.assign(new Error('child creation failed'), { creation: creation(state, sync, released) })
    f.native.createPrivateChild.mockImplementation(() => { throw error })
    expect(caught(() => api.createPosixPrivateStreamChild(directory, 'child'))).toMatchObject({ cause: error, receipt: {
      publication: state === 'created' ? 'published' : state === 'indeterminate' ? 'indeterminate' : 'not-published',
      bindingVerification: state === 'created' ? 'verified' : 'unverified', durability: sync ? 'synced' : 'unconfirmed',
      synchronization: { child: sync ? 'succeeded' : 'not-attempted', parent: sync ? 'succeeded' : 'not-attempted' },
      release: released ? 'released' : 'failed' } })
    expect(f.native.close).not.toHaveBeenCalled(); directory.close()
  }
})

it('preserves all listed entry kinds without treating unopened entries as private', () => {
  const f = fixture(), directory = f.private()
  expect(api.listPosixPrivateStreamDirectory(directory, { maxEntries: 3 }).entries.map(entry => entry.kind)).toEqual(['file', 'directory', 'other'])
  directory.close()
})

it('rejects unbound directory facts and changed capacity filesystem evidence', () => {
  const f = fixture(), directory = f.private()
  f.objects.set(f.child, { ...f.objects.get(f.child)!, bindingVerified: false })
  expect(() => api.listPosixPrivateStreamDirectory(directory, { maxEntries: 3 })).toThrow('unbound')
  f.objects.set(f.child, { ...f.objects.get(f.child)!, bindingVerified: true })
  f.native.observeCapacity.mockImplementation(() => ({ filesystem: { ...facts.filesystem, fsid: 'foreign' },
    allocationUnitBytes: '4096', availableBytes: '8192', freeEntries: '10', availableEntries: '7',
    parentBeforeFacts: f.objects.get(f.child)!, parentAfterFacts: f.objects.get(f.child)!, reservation: false }))
  expect(() => api.observePosixPrivateStreamCapacity(directory)).toThrow('retained filesystem')
  directory.close()
})

it('audits retained private files and directories and reads a manifest-bound file after parent close', () => {
  const f = fixture(), directory = f.private()
  const inspected = api.inspectPosixPrivateStreamEntry(directory, 'output')
  expect(inspected).toMatchObject({ kind: 'file', facts: { privateVerified: true, executable: true, sizeBytes: 4 } })
  f.native.inspectBinding.mockReturnValue(f.objects.get(f.child)!)
  expect(api.inspectPosixPrivateStreamEntry(directory, 'child')).toMatchObject({ kind: 'directory', facts: { privateVerified: true } })
  const reader = api.openPosixPrivateFileReader(directory, 'output', { expectedIdentity: { backend: 'posix', device: '1', inode: '3' },
    expectedBytes: 4, expectedSha256: createHash('sha256').update('data').digest('hex') })
  directory.close(); expect(Buffer.from(reader.readChunk(4)).toString()).toBe('data')
  expect(reader.finish()).toMatchObject({ verification: 'verified', release: 'released' })
})

it('refuses missing or replaced private entries and preserves inspection plus release failures', () => {
  const f = fixture(), directory = f.private()
  f.native.inspectBinding.mockReturnValue(null)
  expect(caught(() => api.inspectPosixPrivateStreamEntry(directory, 'missing'))).toMatchObject({ code: 'ENOENT' })
  expect(f.native.openPrivateOutput).not.toHaveBeenCalled()
  f.native.inspectBinding.mockReturnValue({ ...fileFacts, ino: 'other' })
  const failed = caught(() => api.inspectPosixPrivateStreamEntry(directory, 'output'))
  expect(failed).toBeInstanceOf(AggregateError); expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.file)
  f.native.close.mockImplementation(() => { throw new Error('release failed') })
  expect(caught(() => api.inspectPosixPrivateStreamEntry(directory, 'output'))).toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
})

it.each([{ size: '-1' }, { nlink: '9007199254740992' }, { kind: 'fifo' as const }, { bindingVerified: false }])('rejects invalid native file observations: %j', (change) => {
  const f = fixture(), source = f.source(); f.objects.set(f.file, { ...fileFacts, ...change })
  expect(() => api.inspectPosixSourceFile(source, 'source')).toThrow()
  expect(f.native.close).toHaveBeenCalledExactlyOnceWith(f.file); source.close()
})

it('lists a source without unadmitted entries without granting destination authority', () => {
  const f = fixture(), source = f.source()
  expect(api.listPosixSourceDirectory(source, 0)).toMatchObject({ admission: 'complete', entries: [], complete: true })
  expect(() => api.listPosixPrivateStreamDirectory(source, { maxEntries: 0 })).toThrow('wrong-policy')
  source.close()
})

it('observes absolute link targets literally and rejects invalid native link records before returning facts', () => {
  const f = fixture(), source = f.source(), valid = f.native.inspectSourceLink()
  f.native.inspectSourceLink.mockReturnValue({ ...valid, targetBytes: Buffer.from('/literal/target') })
  expect(api.inspectPosixSourceLink(source, 'link', 32768)).toMatchObject({ relative: false, literalTarget: '/literal/target' })
  for (const maximum of [0, 32769, 1.5]) expect(() => api.inspectPosixSourceLink(source, 'link', maximum)).toThrow(RangeError)
  for (const record of [
    { ...valid, after: { ...valid.after, ino: 'changed' } },
    { ...valid, targetBytes: Buffer.from('') }, { ...valid, targetBytes: Buffer.from('x\0y') },
    { ...valid, before: { ...valid.before, nlink: '0' }, after: { ...valid.after, nlink: '0' } },
  ]) { f.native.inspectSourceLink.mockReturnValue(record); expect(() => api.inspectPosixSourceLink(source, 'link', 32768)).toThrow() }
  f.native.inspectSourceLink.mockImplementation(() => { throw Object.assign(new Error('changed link'), { code: 'ESTALE' }) })
  expect(() => api.inspectPosixSourceLink(source, 'link', 32768)).toThrow(SourceObservationError)
  f.native.inspectSourceLink.mockImplementation(() => { throw 'native link failure' })
  expect(caught(() => api.inspectPosixSourceLink(source, 'link', 32768))).toBe('native link failure')
  source.close()
})
