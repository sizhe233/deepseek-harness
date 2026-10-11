/** Preserve the primary native failure while reporting independent cleanup/release outcomes. */
import { PrivateStorageError, type PrivateStorageErrorCode } from './error.ts'
import type { PublicationReceipt } from './types.ts'

/** Provider signal for an established identity, metadata or binding comparison failure; ordinary I/O errors are distinct. */
export class SourceObservationError extends Error {
  constructor(cause: unknown) {
    super('source observations changed', { cause })
    this.name = 'SourceObservationError'
  }
}

/**
 * Select the original operation failure ahead of later cleanup failures without recursing through cycles.
 * @param cause A native exception or an aggregate assembled during settlement.
 * @returns The primary available cause.
 */
export function primaryStreamFailure(cause: unknown): unknown {
  const seen = new Set<Error>()
  let current = cause
  while ((current instanceof AggregateError && current.errors.length > 0 || current instanceof SourceObservationError)
    && !seen.has(current)) {
    seen.add(current)
    current = current instanceof AggregateError ? current.errors[0] : current.cause
  }
  return current
}

/**
 * Preserve existing storage classifications and native status fields without inventing Windows facts for POSIX.
 * @param cause Original operation failure, possibly followed by cleanup failures.
 * @param cleanupFailed Whether the new receipt records unconfirmed cleanup or release.
 * @returns Base-error details and separate POSIX errno/syscall when actually present.
 */
export function streamFailureDetails(cause: unknown, cleanupFailed: boolean): {
  code: PrivateStorageErrorCode
  details: { nativeStatus?: number; win32Code?: number; cleanupFailed: boolean; directoryPublications?: readonly PublicationReceipt[] }
  errno: number | null
  syscall: string | null
} {
  const primary = primaryStreamFailure(cause)
  const existing = primary instanceof PrivateStorageError || primary instanceof PrivateStreamError ? primary : undefined
  const errno = primary !== null && typeof primary === 'object' && 'errno' in primary
    && typeof primary.errno === 'number' && Number.isInteger(primary.errno) && primary.errno > 0 ? primary.errno : null
  const syscall = primary !== null && typeof primary === 'object' && 'syscall' in primary
    && typeof primary.syscall === 'string' ? primary.syscall : null
  return {
    code: existing?.code ?? 'native',
    details: {
      ...existing?.nativeStatus !== null && existing?.nativeStatus !== undefined ? { nativeStatus: existing.nativeStatus } : {},
      ...existing?.win32Code !== null && existing?.win32Code !== undefined ? { win32Code: existing.win32Code } : {},
      cleanupFailed: cleanupFailed || existing?.cleanupFailed === true,
      ...existing === undefined ? {} : { directoryPublications: existing.directoryPublications },
    },
    errno, syscall,
  }
}

/** New stream error family; existing byte-storage error classes and narrowing remain unchanged. */
export class PrivateStreamError extends Error {
  /** Primary storage classification; new streams do not alter byte-error narrowing. */
  readonly code: PrivateStorageErrorCode
  /** Primary NTSTATUS when supplied by the Windows provider; otherwise null. */
  readonly nativeStatus: number | null
  /** Primary Win32 error code when observed; otherwise null. */
  readonly win32Code: number | null
  /** Positive POSIX errno when observed; otherwise null. */
  readonly errno: number | null
  /** POSIX operation named by the actual failure; otherwise null. */
  readonly syscall: string | null
  /** Whether cleanup or release failed independently of publication. */
  readonly cleanupFailed: boolean
  /** Existing Windows directory-creation receipts carried by the primary failure. */
  readonly directoryPublications: readonly PublicationReceipt[]
  constructor(message: string, cause: unknown, cleanupFailed: boolean) {
    super(message, { cause })
    const native = streamFailureDetails(cause, cleanupFailed)
    this.name = 'PrivateStreamError'
    this.code = native.code
    this.nativeStatus = native.details.nativeStatus ?? null
    this.win32Code = native.details.win32Code ?? null
    this.errno = native.errno
    this.syscall = native.syscall
    this.cleanupFailed = native.details.cleanupFailed
    this.directoryPublications = Object.freeze([...(native.details.directoryPublications ?? [])])
  }
}
