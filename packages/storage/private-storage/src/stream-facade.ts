/** Root-owned cross-platform wrappers; importing providers does not load their native payloads. */
import { PrivateStorageError } from './error.ts'
import * as posix from './native-posix.ts'
import { openWindowsSourceDirectory, inspectWindowsSourceFile, openWindowsSourceFileReader, readWindowsSourceDocument,
  openWindowsSourceChild, listWindowsSourceDirectory, inspectWindowsSourceLink, openWindowsObservedSourceFileReader } from './windows-source-reader.ts'
import type { WindowsSourceDirectory } from './windows-source-reader.ts'
import type { createWindowsStreamFacade } from './windows-stream-facade.ts'
import type { PrivateDirectory, PrivateStorageCapabilities } from './types.ts'
import type { PrivateStreamDirectory, SourceDirectory, ManagementLease } from './stream-directory-types.ts'
import type { PrivateFileWriterOptions, SourceFileReaderOptions } from './stream-types.ts'
import type { SourceDocumentReadOptions } from './source-document-reader.ts'
import type { ObservedSourceFileReaderOptions } from './observed-source-reader.ts'

type Windows = ReturnType<typeof createWindowsStreamFacade>
type SelectedSource = { backend: 'windows'; directory: WindowsSourceDirectory } | { backend: 'posix'; directory: posix.PosixStreamDirectory }
/**
 * Create one wrapper domain shared by every public entry of this installed package.
 * @param windows Root-owned Windows operations.
 * @param windowsCapabilities Existing Windows availability probe, without platform acceptance claims.
 * @returns Cross-platform operations retaining separate source/private/lease authority.
 */
export function createStreamFacade(windows: Windows, windowsCapabilities: () => PrivateStorageCapabilities) {
  const directories = new WeakMap<PrivateStreamDirectory, posix.PosixStreamDirectory>()
  const leases = new WeakMap<ManagementLease, posix.PosixManagementLease>()
  const sources = new WeakMap<SourceDirectory, SelectedSource>()
  const wrapSource = (selected: SelectedSource): SourceDirectory => {
    const wrapper = Object.freeze({ identity: selected.directory.identity, policy: 'source', close() { selected.directory.close() } }) as SourceDirectory
    sources.set(wrapper, selected)
    return wrapper
  }
  const wrapDirectory = (directory: posix.PosixStreamDirectory): PrivateStreamDirectory => {
    const wrapper = Object.freeze({ identity: directory.identity, policy: 'private', close() { directory.close() } }) as PrivateStreamDirectory
    directories.set(wrapper, directory)
    return wrapper
  }
  const directoryOf = (directory: PrivateStreamDirectory): posix.PosixStreamDirectory => {
    const selected = directories.get(directory)
    if (selected === undefined) throw new PrivateStorageError('closed', 'private directory belongs to another installed provider')
    return selected
  }
  const leaseOf = (lease: ManagementLease): posix.PosixManagementLease => {
    const selected = leases.get(lease)
    if (selected === undefined) throw new PrivateStorageError('closed', 'management lease belongs to another installed provider')
    return selected
  }
  const sourceOf = (source: SourceDirectory) => {
    const selected = sources.get(source)
    if (selected === undefined) throw new PrivateStorageError('closed', 'source belongs to another installed provider')
    return selected
  }
  return Object.freeze({
    capabilities: () => process.platform === 'win32'
      ? Object.freeze({ ...windowsCapabilities(), acceptance: 'unverified' as const, maxStreamBytes: 1024 * 1024 * 1024, maxChunkBytes: 1024 * 1024 })
      : posix.posixStreamCapabilities(),
    openDirectory: (path: string, options: { create: boolean }): PrivateStreamDirectory => process.platform === 'win32'
      ? windows.openDirectory(path, options) : wrapDirectory(posix.openPosixPrivateDirectory(path, options)),
    openRoot: (path: string, options: { create: boolean }) => {
      if (process.platform === 'win32') return windows.openRoot(path, options)
      const result = posix.openPosixPrivateStreamRoot(path, options)
      return Object.freeze({ directory: wrapDirectory(result.directory), receipt: result.receipt })
    },
    openChild: (directory: PrivateStreamDirectory, name: string): PrivateStreamDirectory => windows.owns(directory)
      ? windows.openChild(directory, name) : wrapDirectory(posix.openPosixPrivateStreamChild(directoryOf(directory), name)),
    createChild: (directory: PrivateStreamDirectory, name: string) => {
      if (windows.owns(directory)) return windows.createChild(directory, name)
      const created = posix.createPosixPrivateStreamChild(directoryOf(directory), name)
      return Object.freeze({ directory: wrapDirectory(created.directory), receipt: created.receipt })
    },
    createWriter: (directory: PrivateStreamDirectory | PrivateDirectory, name: string, options: PrivateFileWriterOptions) => {
      const selected = directories.get(directory as PrivateStreamDirectory)
      return selected === undefined ? windows.createWriter(directory, name, options)
        : posix.createPosixPrivateFileWriter(selected, name, options)
    },
    readRecord: (directory: PrivateStreamDirectory, name: string, options: { maxBytes: number }) => windows.owns(directory)
      ? windows.readRecord(directory, name, options) : posix.readPosixPrivateRecord(directoryOf(directory), name, options),
    openFileReader: (directory: PrivateStreamDirectory, name: string, options: SourceFileReaderOptions) => windows.owns(directory)
      ? windows.openFileReader(directory, name, options) : posix.openPosixPrivateFileReader(directoryOf(directory), name, options),
    list: (directory: PrivateStreamDirectory, maximum: number) => windows.owns(directory)
      ? windows.list(directory, maximum) : posix.listPosixPrivateStreamDirectory(directoryOf(directory), { maxEntries: maximum }),
    inspect: (directory: PrivateStreamDirectory, name: string) => windows.owns(directory)
      ? windows.inspect(directory, name) : posix.inspectPosixPrivateStreamEntry(directoryOf(directory), name),
    capacity: (directory: PrivateStreamDirectory) => windows.owns(directory)
      ? windows.capacity(directory) : posix.observePosixPrivateStreamCapacity(directoryOf(directory)),
    acquireLease: (directory: PrivateStreamDirectory, name: string): ManagementLease => {
      if (windows.owns(directory)) return windows.acquireLease(directory, name)
      const selected = posix.acquirePosixManagementLease(directoryOf(directory), name)
      const wrapper = Object.freeze({ identity: selected.identity, parentIdentity: selected.parentIdentity,
        close() { selected.close() } }) as ManagementLease
      leases.set(wrapper, selected)
      return wrapper
    },
    assertLease: (directory: PrivateStreamDirectory, lease: ManagementLease): void => {
      if (windows.owns(directory)) windows.assertLease(directory, lease)
      else posix.assertPosixManagementLease(directoryOf(directory), leaseOf(lease))
    },
    controlOwner: (directory: PrivateStreamDirectory, lease: ManagementLease, names: readonly string[]) => windows.owns(directory)
      ? windows.controlOwner(directory, lease, names) : posix.createPosixControlRecordOwner(directoryOf(directory), leaseOf(lease), names),
    openLog: (directory: PrivateStreamDirectory, name: string, options: { maxChunkBytes: number }) => {
      if (!windows.owns(directory)) throw new PrivateStorageError('unsupported', 'private log sink requires the Windows provider')
      return windows.openLog(directory, name, options)
    },
    openSource: (path: string): SourceDirectory => {
      const selected = process.platform === 'win32'
        ? { backend: 'windows' as const, directory: openWindowsSourceDirectory(path) }
        : { backend: 'posix' as const, directory: posix.openPosixSourceDirectory(path) }
      return wrapSource(selected)
    },
    openSourceChild: (source: SourceDirectory, name: string): SourceDirectory => {
      const selected = sourceOf(source)
      return wrapSource(selected.backend === 'windows'
        ? { backend: 'windows', directory: openWindowsSourceChild(selected.directory, name) }
        : { backend: 'posix', directory: posix.openPosixSourceChild(selected.directory, name) })
    },
    listSource: (source: SourceDirectory, maximum: number) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? listWindowsSourceDirectory(selected.directory, maximum)
        : posix.listPosixSourceDirectory(selected.directory, maximum)
    },
    inspectSource: (source: SourceDirectory, name: string) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? inspectWindowsSourceFile(selected.directory, name) : posix.inspectPosixSourceFile(selected.directory, name)
    },
    inspectSourceLink: (source: SourceDirectory, name: string, options: { maxBytes: number }) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? inspectWindowsSourceLink(selected.directory, name, options.maxBytes)
        : posix.inspectPosixSourceLink(selected.directory, name, options.maxBytes)
    },
    readSourceDocument: (source: SourceDirectory, name: string, options: SourceDocumentReadOptions) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? readWindowsSourceDocument(selected.directory, name, options)
        : posix.readPosixSourceDocument(selected.directory, name, options)
    },
    openSourceReader: (source: SourceDirectory, name: string, options: SourceFileReaderOptions) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? openWindowsSourceFileReader(selected.directory, name, options)
        : posix.openPosixSourceFileReader(selected.directory, name, options)
    },
    openObservedSourceReader: (source: SourceDirectory, name: string, options: ObservedSourceFileReaderOptions) => {
      const selected = sourceOf(source)
      return selected.backend === 'windows' ? openWindowsObservedSourceFileReader(selected.directory, name, options)
        : posix.openPosixObservedSourceFileReader(selected.directory, name, options)
    },
  })
}
