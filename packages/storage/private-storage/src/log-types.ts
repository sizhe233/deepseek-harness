/** Append-only private log observations, separate from immutable file publication. */
import type { StreamIdentity } from './stream-types.ts'

/** Same-handle observations; accepted bytes exclude an append whose acknowledgement failed. */
export interface PrivateLogReceipt {
  readonly name: string
  readonly identity: StreamIdentity | null
  readonly parentIdentity: StreamIdentity
  readonly initialSizeBytes: string | null
  readonly acceptedBytes: string
  readonly observedSizeBytes: string | null
  readonly lastAppend: Readonly<{
    requestedBytes: number
    confirmedBytes: number | null
    outcome: 'not-attempted' | 'appended' | 'partial' | 'indeterminate'
  }>
  readonly synchronization: 'not-attempted' | 'succeeded' | 'failed'
  readonly durability: 'synced' | 'unconfirmed'
  readonly release: 'retained' | 'released' | 'failed'
  readonly phase: 'open' | 'append' | 'flush' | 'close'
  readonly outcome: 'open' | 'failed' | 'closed'
}
/** Provider-owned synchronous append sink; closing does not delete, truncate or relocate its file. */
export interface PrivateLogSink {
  readonly receipt: PrivateLogReceipt
  /** @param chunk Nonempty owned input within the declared ceiling; no seek or caller offset exists. */
  append(chunk: Uint8Array): void
  /** @returns A same-handle flush receipt; success retains the live resource. */
  flush(): PrivateLogReceipt
  /** @returns The final flush/release receipt; an error preserves every established observation. */
  close(): PrivateLogReceipt
}
