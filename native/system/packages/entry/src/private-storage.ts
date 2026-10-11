/** Lazy POSIX retained-storage primitives; importing this entry never loads an addon. */
import { createRequire } from 'node:module'
import { dirname, join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

declare const directoryBrand: unique symbol
declare const fileBrand: unique symbol
declare const leaseBrand: unique symbol

/** Environment-owned retained directory chain. No file descriptor can be extracted or supplied. */
export interface PosixStorageDirectory { readonly [directoryBrand]: true }

/** Environment-owned readonly source or exclusive staging file, retaining its parent independently. */
export interface PosixStorageFile { readonly [fileBrand]: true }

/** Retained nonblocking writer lease; release closes its owned descriptor without unlinking. */
export interface PosixStorageLease { readonly [leaseBrand]: true }

/** Same-object stat observations; decimal strings preserve native integer width. */
export interface PosixObjectFacts {
  readonly kind: 'directory' | 'regular' | 'symlink' | 'fifo' | 'socket' | 'character' | 'block' | 'unknown'
  readonly dev: string
  readonly ino: string
  readonly uid: string
  readonly gid: string
  readonly mode: number
  readonly nlink: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

/** Filesystem and access observations do not imply a private source or power-loss acceptance. */
export interface PosixStorageFacts extends PosixObjectFacts {
  readonly platform: 'linux' | 'darwin'
  readonly filesystem: Readonly<{ type: string; name: string; readOnly: boolean; fsid: string; blockSize: string }>
  readonly acl: Readonly<{ model: string; entries: number; defaultEntries: number; supported: boolean }>
  readonly bindingVerified: boolean
  readonly created: boolean
  readonly creationSync: Readonly<{ directory: boolean; parent: boolean }>
  readonly bytesRead: string
  readonly bytesWritten: string
  readonly published: boolean
  readonly removed: boolean
  readonly leaseHeld?: boolean
  /** Actual retained parent of a directory; absent only for the filesystem root or non-directory capabilities. */
  readonly parentBinding?: Readonly<{ name: string; before: PosixObjectFacts; after: PosixObjectFacts }>
}

/** Known residue and release outcomes when native creation fails before returning a capability. */
export interface PosixStorageCreationFacts {
  readonly kind: 'staging' | 'lease' | 'directory'
  readonly entryCreated: boolean
  readonly entryCreationState: 'created' | 'not-created' | 'indeterminate'
  readonly facts: PosixObjectFacts | null
  readonly bindingVerified: boolean
  readonly release: Readonly<{ attempted: boolean; completed: boolean; errno: number | null }>
  readonly creationSync: Readonly<{ directory: boolean; parent: boolean }>
  readonly cleanup: Readonly<{ attempted: false; removed: false; directorySynced: false }>
}

/** Actual replacement observations; the generated record owner supplies serialization and digest/revision checks. */
export interface PosixStorageReplacement {
  readonly published: true
  readonly leaseVerified: true
  readonly mechanism: 'renameat2(flags=0)' | 'renameatx_np(flags=0)'
  readonly facts: PosixStorageFacts
  readonly replacedFacts: PosixObjectFacts
  readonly replacedAfterFacts: PosixObjectFacts
  readonly stagingParentFacts: PosixObjectFacts
  readonly targetParentFacts: PosixObjectFacts
  readonly parentAfterFacts: PosixObjectFacts
}

/** Observable outcome of one native resource or synchronization operation. */
export interface PosixStorageOperation {
  readonly [key: string]: unknown
}

/** Internal native owner operations used by a bounded source reader and publication provider. */
export interface PosixStoragePrimitives {
  /** @param parent Retained source parent. @param name Literal link leaf. @param maximum Target byte ceiling. @returns Same-link observations without following the target. */
  inspectSourceLink(parent: PosixStorageDirectory, name: string, maximum: number): {
    targetBytes: Uint8Array; before: PosixObjectFacts; after: PosixObjectFacts; bindingVerified: true; released: true
  }
  /**
   * Observe precise Darwin kernel birth facts for this process or its verified direct child.
   * @param pid Current process or direct-child PID; unrelated processes refuse.
   * @returns Current boot/start observations only; absence/failure never confirms process exit.
   */
  observeProcessBirth(pid: number): {
    readonly platform: 'darwin'; readonly pid: number; readonly parentPid: number; readonly uid: string;
    readonly scope: 'current-process' | 'direct-child'; readonly mechanism: 'proc_pid_rusage(RUSAGE_INFO_V0)';
    readonly startAbstime: string; readonly bootSessionUuid: string; readonly observationOnly: true;
  }
  /**
   * Walk literal components without following links and retain every directory descriptor.
   * @param absolutePath Canonical absolute location, never resolved through realpath.
   * @param policy Read-only shared source admission or owner-only persistent private destination admission.
   * @param createFinal Create only an absent last private directory component, after parent admission.
   * @returns A retained chain; existing permissions are never changed.
   */
  openDirectory(absolutePath: string, policy: 'source' | 'private', createFinal: boolean): PosixStorageDirectory
  /**
   * Open one retained child without following links, preserving its parent's source/private policy.
   * @param parent Live retained directory.
   * @param name Literal child component.
   * @returns A child with independently retained ancestors.
   */
  openChild(parent: PosixStorageDirectory, name: string): PosixStorageDirectory
  /**
   * Exclusively create and synchronize one empty private child below a retained parent.
   * @param parent Admitted private directory.
   * @param name Absent literal child component.
   * @returns Retained child and actual publication/synchronization observations; collisions never open existing entries.
   */
  createPrivateChild(parent: PosixStorageDirectory, name: string): {
    capability: PosixStorageDirectory; facts: PosixStorageFacts; parentBeforeFacts: PosixObjectFacts; parentAfterFacts: PosixObjectFacts;
    published: true; mechanism: 'mkdirat'; creationSync: { directory: true; parent: true };
  }
  /**
   * Open an output-audit reader without granting control-record replacement authority.
   * @param parent Admitted private directory.
   * @param name Private single-link 0600/0700 regular output, at most 1 GiB.
   * @returns Retained readonly output capability with complete change observations.
   */
  openPrivateOutput(parent: PosixStorageDirectory, name: string): PosixStorageFile
  /**
   * Enumerate a complete bounded literal child list through a retained directory descriptor.
   * @param parent Admitted private directory.
   * @param maxEntries Integer from zero through 100000; excess refuses rather than truncates.
   * @returns Stat-only entry observations and stable before/after parent observations; unopened entry privacy is not asserted.
   */
  listDirectory(parent: PosixStorageDirectory, maxEntries: number): {
    entries: readonly { name: string; facts: PosixObjectFacts }[]; parentBeforeFacts: PosixObjectFacts; parentAfterFacts: PosixObjectFacts; complete: true;
  }
  /** @param parent Retained source directory. @param maxEntries Complete-list ceiling. @returns Unopened entry observations without private policy authority. */
  listSourceDirectory(parent: PosixStorageDirectory, maxEntries: number): ReturnType<PosixStoragePrimitives['listDirectory']>
  /**
   * Observe filesystem capacity through the retained admitted private directory.
   * @param parent Admitted private directory.
   * @returns Actual native available allocation units/inodes; no reservation or concurrent-space guarantee.
   */
  observeCapacity(parent: PosixStorageDirectory): {
    filesystem: PosixStorageFacts['filesystem']; allocationUnitBytes: string; availableBytes: string; freeEntries: string | null;
    availableEntries: string | null; parentBeforeFacts: PosixObjectFacts; parentAfterFacts: PosixObjectFacts; reservation: false;
  }
  /**
   * Open an existing regular source readonly and capture complete observations.
   * @param parent Retained source directory.
   * @param name One literal component.
   * @returns A readonly source capability retaining its parent.
   */
  openSource(parent: PosixStorageDirectory, name: string): PosixStorageFile
  /**
   * Open a bounded-record source with private owner/mode/ACL/single-link policy.
   * @param parent Retained private directory.
   * @param name One literal component.
   * @returns A readonly record capability with unchanged-observation checks; no expected artifact digest is implied.
   */
  openPrivateRecord(parent: PosixStorageDirectory, name: string): PosixStorageFile
  /**
   * Exclusively create a zero-length private staging file below an admitted destination.
   * @param parent Retained private directory.
   * @param name One unpredictable staging component, chosen by the publication owner.
   * @returns A writable single-link 0600 file; collisions never truncate existing entries.
   */
  createFile(parent: PosixStorageDirectory, name: string): PosixStorageFile
  /**
   * Acquire a nonblocking kernel lease on a private 0600 single-link lock record.
   * @param parent Retained private directory.
   * @param name Literal generated management-lock name; existing files are never truncated.
   * @returns An opaque lease retaining its parent; collisions with a live lease fail without waiting.
   */
  acquireLease(parent: PosixStorageDirectory, name: string): PosixStorageLease
  /**
   * Replace one fully read generated private control record under the same parent's live management lease.
   * @param staging New 0600 staging record, at most 64 MiB and already file-synchronized.
   * @param target Readonly private record consumed to EOF with unchanged observations.
   * @param lease Live same-parent lease; callers serialize identity/digest/revision checks under it.
   * @returns Actual replacement facts; no hostile-writer compare-and-swap or original-file write is implied.
   */
  replacePrivateRecord(staging: PosixStorageFile, target: PosixStorageFile, lease: PosixStorageLease): PosixStorageReplacement
  /**
   * Recheck retained identity, policy and component bindings.
   * @param capability Live directory or file owned by this native environment.
   * @returns Same-descriptor observations with actual filesystem facts.
   */
  inspect(capability: PosixStorageDirectory | PosixStorageFile | PosixStorageLease): PosixStorageFacts
  /**
   * Observe a literal child binding without following or opening the child.
   * @param parent Live retained directory.
   * @param name One literal component.
   * @returns Stat facts or null only for ENOENT; no leaf ACL claim is made.
   */
  inspectBinding(parent: PosixStorageDirectory, name: string): PosixObjectFacts | null
  /**
   * Observe a child through a file's independently retained parent.
   * @param file Retained source or staging capability.
   * @param name One literal component.
   * @returns Stat facts or null only for ENOENT, even after the caller closes its directory capability.
   */
  inspectFileBinding(file: PosixStorageFile, name: string): PosixObjectFacts | null
  /**
   * Read sequentially, checking admitted source observations before and after the bounded read.
   * @param file Readonly source capability.
   * @param maxBytes Positive integer at most 1 MiB.
   * @returns An owned buffer; an empty buffer records EOF. Changed sources become terminal.
   */
  read(file: PosixStorageFile, maxBytes: number): Buffer
  /**
   * Write one bounded chunk completely, preserving confirmed progress on errors.
   * @param file Exclusive staging capability; readonly sources cannot be written.
   * @param bytes Nonempty owned buffer at most 1 MiB.
   * @returns Confirmed bytes for this call and total native bytes written.
   */
  write(file: PosixStorageFile, bytes: Buffer): { bytesWritten: number; totalBytesWritten: string }
  /**
   * Set only the owner-execute policy on a newly created, unpublished private object.
   * @param file Exclusive staging capability.
   * @param executable Whether the admitted output manifest requires 0700 instead of 0600.
   * @returns Actual native operation observations.
   */
  setExecutable(file: PosixStorageFile, executable: boolean): PosixStorageOperation
  /**
   * Synchronize the retained regular file.
   * @param file Retained file capability.
   * @param full Use Darwin F_FULLFSYNC; Linux uses fsync.
   * @returns Actual native operation observations; unsupported synchronization fails.
   */
  syncFile(file: PosixStorageFile, full: boolean): PosixStorageOperation
  /**
   * Submit retained directory metadata through fsync.
   * @param parent Live admitted private directory.
   * @returns Actual native operation observations.
   */
  syncDirectory(parent: PosixStorageDirectory | PosixStorageFile): PosixStorageOperation
  /**
   * Publish once with relative no-replace rename under the same retained parent.
   * @param file Exclusive staging file.
   * @param finalName One absent final component; a racing entry is never replaced.
   * @returns Publication facts; failures preserve rename-attempt and uncertainty observations.
   */
  publish(file: PosixStorageFile, finalName: string): { published: true; mechanism: string; facts: PosixStorageFacts }
  /**
   * Remove only a verified unpublished own staging binding under cooperative namespace ownership.
   * @param file Exclusive staging file; published or uncertain objects cannot be removed.
   * @returns Actual cleanup observations; uncertain binding withholds removal.
   */
  removeUnpublished(file: PosixStorageFile): PosixStorageOperation
  /**
   * Invalidate and release owned descriptors once; never publish or remove a name.
   * @param capability Directory or file owned by this native environment.
   * @returns Release observations; repeated close performs no descriptor operation.
   */
  close(capability: PosixStorageDirectory | PosixStorageFile | PosixStorageLease): PosixStorageOperation
}

let binding: PosixStoragePrimitives | undefined
let bindingIdentity: PosixStorageRuntimeIdentity | undefined

/**
 * Load this platform's separate Node-API v8 retained-storage addon on explicit demand.
 * @returns Opaque native operations; no installation-time compile or environment-path override exists.
 * @throws When the platform, architecture or shipped binary is unavailable.
 */
export function loadPosixStoragePrimitives(): PosixStoragePrimitives {
  if (binding !== undefined) {
    if (JSON.stringify(readPosixStorageRuntimeIdentity()) !== JSON.stringify(bindingIdentity)) throw new Error('loaded POSIX package bytes changed')
    return binding
  }
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`POSIX private storage is not supported on ${platform}-${arch}`), {
      code: 'ERR_POSIX_STORAGE_UNSUPPORTED_PLATFORM',
    })
  }
  let filename = 'private-storage.node'
  if (platform === 'linux') {
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  const before = readPosixStorageRuntimeIdentity()
  const loaded = require(join(dirname(manifest), 'bin', filename)) as PosixStoragePrimitives
  const after = readPosixStorageRuntimeIdentity()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('POSIX package changed during loading')
  bindingIdentity = before
  binding = loaded
  return binding
}


/** Exact current package/binary observations; availability is separate from native filesystem acceptance. */
export interface PosixStorageRuntimeIdentity {
  readonly platform: 'linux' | 'darwin'
  readonly architecture: string
  readonly nodeApi: 8
  readonly entry: Readonly<{ name: string; version: string; file: string; sha256: string }>
  readonly platformPackage: Readonly<{ name: string; version: string; binary: string; sha256: string; bytes: number }>
}
/**
 * Inspect the actual lazy-selected native package and load its current binary without admitting a destination.
 * @returns Exact entry and binary byte identities; this does not certify native tests, privacy or persistence.
 * @throws When the supported current package or matching binary cannot load.
 */
export function inspectPosixStorageRuntime(): PosixStorageRuntimeIdentity {
  loadPosixStoragePrimitives()
  if (bindingIdentity === undefined) throw new Error('loaded POSIX package identity unavailable')
  return bindingIdentity
}
function readPosixStorageRuntimeIdentity(): PosixStorageRuntimeIdentity {
  const platform = process.platform
  if (platform !== 'linux' && platform !== 'darwin') throw new Error('POSIX provider unavailable')
  const require = createRequire(import.meta.url)
  const entryFile = fileURLToPath(import.meta.url)
  const entryManifest: unknown = JSON.parse(readFileSync(join(dirname(entryFile), '../package.json'), 'utf8'))
  const packageName = `@deepseek-ai/node-addon-system-${platform}-${process.arch}`
  const packagePath = require.resolve(`${packageName}/package.json`)
  const packageManifest: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
  const version = (value: unknown, name: string): string => {
    if (value === null || typeof value !== 'object' || !('name' in value) || value.name !== name
      || !('version' in value) || value.version !== '0.1.3') throw new Error('POSIX native package identity mismatch')
    return value.version
  }
  const entryVersion = version(entryManifest, '@deepseek-ai/node-addon-system')
  const platformVersion = version(packageManifest, packageName)
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  const binary = platform === 'linux' ? `bin/${report.header.glibcVersionRuntime ? 'glibc' : 'musl'}/private-storage.node` : 'bin/private-storage.node'
  const bytes = readFileSync(join(dirname(packagePath), binary))
  const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
  return Object.freeze({ platform, architecture: process.arch, nodeApi: 8,
    entry: Object.freeze({ name: '@deepseek-ai/node-addon-system', version: entryVersion,
      file: `${basename(dirname(entryFile))}/${basename(entryFile)}`, sha256: hash(readFileSync(entryFile)) }),
    platformPackage: Object.freeze({ name: packageName, version: platformVersion, binary, sha256: hash(bytes), bytes: bytes.length }),
  })
}
