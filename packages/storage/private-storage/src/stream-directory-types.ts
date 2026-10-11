/** Additive retained-directory observations required by complete generation materialization. */
import type { SourceFileFacts, StreamIdentity } from './stream-types.ts'

declare const privateDirectoryBrand: unique symbol
declare const managementLeaseBrand: unique symbol
declare const sourceDirectoryBrand: unique symbol

/** Opaque provider-owned private directory; no native facts or raw handles are exposed. */
export interface PrivateStreamDirectory {
  readonly [privateDirectoryBrand]: true
  readonly identity: StreamIdentity
  readonly policy: 'private'
  /** Release this wrapper once; already opened children retain independent native ownership. */
  close(): void
}

/** Opaque provider-owned readonly source directory; shared readable storage is a distinct policy. */
export interface SourceDirectory {
  readonly [sourceDirectoryBrand]: true
  readonly identity: StreamIdentity
  readonly policy: 'source'
  /** Release this wrapper once; already opened readers retain independent native ownership. */
  close(): void
}

/** Opaque provider-owned same-parent management lease; callers retain its lifetime. */
export interface ManagementLease {
  readonly [managementLeaseBrand]: true
  readonly identity: StreamIdentity
  readonly parentIdentity: StreamIdentity
  /** Release the kernel lease once without unlinking its lock object. */
  close(): void
}

/** Complete current directory observations; capacity and content auditing remain separate operations. */
export interface PrivateStreamDirectoryFacts {
  readonly identity: StreamIdentity
  readonly links: number
  readonly changeToken: string
  readonly observations: Readonly<Record<string, string | number | boolean>>
  readonly privateVerified: true
}
/** A literal enumeration entry; listing does not claim that the entry passed private leaf policy. */
export interface PrivateStreamEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
  readonly identity: StreamIdentity
}
/** Bounded complete enumeration under retained identity; mutation or truncation must throw, never return complete:true. */
export interface PrivateStreamDirectoryListing {
  readonly before: PrivateStreamDirectoryFacts
  readonly after: PrivateStreamDirectoryFacts
  readonly entries: readonly PrivateStreamEntry[]
  readonly complete: true
}
/** Verified regular output facts; Windows has no POSIX execute bit. */
export interface PrivateStreamFileFacts extends SourceFileFacts {
  readonly privateVerified: true
  readonly executable: boolean | null
}
/** Native filesystem observation, not a reservation or guarantee against concurrent consumption. */
export interface PrivateStreamCapacity {
  readonly directoryIdentity: StreamIdentity
  readonly filesystemId: string
  readonly allocationUnitBytes: string
  readonly availableBytes: string
  readonly availableEntries: string | null
  readonly scope: 'observed-filesystem-capacity'
}
/** Empty-child creation records publication, synchronization and retained capability release separately. */
export interface PrivateStreamDirectoryPublication {
  readonly mechanism: 'windows-ntfs-write-through-directory-rename-v1' | 'linux-directory-fsync-v1' | 'darwin-directory-fsync-v1'
  readonly parentIdentity: StreamIdentity
  readonly identity: StreamIdentity | null
  readonly name: string
  readonly publication: 'not-published' | 'published' | 'indeterminate'
  readonly bindingVerification: 'unverified' | 'verified' | 'failed'
  readonly privacyVerification: 'unverified' | 'verified' | 'failed'
  readonly durability: 'unconfirmed' | 'synced'
  readonly synchronization: Readonly<{
    child: 'not-attempted' | 'not-required' | 'succeeded' | 'failed' | 'indeterminate'
    parent: 'not-attempted' | 'not-required' | 'succeeded' | 'failed' | 'indeterminate'
  }>
  readonly release: 'retained' | 'released' | 'failed'
}

/** Inspection discriminates complete admitted directory and regular-file observations. */
export type PrivateStreamInspectedEntry = { readonly kind: 'file'; readonly facts: PrivateStreamFileFacts }
  | { readonly kind: 'directory'; readonly facts: PrivateStreamDirectoryFacts }
