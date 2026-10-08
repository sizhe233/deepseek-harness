/** Preserve primary failures while consuming every owned Windows close attempt exactly once. */
import { PrivateStorageError } from './error.ts'
import { SourceObservationError, primaryStreamFailure, streamFailureDetails } from './stream-error.ts'
import type { Handle, NativeStorageBackend as NativeStorage } from './native.ts'

function cleanupFailure(primary: unknown, failures: readonly unknown[]): Error {
  const details = streamFailureDetails(primary, true)
  const original = primaryStreamFailure(primary)
  const error = new PrivateStorageError(details.code, 'owned resource release failed', { ...details.details,
    ...original instanceof PrivateStorageError && original.receipt !== undefined ? { receipt: original.receipt } : {},
  })
  error.cause = failures.length === 1 ? primary : new AggregateError(failures)
  return primary instanceof SourceObservationError ? new SourceObservationError(error) : error
}

/** @param primary Original operation error. @param cleanup Owned release, called once. */
export function failWithWindowsCleanup(primary: unknown, cleanup: () => void): never {
  try { cleanup() } catch (error) { throw cleanupFailure(primary, [primary, error]) }
  throw primary
}

/** @param actions Independent owned releases; all are attempted even if an earlier one fails. */
export function releaseWindowsResources(actions: readonly (() => void)[]): void {
  const failures: unknown[] = []
  for (const action of actions) { try { action() } catch (error) { failures.push(error) } }
  if (failures.length > 0) throw cleanupFailure(failures[0], failures)
}

/**
 * @param api Native owner.
 * @param handle One owned temporary handle.
 * @param inspect Read-only operation.
 * @returns Observed value after confirmed close.
 */
export function withWindowsInspection<T>(api: NativeStorage, handle: Handle, inspect: () => T): T {
  let value: T
  try { value = inspect() }
  catch (error) { failWithWindowsCleanup(error, () => { api.close(handle) }) }
  releaseWindowsResources([() => { api.close(handle) }])
  return value
}
