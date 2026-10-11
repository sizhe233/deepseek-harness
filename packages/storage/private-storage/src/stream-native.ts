/** Internal native adapters; only provider owners construct these retained-resource operations. */
import type { SourceFileFacts, StreamIdentity, StreamMechanism } from './stream-types.ts'

/** Current private staging/final facts, after native policy and retained-parent checks. */
export interface StreamFileFacts {
  readonly identity: StreamIdentity
  readonly parentIdentity: StreamIdentity
  readonly sizeBytes: number
  readonly links: number
  readonly privateVerified: boolean
  readonly executable: boolean | null
}

/** One retained staging resource; its lifetime is independent of the caller's directory wrapper. */
export interface StreamWriterResource {
  readonly mechanism: StreamMechanism
  readonly stagingName: string
  readonly parentIdentity?: StreamIdentity
  inspect(): StreamFileFacts
  write(ownedBytes: Uint8Array): void
  setExecutable(executable: boolean): void
  syncFile(): void
  syncDirectory(): void
  publish(): void
  reconcile(): 'not-published' | 'published' | 'indeterminate'
  verifyFinal(): StreamFileFacts
  removeUnpublished(): { deletion: 'not-needed' | 'removed' | 'delete-pending' | 'withheld'; directorySynced: boolean }
  close(): void
}

/** Read-only resource; established observation failures throw SourceObservationError, ordinary I/O failures retain their native error. */
export interface SourceReaderResource {
  inspect(): SourceFileFacts
  read(maxBytes: number): Uint8Array
  close(): void
}
