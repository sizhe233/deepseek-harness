/** Lazy Windows resource owner. Importing this subpath performs no native acquisition. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const fileBrand: unique symbol
/** Environment-owned native file capability; it exposes no HANDLE or pointer. */
export interface WindowsPrivateFile { readonly [fileBrand]: true }
/** Bounded coarse operations, all native resources owned before any JavaScript exposure. */
export interface WindowsPrivateOwner {
  /** @returns Copied current primary-token SID; impersonation/restricted-token cases refuse. */
  tokenUser(): Uint8Array
  /**
   * Open one no-reparse component with native lifetime ownership.
   * Failed exposure of a confirmed newly created file attempts retained-handle deletion before close.
   * Unsettled cleanup preserves native quarantine and the original exposure error.
   * @param parent Retained parent, or null only for a literal NT drive-root inspection.
   * @param name Literal component or permitted NT drive root.
   * @param kind Required object kind.
   * @param mode Fixed native access/share/disposition policy.
   * @param descriptor Copied bounded creation descriptor, or null.
   * @returns An opaque native-owned file.
   */
  open(parent: WindowsPrivateFile | null, name: string, kind: 'file' | 'directory' | 'any', mode: 'inspect' | 'read' | 'read-source' | 'read-link' | 'create' | 'lock' | 'delete' | 'log', descriptor: Uint8Array | null): WindowsPrivateFile
  /** @param file Retained no-follow leaf. @returns Copied bounded reparse bytes without resolving its target. */
  reparse(file: WindowsPrivateFile): Uint8Array
  /** @param file Owned file; close retires its HANDLE once, without uncertain-close retry. */
  close(file: WindowsPrivateFile): void
  /**
   * @param file Owned file.
   * @param informationClass Admitted fixed native information class.
   * @param bytes Bounded result width.
   * @param volume Whether this is an admitted volume query.
   * @returns Detached copied settled result bytes.
   */
  query(file: WindowsPrivateFile, informationClass: number, bytes: number, volume: boolean): Uint8Array
  /**
   * @param file Owned file.
   * @returns Actual GetFileType result.
   */
  fileType(file: WindowsPrivateFile): number
  /**
   * @param file Owned file.
   * @returns Copied 24-byte FILE_ID_INFO.
   */
  fileId(file: WindowsPrivateFile): Uint8Array
  /**
   * @param file Owned file.
   * @returns Same-handle filesystem name and flags.
   */
  volumeInfo(file: WindowsPrivateFile): { filesystem: string; flags: number }
  /**
   * @param file Owned file.
   * @returns Copied bounded OWNER+DACL descriptor after native LocalFree.
   */
  security(file: WindowsPrivateFile): Uint8Array
  /**
   * @param file Owned file.
   * @param maximum Maximum copied read length, at most 1 MiB.
   * @returns Detached bytes, empty only at EOF.
   */
  read(file: WindowsPrivateFile, maximum: number): Uint8Array
  /**
   * @param file Owned file.
   * @param bytes Copied input of at most 65536 bytes.
   * @param append Use the fixed native EOF sentinel.
   * @returns Confirmed nonzero byte count.
   */
  write(file: WindowsPrivateFile, bytes: Uint8Array, append: boolean): number
  /** @param file Owned file whose buffers must be flushed. */
  flush(file: WindowsPrivateFile): void
  /**
   * @param file Owned source.
   * @param parent Retained destination parent.
   * @param name Literal destination component.
   * @param replace Explicit fixed replacement policy.
   */
  rename(file: WindowsPrivateFile, parent: WindowsPrivateFile, name: string, replace: boolean): void
  /** @param file Owned file admitted for disposition. */
  remove(file: WindowsPrivateFile): void
  /** @param file Owned file; acquire a nonblocking exclusive byte-zero lease. */
  lock(file: WindowsPrivateFile): void
  /** @param file Owned file holding the lease. */
  unlock(file: WindowsPrivateFile): void
  /**
   * @param directory Retained directory.
   * @param maximum Complete-list limit from zero through 100000.
   * @returns Complete literal names or a refusal, never truncation.
   */
  names(directory: WindowsPrivateFile, maximum: number): readonly string[]
  /**
   * Observe one explicitly selected current or caller-owned child process using query/synchronize rights only.
   * @param pid Exact caller-selected process identifier; no process enumeration or signaling occurs.
   * @returns Birth and exit observation from one retained native handle, released before return.
   * @throws On inaccessible, missing or unconfirmed observations; refusal never establishes exit.
   */
  observeProcess(pid: number): WindowsProcessObservation
  /** @returns Separate atomic process-wide counters; reconcile allocation classes only at controlled quiescent barriers. */
  statistics(): { owners: number; fileRecords: number; openProcesses: number; openFiles: number; openTokens: number; localAllocBlocks: number; heapBlocks: number; pendingContexts: number; unconfirmedReleases: number }
}
/** Same-incarnation read-only observation; state is historical at the completed zero-time native wait. */
export interface WindowsProcessObservation {
  readonly platform: 'win32'
  readonly pid: number
  readonly creationTime100ns: string
  readonly state: 'running' | 'exited'
  readonly mechanism: 'GetProcessTimes+WaitForSingleObject'
  readonly observationOnly: true
}
/** Observed installed bytes, separate from platform acceptance or destination admission. */
export interface WindowsPrivateOwnerRuntimeIdentity {
  readonly platform: 'win32'
  readonly architecture: 'x64'
  readonly nodeApi: 8
  readonly entry: Readonly<{ name: string; version: string; file: string; sha256: string }>
  readonly platformPackage: Readonly<{ name: string; version: string; binary: string; sha256: string; bytes: number }>
}
let owner: WindowsPrivateOwner | undefined
let identity: WindowsPrivateOwnerRuntimeIdentity | undefined
function observe(): WindowsPrivateOwnerRuntimeIdentity {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Object.assign(new Error('Windows private owner requires Windows x64'), { code: 'ERR_WINDOWS_PRIVATE_OWNER_UNSUPPORTED_PLATFORM' })
  const require = createRequire(import.meta.url)
  const entry = fileURLToPath(import.meta.url)
  const platformName = '@deepseek-ai/node-addon-system-win32-x64'
  const platformManifest = require.resolve(`${platformName}/package.json`)
  const version = (path: string, name: string): string => {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (value === null || typeof value !== 'object' || !('name' in value) || value.name !== name || !('version' in value) || value.version !== '0.1.3') throw new Error('Windows native package identity mismatch')
    return value.version
  }
  const entryVersion = version(join(dirname(entry), '../package.json'), '@deepseek-ai/node-addon-system')
  const platformVersion = version(platformManifest, platformName)
  const binary = 'bin/windows-private-owner.node'
  const bytes = readFileSync(join(dirname(platformManifest), binary))
  const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
  return Object.freeze({ platform: 'win32', architecture: 'x64', nodeApi: 8,
    entry: Object.freeze({ name: '@deepseek-ai/node-addon-system', version: entryVersion, file: `${basename(dirname(entry))}/${basename(entry)}`, sha256: hash(readFileSync(entry)) }),
    platformPackage: Object.freeze({ name: platformName, version: platformVersion, binary, sha256: hash(bytes), bytes: bytes.length }),
  })
}
/**
   * @returns The single environment-local native owner from exact successor bytes.
   * @throws On unsupported platform, missing binary or changed installed bytes.
   */
export function loadWindowsPrivateOwner(): WindowsPrivateOwner {
  const before = observe()
  if (owner !== undefined) {
    if (JSON.stringify(before) !== JSON.stringify(identity)) throw new Error('Loaded Windows native package bytes changed')
    return owner
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@deepseek-ai/node-addon-system-win32-x64/package.json')
  const native = require(join(dirname(manifest), before.platformPackage.binary)) as { createOwner(): WindowsPrivateOwner }
  if (typeof native.createOwner !== 'function') throw new Error('Windows native owner entry missing')
  const result = native.createOwner()
  const after = observe()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Windows native package changed during loading')
  identity = before
  owner = result
  return result
}
/** @returns Exact selected entry/platform/binary observations, without a native-acceptance claim. */
export function inspectWindowsPrivateOwnerRuntime(): WindowsPrivateOwnerRuntimeIdentity {
  loadWindowsPrivateOwner()
  if (identity === undefined) throw new Error('Windows native owner identity unavailable')
  return identity
}
