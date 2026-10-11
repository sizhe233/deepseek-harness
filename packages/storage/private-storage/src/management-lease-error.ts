/** Exact management-lease contention classification never treats cleanup failure as ownership evidence. */
import { PrivateStorageError } from './error.ts'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' }
/**
 * Recognize only an actual nonblocking lease-domain refusal with confirmed release of the probe's own resources.
 * @param error Error returned by this provider's management-lease acquisition.
 * @returns Whether contention was established; false includes every unrelated or uncertain failure.
 */
export function isManagementLeaseBusy(error: unknown): boolean {
  if (error instanceof PrivateStorageError) return error.code === 'busy' && !error.cleanupFailed && error.win32Code === 33
  if (!record(error) || error instanceof AggregateError || error.code !== 'EAGAIN' || error.syscall !== 'flock'
    || error.errno !== 11 && error.errno !== 35 || error.cleanupFailed === true || error.leaseHeld !== false) return false
  const creation = error.creation
  if (!record(creation) || creation.kind !== 'lease' || creation.bindingVerified !== true
    || !record(creation.release) || creation.release.attempted !== true || creation.release.completed !== true
    || creation.release.errno !== null || !record(creation.facts)) return false
  const facts = creation.facts
  return facts.kind === 'regular' && facts.nlink === '1' && facts.size === '0'
    && typeof facts.mode === 'number' && (facts.mode & 0o7777) === 0o600
}
