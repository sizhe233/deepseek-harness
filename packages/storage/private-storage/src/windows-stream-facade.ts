/** One installed Windows stream provider delegates legacy directory ownership to its root entry. */
import { PrivateStorageError } from './error.ts'
import type { PrivateDirectory, PrivateWriterLease, PublicationReceipt } from './types.ts'
import type { PrivateFileWriterOptions, SourceFileReaderOptions } from './stream-types.ts'
import type { PrivateStreamDirectory, ManagementLease, PrivateStreamCapacity, PrivateStreamDirectoryPublication, PrivateStreamInspectedEntry } from './stream-directory-types.ts'
import { createBoundedFileWriter } from './stream-writer.ts'
import { createBoundedSourceReader } from './source-reader.ts'
import { createWindowsWriterResource, type WindowsWriterParent } from './windows-stream-writer.ts'
import { readBoundedPrivateRecord } from './private-record-reader.ts'
import { openWindowsPrivateRecordResource } from './windows-private-record.ts'
import { inspectWindowsPrivateStreamDirectory, listWindowsPrivateStreamDirectory } from './windows-stream-directory.ts'
import { createBoundedControlRecordWriter, type ControlRecordWriterOptions } from './control-record.ts'
import { openWindowsControlRecordResource } from './windows-control-record.ts'
import { openWindowsPrivateLogSink } from './windows-log-sink.ts'
import { sameIdentity, validateName } from './policy.ts'
import { failWithWindowsCleanup, releaseWindowsResources } from './windows-stream-cleanup.ts'
import { openWindowsPrivateStreamRoot } from './windows-root-opening.ts'

/** Internal singleton bridge, supplied only by the root that owns legacy Windows capabilities. */
export interface WindowsStreamOwner {
  openDirectory(path: string, options: { create: boolean }): PrivateDirectory
  openChild(parent: PrivateDirectory, name: string): PrivateDirectory
  createChild(parent: PrivateDirectory, name: string): { directory: PrivateDirectory; receipt: PublicationReceipt }
  retainParent(parent: PrivateDirectory): WindowsWriterParent
  rootParentIdentity(directory: PrivateDirectory): PrivateDirectory['identity']
  acquireLease(parent: PrivateDirectory, name: string): PrivateWriterLease
  assertLease(lease: PrivateWriterLease, parent: WindowsWriterParent, name: string): void
}

/**
 * Construct one Windows stream domain without loading native code.
 * @param owner Root-owned legacy authority; this bridge is never exposed by package exports.
 * @returns Additive stream operations whose opaque wrappers share one installed provider instance.
 */
export function createWindowsStreamFacade(owner: WindowsStreamOwner) {
  const directories = new WeakMap<PrivateStreamDirectory, PrivateDirectory>()
  const leases = new WeakMap<ManagementLease, { native: PrivateWriterLease; name: string }>()
  const wrap = (directory: PrivateDirectory): PrivateStreamDirectory => {
    const wrapper = Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...directory.identity }),
      policy: 'private', close() { directory.close() } }) as PrivateStreamDirectory
    directories.set(wrapper, directory)
    return wrapper
  }
  const select = (directory: PrivateStreamDirectory): PrivateDirectory => {
    const selected = directories.get(directory)
    if (selected === undefined) throw new PrivateStorageError('closed', 'private stream directory belongs to another provider')
    return selected
  }
  const parent = (directory: PrivateStreamDirectory): WindowsWriterParent => owner.retainParent(select(directory))
  const assertLease = (lease: ManagementLease, retained: WindowsWriterParent): { native: PrivateWriterLease; name: string } => {
    const state = leases.get(lease)
    if (state === undefined) throw new PrivateStorageError('closed', 'management lease belongs to another provider')
    owner.assertLease(state.native, retained, state.name)
    return state
  }
  const withParent = <T>(
    directory: PrivateStreamDirectory, operation: (retained: WindowsWriterParent) => T,
  ): T => {
    const retained = parent(directory)
    let result: T
    try { result = operation(retained) }
    catch (error) { failWithWindowsCleanup(error, () => { retained.release() }) }
    releaseWindowsResources([() => { retained.release() }])
    return result
  }
  const readRecord = (directory: PrivateStreamDirectory, name: string, options: { maxBytes: number }) =>
    readBoundedPrivateRecord(options.maxBytes, () => openWindowsPrivateRecordResource(parent(directory), name))
  return Object.freeze({
    owns: (directory: object): boolean => directories.has(directory as PrivateStreamDirectory),
    openDirectory: (path: string, options: { create: boolean }) => wrap(owner.openDirectory(path, options)),
    openRoot: (path: string, options: { create: boolean }) => {
      const result = openWindowsPrivateStreamRoot(owner, path, options)
      return Object.freeze({ directory: wrap(result.directory), receipt: result.receipt })
    },
    openChild: (directory: PrivateStreamDirectory, name: string) => wrap(owner.openChild(select(directory), name)),
    createChild: (directory: PrivateStreamDirectory, name: string) => {
      const created = owner.createChild(select(directory), name)
      if (created.receipt.phase !== 'complete' || created.receipt.publication !== 'published'
        || created.receipt.durability !== 'synced' || created.receipt.cleanup !== 'not-needed' || created.receipt.identity === null
        || !sameIdentity(created.receipt.identity, created.directory.identity)) {
        failWithWindowsCleanup(new PrivateStorageError('native', 'directory publication incomplete', { receipt: created.receipt }),
          () => { created.directory.close() })
      }
      const receipt: PrivateStreamDirectoryPublication = Object.freeze({
        mechanism: 'windows-ntfs-write-through-directory-rename-v1',
        parentIdentity: Object.freeze({ backend: 'windows-ntfs', ...created.receipt.parentIdentity }),
        identity: Object.freeze({ backend: 'windows-ntfs', ...created.directory.identity }), name,
        publication: 'published', bindingVerification: 'verified', privacyVerification: 'verified', durability: 'synced',
        synchronization: Object.freeze({ child: 'not-required', parent: 'not-required' }), release: 'retained',
      })
      return { directory: wrap(created.directory), receipt }
    },
    createWriter: (directory: PrivateStreamDirectory | PrivateDirectory, name: string, options: PrivateFileWriterOptions) => {
      validateName(name)
      const selected = directories.get(directory as PrivateStreamDirectory) ?? directory as PrivateDirectory
      return createBoundedFileWriter(name, options, 'windows-ntfs-write-through-rename-v1',
        () => createWindowsWriterResource(owner.retainParent(selected), name))
    },
    readRecord,
    openFileReader: (directory: PrivateStreamDirectory, name: string, options: SourceFileReaderOptions) =>
      createBoundedSourceReader(options, () => openWindowsPrivateRecordResource(parent(directory), name)),
    list: (directory: PrivateStreamDirectory, maximum: number) => listWindowsPrivateStreamDirectory(parent(directory), maximum),
    inspect: (directory: PrivateStreamDirectory, name: string): PrivateStreamInspectedEntry => {
      validateName(name)
      const kind = withParent(directory, (retained) => {
        const handle = retained.api.open(retained.handle, name, 'any', 'inspect', retained.sid)
        let observed: 'file' | 'directory'
        try { retained.api.verifyName(handle, name); observed = retained.api.inspect(handle, retained.sid).kind }
        catch (error) { failWithWindowsCleanup(error, () => { retained.api.close(handle) }) }
        releaseWindowsResources([() => { retained.api.close(handle) }])
        return observed
      })
      if (kind === 'directory') {
        const child = owner.openChild(select(directory), name)
        let facts
        try { facts = inspectWindowsPrivateStreamDirectory(owner.retainParent(child)) }
        catch (error) { failWithWindowsCleanup(error, () => { child.close() }) }
        releaseWindowsResources([() => { child.close() }])
        return { kind, facts }
      }
      const resource = openWindowsPrivateRecordResource(parent(directory), name)
      let facts
      try { facts = resource.inspect() }
      catch (error) { failWithWindowsCleanup(error, () => { resource.close() }) }
      releaseWindowsResources([() => { resource.close() }])
      return { kind, facts: Object.freeze({ ...facts, privateVerified: true, executable: null }) }
    },
    capacity: (directory: PrivateStreamDirectory): PrivateStreamCapacity => withParent(directory, (retained) => {
      retained.validate()
      const facts = retained.api.capacity(retained.handle)
      retained.validate()
      return Object.freeze({ directoryIdentity: Object.freeze({ backend: 'windows-ntfs', ...retained.identity }),
        filesystemId: retained.identity.volumeSerial, allocationUnitBytes: facts.allocationUnitBytes.toString(),
        availableBytes: facts.availableBytes.toString(), availableEntries: null, scope: 'observed-filesystem-capacity' })
    }),
    acquireLease: (directory: PrivateStreamDirectory, name: string): ManagementLease => {
      const native = owner.acquireLease(select(directory), name)
      const lease = Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...native.identity }),
        parentIdentity: directory.identity, close() { native.close() } }) as ManagementLease
      leases.set(lease, { native, name })
      return lease
    },
    assertLease: (directory: PrivateStreamDirectory, lease: ManagementLease): void => {
      withParent(directory, (retained) => { assertLease(lease, retained) })
    },
    controlOwner: (directory: PrivateStreamDirectory, lease: ManagementLease, names: readonly string[]) => {
      const lockName = withParent(directory, retained => assertLease(lease, retained).name)
      const allowed = new Set<string>()
      for (const name of names) {
        validateName(name)
        if (name === lockName || name.startsWith('.dsh-private-') || allowed.has(name.toLowerCase())) throw new PrivateStorageError('name', 'invalid fixed control namespace')
        allowed.add(name.toLowerCase())
      }
      if (names.length < 1 || names.length > 1024) throw new RangeError('control owner requires 1 through 1024 names')
      const fixed = Object.freeze([...names])
      const check = (name: string): void => {
        if (!fixed.includes(name)) throw new PrivateStorageError('name', 'record outside fixed control namespace')
        withParent(directory, (retained) => { assertLease(lease, retained) })
      }
      return Object.freeze({ names: fixed,
        read(name: string, options: { maxBytes: number }) { check(name); return readRecord(directory, name, options) },
        replace(name: string, options: ControlRecordWriterOptions) {
          check(name)
          return createBoundedControlRecordWriter(name, options, 'windows-ntfs-write-through-rename-v1', () => {
            const retained = parent(directory)
            return openWindowsControlRecordResource(retained, name, () => { assertLease(lease, retained) }, () => parent(directory))
          })
        },
      })
    },
    openLog: (directory: PrivateStreamDirectory, name: string, options: { maxChunkBytes: number }) =>
      openWindowsPrivateLogSink(parent(directory), name, options.maxChunkBytes),
  })
}
