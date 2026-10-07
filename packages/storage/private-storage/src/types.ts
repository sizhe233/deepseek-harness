/** Opaque private-storage capabilities and publication facts. */

declare const directoryBrand: unique symbol
declare const leaseBrand: unique symbol

/** Complete identity within an admitted directory's live capability domain. */
export interface PrivateIdentity {
  readonly volumeSerial: string
  readonly fileId: string
}

/** Independently reported namespace, persistence and cleanup outcomes. */
export interface PublicationReceipt {
  readonly publication: 'not-published' | 'published' | 'indeterminate'
  readonly durability: 'synced' | 'unconfirmed' | 'unsupported'
  readonly phase: string
  readonly identity: PrivateIdentity | null
  readonly parentIdentity: PrivateIdentity
  readonly nativeStatus: number | null
  /** A failed cleanup call leaves release unconfirmed; it does not establish that a handle remains live. */
  readonly cleanup: 'not-needed' | 'delete-pending' | 'failed' | 'withheld'
}

/** Retained private directory; closing a parent does not close already opened children. */
export interface PrivateDirectory {
  readonly [directoryBrand]: true
  readonly identity: PrivateIdentity
  readonly publications: readonly PublicationReceipt[]
  /** Release this capability's handles; repeated calls have no effect. */
  close(): void
}

/** A nonblocking kernel lock owned by this process and retained until release. */
export interface PrivateWriterLease {
  readonly [leaseBrand]: true
  readonly identity: PrivateIdentity
  /** Release only this lease; never delete or recreate the lock file. */
  release(): void
  /** Alias of release; repeated calls have no effect. */
  close(): void
}

/** Complete same-handle metadata, not a continuing security attestation. */
export interface PrivateFacts {
  readonly complete: true
  readonly identity: PrivateIdentity
  readonly kind: 'file' | 'directory'
  readonly links: number
  readonly sizeBytes: bigint
  readonly ownerSid: string
  readonly daclProtected: true
  readonly writeThrough: boolean
}

/** Runtime backend selection; availability does not admit any filesystem. */
export interface PrivateStorageCapabilities {
  readonly available: boolean
  readonly platform: string
  readonly architecture: string
  readonly backend: 'windows-ntfs' | null
  readonly reason?: string
  readonly ownershipArtifact?: import('@deepseek-ai/node-addon-system/windows-private-owner').WindowsPrivateOwnerRuntimeIdentity
  readonly nativeArtifact?: {
    readonly koffiVersion: '3.1.1'
    readonly platformPackage: string
    readonly nativeBinarySha256: string
  }
}

/** Bounded, cooperative directory audit; enumeration is not a snapshot. */
export interface PrivateAuditLimits {
  readonly maxEntries: number
  readonly maxDepth: number
}
