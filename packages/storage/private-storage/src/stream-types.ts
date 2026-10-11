/** Platform-qualified bounded stream facts, independent of the existing byte-storage API. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Caller correlation only; never a filename, authority or permission to resume an operation. */
export type PrivateStreamOperationId = Branded<'PrivateStreamOperationId'>

/** Full object identity in the native provider's current realm. */
export type StreamIdentity = Readonly<{ backend: 'posix'; device: string; inode: string }>
  | Readonly<{ backend: 'windows-ntfs'; volumeSerial: string; fileId: string }>

/** Named native publication sequence; successful calls do not assert empirical power-loss survival. */
export type StreamMechanism = 'linux-file-directory-fsync-v1' | 'darwin-file-directory-fullsync-v1'
  | 'windows-ntfs-write-through-rename-v1'

/** One actual native synchronization observation. */
export type StreamSyncObservation = 'not-required' | 'not-attempted' | 'succeeded' | 'failed' | 'indeterminate'

/** Fixed output manifest supplied before any staging side effect. */
export interface PrivateFileWriterOptions {
  readonly operationId: PrivateStreamOperationId
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly replace: false
  readonly executable: boolean
}

/** Separate namespace, content, persistence and release facts for one writer. */
export interface PrivateFilePublicationReceipt {
  readonly operationId: PrivateStreamOperationId
  readonly finalName: string
  readonly stagingName: string | null
  readonly mechanism: StreamMechanism
  readonly identity: StreamIdentity | null
  readonly parentIdentity: StreamIdentity | null
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly acceptedBytes: number
  readonly observedSizeBytes: number | null
  readonly confirmedPartialBytes: number | null
  readonly actualSha256: string | null
  readonly executable: boolean
  readonly metadataVerification: 'unverified' | 'verified' | 'failed'
  readonly executableMetadata: 'unverified' | 'verified' | 'failed' | 'not-required'
  readonly outcome: 'open' | 'finishing' | 'finished' | 'aborted' | 'failed' | 'closed'
  readonly phase: string
  readonly publication: 'not-published' | 'published' | 'indeterminate'
  readonly contentVerification: 'unverified' | 'verified' | 'failed'
  readonly bindingVerification: 'unverified' | 'verified' | 'failed'
  readonly durability: 'unconfirmed' | 'synced'
  readonly synchronization: Readonly<{ preFile: StreamSyncObservation; directory: StreamSyncObservation; postFile: StreamSyncObservation }>
  readonly cleanup: 'not-needed' | 'removed' | 'delete-pending' | 'withheld' | 'failed'
  readonly cleanupDurability: 'unconfirmed' | 'synced'
  readonly release: 'not-attempted' | 'released' | 'failed'
}

/** Append-only provider-bound writer. Every call settles synchronously; no seek, resume or replacement exists. */
export interface PrivateFileWriter {
  readonly receipt: PrivateFilePublicationReceipt
  /** @param chunk Nonempty owned input, at most 1 MiB; shared backing memory is refused. */
  append(chunk: Uint8Array): void
  /** @returns Cached successful receipt; a failed finish rethrows its saved failure without republishing. */
  finish(): PrivateFilePublicationReceipt
  /** @returns Terminal receipt; only a known unpublished own staging object may be removed. */
  abort(): PrivateFilePublicationReceipt
  /** Release only; never publish or delete a namespace entry. */
  close(): void
}

/** Same-handle source observations; no destination privacy or writable-volume claim is attached. */
export interface SourceFileFacts {
  readonly identity: StreamIdentity
  readonly sizeBytes: number
  readonly links: number
  readonly changeToken: string
  readonly observations: Readonly<Record<string, string | number | boolean>>
}

/** Exact source selection supplied by a frozen materialization plan. */
export interface SourceFileReaderOptions {
  readonly expectedIdentity: StreamIdentity
  readonly expectedBytes: number
  readonly expectedSha256: string
}

/** Source completion is required before its destination can be sealed or published as verified. */
export interface SourceFileReadReceipt {
  readonly source: SourceFileFacts
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly observedBytes: number
  readonly actualSha256: string | null
  readonly eof: boolean
  readonly observations: 'unverified' | 'unchanged' | 'failed'
  readonly verification: 'unverified' | 'verified' | 'failed'
  readonly release: 'not-attempted' | 'released' | 'failed'
  readonly outcome: 'open' | 'finished' | 'failed' | 'closed'
}

/** Sequential readonly source, never a writable handle or a pathname to reopen. */
export interface SourceFileReader {
  readonly receipt: SourceFileReadReceipt
  /** @param maxBytes Positive ceiling at most 1 MiB. @returns Owned bytes; hash accounting happens before return. */
  readChunk(maxBytes: number): Uint8Array
  /** @returns Exact EOF/identity/digest result; repeated successful finish is cached. */
  finish(): SourceFileReadReceipt
  /** Release only; never change source data, timestamps, permissions or names. */
  close(): void
}
