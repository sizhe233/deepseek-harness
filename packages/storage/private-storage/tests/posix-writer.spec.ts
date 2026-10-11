/** Injected POSIX adapter settlement; no persistent destination is admitted by these models. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PosixStorageCreationFacts, PosixStorageDirectory, PosixStorageFacts, PosixStorageFile, PosixStorageLease,
  PosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import { acquirePosixManagementLease, createPosixControlRecordOwner, createPosixPrivateFileWriter, openPosixPrivateDirectory } from '../src/native-posix.ts'
import { PrivateFileWriterError } from '../src/stream-writer.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import type { StreamWriterResource } from '../src/stream-native.ts'
import type { ControlRecordResource } from '../src/control-record.ts'

const provider = vi.hoisted(() => ({ native: undefined as PosixStoragePrimitives | undefined }))
const captured = vi.hoisted(() => ({ writer: undefined as StreamWriterResource | undefined,
  control: undefined as ControlRecordResource | undefined }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({ loadPosixStoragePrimitives: () => provider.native }))
vi.mock('../src/stream-writer.ts', async (original) => {
  const module = await original<typeof import('../src/stream-writer.ts')>()
  return { ...module, createBoundedFileWriter: (...args: Parameters<typeof module.createBoundedFileWriter>) =>
    module.createBoundedFileWriter(args[0], args[1], args[2], () => { captured.writer = args[3](); return captured.writer }) }
})
vi.mock('../src/control-record.ts', async (original) => {
  const module = await original<typeof import('../src/control-record.ts')>()
  return { ...module, createBoundedControlRecordWriter: (...args: Parameters<typeof module.createBoundedControlRecordWriter>) =>
    module.createBoundedControlRecordWriter(args[0], args[1], args[2], () => { captured.control = args[3](); return captured.control }) }
})
const data = Buffer.from('generated output')
const options = { operationId: brandString<PrivateStreamOperationId>('posix-model'), expectedBytes: data.length,
  expectedSha256: createHash('sha256').update(data).digest('hex'), replace: false as const, executable: false }
const facts: PosixStorageFacts = {
  kind: 'regular', dev: '1', ino: '2', uid: '1000', gid: '1000', mode: 0o100600, nlink: '1', size: '0',
  mtimeNs: '10', ctimeNs: '10', platform: 'linux', filesystem: { type: '61267', name: 'ext-family', readOnly: false, fsid: '1', blockSize: '4096' },
  acl: { model: 'linux-posix-mode-mask', entries: 0, defaultEntries: 0, supported: true }, bindingVerified: true,
  created: true, creationSync: { directory: false, parent: false }, bytesRead: '0', bytesWritten: '0', published: false, removed: false,
}
function fixture(creation?: PosixStorageCreationFacts) {
  const parent = Object.freeze({}) as PosixStorageDirectory, file = Object.freeze({}) as PosixStorageFile
  const calls: string[] = []
  const state = { bytes: 0, published: false, closed: 0, collision: false }
  const error = Object.assign(new Error('native creation failed'), { errno: 5, syscall: 'fstat', creation })
  const unavailable = (): never => { throw new Error('unused model method') }
  const native: PosixStoragePrimitives = {
    inspectSourceLink: unavailable, listSourceDirectory: unavailable,
    observeProcessBirth: () => { throw new Error('Darwin-only observation is outside this writer fixture') },
    openDirectory: () => parent, openChild: unavailable, createPrivateChild: unavailable, openPrivateOutput: unavailable,
    listDirectory: unavailable, observeCapacity: unavailable, openSource: unavailable,
    openPrivateRecord: unavailable, acquireLease: unavailable,
    replacePrivateRecord: unavailable, read: unavailable,
    createFile: () => { calls.push('create'); if (creation !== undefined) throw error; return file },
    inspect: capability => capability === parent ? { ...facts, kind: 'directory', ino: '1', mode: 0o40700 }
      : { ...facts, size: String(state.bytes), bytesWritten: String(state.bytes), published: state.published },
    inspectBinding: () => state.collision ? facts : null,
    inspectFileBinding: (_file, name) => name === 'output' && state.published ? facts : null,
    write: (_file, bytes) => { state.bytes += bytes.length; return { bytesWritten: bytes.length, totalBytesWritten: String(state.bytes) } },
    setExecutable: () => ({}), syncFile: () => ({}), syncDirectory: () => ({}),
    publish: () => { state.published = true; return { published: true, mechanism: 'model', facts } },
    removeUnpublished: () => { calls.push('remove'); return { removed: true } },
    close: () => { calls.push('close'); state.closed++; return { closed: true } },
  }
  provider.native = native
  const directory = openPosixPrivateDirectory('/synthetic-private', { create: false })
  return { native, parent, file, directory, state, calls, error, make: () => createPosixPrivateFileWriter(directory, 'output', options) }
}
function failedCreation(state: 'created' | 'not-created' | 'indeterminate', release = true): PosixStorageCreationFacts {
  return { kind: 'staging', entryCreated: state === 'created', entryCreationState: state,
    facts: state === 'created' ? facts : null, bindingVerified: state === 'created',
    release: { attempted: state === 'created', completed: release, errno: release ? null : 5 },
    creationSync: { directory: false, parent: false }, cleanup: { attempted: false, removed: false, directorySynced: false } }
}
it.each(['created', 'not-created', 'indeterminate'] as const)('preserves %s setup state without reopening or pathname cleanup', (state) => {
  const f = fixture(failedCreation(state)); let error: unknown
  try { f.make() } catch (failure) { error = failure }
  expect(error).toMatchObject({ errno: 5, syscall: 'fstat', receipt: { publication: 'not-published',
    parentIdentity: { backend: 'posix', device: '1', inode: '1' },
    identity: state === 'created' ? { backend: 'posix', device: '1', inode: '2' } : null,
    cleanup: state === 'not-created' ? 'not-needed' : 'withheld', release: 'released' } })
  expect(f.calls).toEqual(['create']); f.directory.close()
})
it('preserves unconfirmed native close without retrying the unreturned descriptor', () => {
  const f = fixture(failedCreation('created', false)); let error: unknown
  try { f.make() } catch (failure) { error = failure }
  expect(error).toMatchObject({ cleanupFailed: true, receipt: { cleanup: 'withheld', release: 'failed' } })
  expect(f.calls).toEqual(['create']); f.directory.close()
})
it('rejects a final collision before creating staging and records known parent/name', () => {
  const f = fixture(); f.state.collision = true
  let error: unknown
  try { f.make() } catch (failure) { error = failure }
  expect(error).toBeInstanceOf(PrivateFileWriterError)
  expect((error as PrivateFileWriterError).receipt.stagingName).toMatch(/^\.dsh-private-[0-9a-f]{40}$/u)
  expect(error).toMatchObject({ receipt: {
    cleanup: 'not-needed', identity: null, parentIdentity: { backend: 'posix', device: '1', inode: '1' } } })
  expect(f.calls).toEqual([]); f.directory.close()
})
it('uses retained staging capabilities through normal completion after caller directory close', () => {
  const f = fixture(), writer = f.make(); f.directory.close()
  writer.append(data)
  expect(writer.finish()).toMatchObject({ publication: 'published', durability: 'synced', release: 'released' })
  expect(f.calls).toEqual(['create', 'close', 'close'])
})

it.each(['published', 'not-published', 'indeterminate'] as const)('reconciles a failed publication acknowledgement from retained bindings: %s', (publication) => {
  const f = fixture(), writer = f.make()
  f.native.publish = () => { throw new Error('rename acknowledgement lost') }
  f.native.inspectFileBinding = (_file, name) => name === 'output'
    ? publication === 'not-published' ? null : facts
    : publication === 'published' ? null : facts
  writer.append(data)
  expect(() => writer.finish()).toThrow()
  expect(writer.receipt).toMatchObject({ publication, cleanup: publication === 'not-published' ? 'removed' : 'withheld', release: 'released' })
  expect(f.calls.filter(call => call === 'remove')).toHaveLength(publication === 'not-published' ? 1 : 0)
  f.directory.close()
})

it('refuses a changed final binding after successful publication without deleting that name', () => {
  const f = fixture(), writer = f.make()
  f.native.inspectFileBinding = () => ({ ...facts, ino: 'foreign' })
  writer.append(data)
  expect(() => writer.finish()).toThrow()
  expect(writer.receipt).toMatchObject({ publication: 'published', bindingVerification: 'failed', cleanup: 'withheld' })
  expect(f.calls).not.toContain('remove'); f.directory.close()
})

it('keeps refused cleanup separate from a known unpublished staging file', () => {
  const f = fixture(), writer = f.make()
  f.native.removeUnpublished = () => ({ removed: false })
  expect(writer.abort()).toMatchObject({ publication: 'not-published', cleanup: 'withheld', cleanupDurability: 'unconfirmed', release: 'released' })
  f.directory.close()
})

it('preserves a non-Error native creation failure without manufacturing a resource', () => {
  const f = fixture()
  f.native.createFile = () => { throw 'native creation failure' }
  expect(() => f.make()).toThrow(PrivateFileWriterError)
  expect(f.calls).toEqual([]); f.directory.close()
})

it.each([new Error('native creation failed'), 'native creation failed'])('refuses writes through an unsuccessfully initialized native resource', (failure) => {
  const f = fixture()
  f.native.createFile = () => { throw failure }
  expect(() => f.make()).toThrow(PrivateFileWriterError)
  const resource = captured.writer!
  expect(() =>{ resource.write(data) }).toThrow(failure instanceof Error ? failure : expect.objectContaining({ cause: failure }))
  expect(f.state.bytes).toBe(0)
  f.directory.close()
})

it('selects Darwin full synchronization from the retained parent platform', () => {
  const f = fixture(), inspect = f.native.inspect.bind(f.native), syncFile = vi.fn(() => ({}))
  f.native.inspect = capability => ({ ...inspect(capability), platform: 'darwin' })
  f.native.syncFile = syncFile
  const writer = f.make(); writer.append(data)
  expect(writer.finish()).toMatchObject({ mechanism: 'darwin-file-directory-fullsync-v1', durability: 'synced' })
  expect(syncFile).toHaveBeenCalledWith(f.file, true); f.directory.close()
})


function controlFixture() {
  const f = fixture(), lease = Object.freeze({}) as PosixStorageLease, target = Object.freeze({}) as PosixStorageFile
  const prior = Buffer.from('revision:1'), sha256 = createHash('sha256').update(prior).digest('hex')
  const oldFacts = { ...facts, ino: '3', size: String(prior.length) }
  const parentFacts = { ...facts, kind: 'directory' as const, ino: '1', mode: 0o40700 }
  const leaseFacts = { ...facts, ino: '4', leaseHeld: true }
  const nativeInspect = f.native.inspect.bind(f.native)
  const nativeClose = f.native.close.bind(f.native)
  const runtime = { cursor: 0, leaseClosed: false, replacements: 0, targetClosed: false, targetBytes: Buffer.from(prior) }
  f.native.acquireLease = () => lease
  f.native.inspect = capability => capability === lease ? { ...leaseFacts, leaseHeld: !runtime.leaseClosed }
    : capability === target ? oldFacts : nativeInspect(capability)
  f.native.close = (capability) => {
    if (capability === lease) runtime.leaseClosed = true
    if (capability === target) runtime.targetClosed = true
    return nativeClose(capability)
  }
  f.native.inspectFileBinding = (_file, name) => name === 'selector.json' ? (f.state.published ? facts : oldFacts) : (f.state.published ? null : facts)
  f.native.openPrivateRecord = () => target
  f.native.read = (_file, count) => {
    const bytes = prior.subarray(runtime.cursor, runtime.cursor + count); runtime.cursor += bytes.length
    return Buffer.from(bytes)
  }
  f.native.replacePrivateRecord = (staging, source, liveLease) => {
    expect(staging).toBe(f.file); expect(source).toBe(target); expect(liveLease).toBe(lease)
    if (runtime.leaseClosed) throw new Error('native lease was released')
    runtime.replacements++; runtime.targetBytes = Buffer.from(data); f.state.published = true
    return { published: true, leaseVerified: true, mechanism: 'renameat2(flags=0)', facts,
      replacedFacts: oldFacts, replacedAfterFacts: { ...oldFacts, nlink: '0', ctimeNs: '11' },
      stagingParentFacts: parentFacts, targetParentFacts: parentFacts, parentAfterFacts: { ...parentFacts, mtimeNs: '11', ctimeNs: '11' } }
  }
  const lock = acquirePosixManagementLease(f.directory, 'management.lock')
  const owner = createPosixControlRecordOwner(f.directory, lock, ['selector.json'])
  const observed = owner.read('selector.json', { maxBytes: 64 * 1024 * 1024 })
  runtime.cursor = 0; runtime.targetClosed = false
  const make = (validateCurrent = () => 'verified' as const) => owner.replace('selector.json', {
    operationId: options.operationId, expectedCurrent: { source: observed.source, sha256 },
    expectedBytes: data.length, expectedSha256: options.expectedSha256, validateCurrent,
  })
  return { ...f, lock, owner, runtime, prior, make }
}
it('binds generated replacement to the retained source and caller-owned management lease', () => {
  const f = controlFixture(), writer = f.make()
  writer.append(data)
  expect(f.runtime.targetBytes).toEqual(f.prior)
  const receipt = writer.finish()
  expect(receipt).toMatchObject({ outcome: 'finished', currentVerification: 'verified', revisionVerification: 'verified',
    replacementVerification: 'verified', managementLease: 'caller-owned', release: 'released',
    staging: { publication: 'published', durability: 'synced' }, replacement: {
      replacedBefore: { identity: { backend: 'posix', device: '1', inode: '3' } },
      replacedAfter: { observations: { nlink: '0', ctimeNs: '11' } },
    } })
  expect(f.runtime.targetBytes).toEqual(data); expect(f.runtime.replacements).toBe(1)
  expect(f.runtime.targetClosed).toBe(true); expect(f.runtime.leaseClosed).toBe(false)
  f.lock.close(); f.lock.close(); expect(f.runtime.leaseClosed).toBe(true); f.directory.close()
})
it('refuses forged leases, reserved names and calls outside the admitted generated namespace', () => {
  const f = controlFixture()
  expect(() => createPosixControlRecordOwner(f.directory, { ...f.lock }, ['selector.json'])).toThrow('invalid')
  for (const names of [[], ['../original'], ['x/y'], ['x\\y'], ['.dsh-private-stage'], ['management.lock'], ['x', 'x']]) {
    expect(() => createPosixControlRecordOwner(f.directory, f.lock, names)).toThrow()
  }
  expect(() => f.owner.read('original.patch.yml', { maxBytes: 100 })).toThrow('outside')
  f.lock.close(); expect(() => f.make()).toThrow('closed'); f.directory.close()
})
it('checks the actual lease again at publication and preserves the current record after rejection', () => {
  const f = controlFixture(), writer = f.make(); writer.append(data); f.lock.close()
  expect(() => writer.finish()).toThrow()
  expect(writer.receipt).toMatchObject({ outcome: 'failed', staging: { publication: 'not-published', cleanup: 'removed' } })
  expect(f.runtime.targetBytes).toEqual(f.prior); expect(f.runtime.replacements).toBe(0); f.directory.close()
})
it('does not create staging before the revision verifier accepts current bytes', () => {
  const f = controlFixture()
  expect(() => f.make(() => { throw new Error('revision conflict') })).toThrow('validate-revision')
  expect(f.calls).not.toContain('create'); expect(f.runtime.targetBytes).toEqual(f.prior)
  expect(f.runtime.targetClosed).toBe(true); expect(f.runtime.leaseClosed).toBe(false)
  f.lock.close(); f.directory.close()
})

it('selects Darwin replacement synchronization from the retained control parent', () => {
  const f = controlFixture(), inspect = f.native.inspect.bind(f.native)
  f.native.inspect = capability => ({ ...inspect(capability), platform: 'darwin' })
  const writer = f.make(); writer.append(data)
  expect(writer.finish()).toMatchObject({ staging: { mechanism: 'darwin-file-directory-fullsync-v1', durability: 'synced' } })
  f.lock.close(); f.directory.close()
})

it('consumes control staging authority once and makes the current-resource close idempotent', () => {
  const f = controlFixture(), writer = f.make(), resource = captured.control!
  expect(() => resource.createStaging()).toThrow('already created or closed')
  writer.abort()
  const calls = [...f.calls]
  resource.close(); resource.close()
  expect(f.calls).toEqual(calls)
  expect(() => resource.createStaging()).toThrow('already created or closed')
  f.lock.close(); f.directory.close()
})

it.each(['lost-acknowledgement', 'wrong-replaced-object'] as const)('never upgrades replacement verification after %s', (failure) => {
  const f = controlFixture(), replace = f.native.replacePrivateRecord.bind(f.native), writer = f.make()
  f.native.replacePrivateRecord = (...args) => {
    const result = replace(...args)
    if (failure === 'lost-acknowledgement') throw new Error('replacement acknowledgement lost')
    return { ...result, replacedFacts: { ...result.replacedFacts, ino: 'foreign' } }
  }
  writer.append(data)
  expect(() => writer.finish()).toThrow()
  expect(writer.receipt).toMatchObject({ outcome: 'failed', staging: { publication: 'published', cleanup: 'withheld' } })
  expect(writer.receipt.replacementVerification).not.toBe('verified')
  if (failure === 'lost-acknowledgement') expect(writer.receipt.replacement).toBeNull()
  expect(f.calls).not.toContain('remove'); expect(f.runtime.replacements).toBe(1)
  expect(f.runtime.targetBytes).toEqual(data)
  f.lock.close(); f.directory.close()
})
