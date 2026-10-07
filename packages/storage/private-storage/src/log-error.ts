/** Public log failure without exposing the native resource implementation. */
import { PrivateStreamError } from './stream-error.ts'
import type { PrivateLogReceipt } from './log-types.ts'

/** Failure preserving confirmed appended bytes and independent flush/release observations. */
export class PrivateLogSinkError extends PrivateStreamError {
  /** Confirmed append, flush and release observations preserved at failure. */
  readonly receipt: PrivateLogReceipt
  constructor(receipt: PrivateLogReceipt, cause: unknown) {
    super(`private log failed during ${receipt.phase}`, cause, receipt.release === 'failed')
    this.name = 'PrivateLogSinkError'
    this.receipt = receipt
  }
}
