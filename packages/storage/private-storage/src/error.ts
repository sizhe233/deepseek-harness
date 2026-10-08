/** Typed storage failures without file contents or caller-controlled native messages. */

import type { PublicationReceipt } from './types.ts'

/** Closed set of fail-closed storage outcomes. */
export type PrivateStorageErrorCode = 'unavailable' | 'unsupported' | 'name' | 'privacy' | 'identity'
  | 'changed' | 'limit' | 'not-found' | 'collision' | 'sharing' | 'busy' | 'closed' | 'native'

/** An operation failure; publication state remains available even after a late failure. */
export class PrivateStorageError extends Error {
  /** Stable failure category without caller bytes. */
  readonly code: PrivateStorageErrorCode
  /** Unsigned NTSTATUS when the native completion is known. */
  readonly nativeStatus: number | null
  /** Win32 error code captured immediately after failure. */
  readonly win32Code: number | null
  /** Publication fact preserved through post-publication failures. */
  readonly receipt: PublicationReceipt | undefined
  /** Whether a cleanup call failed or its successful release could not be confirmed. */
  readonly cleanupFailed: boolean
  /** Completed ancestor namespace publications before root opening failed. */
  readonly directoryPublications: readonly PublicationReceipt[]

  constructor(code: PrivateStorageErrorCode, operation: string, details: {
    nativeStatus?: number
    win32Code?: number
    receipt?: PublicationReceipt
    cleanupFailed?: boolean
    directoryPublications?: readonly PublicationReceipt[]
  } = {}) {
    super(`private-storage: ${operation} (${code})`)
    this.name = 'PrivateStorageError'
    this.code = code
    this.nativeStatus = details.nativeStatus ?? null
    this.win32Code = details.win32Code ?? null
    this.receipt = details.receipt
    this.cleanupFailed = details.cleanupFailed ?? false
    this.directoryPublications = Object.freeze([...(details.directoryPublications ?? [])])
  }
}
