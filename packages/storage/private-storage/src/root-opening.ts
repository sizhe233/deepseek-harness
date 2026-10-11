/** Root enrollment observations preserve namespace publication separately from later file durability. */
import { PrivateStreamError } from './stream-error.ts'
import type { StreamIdentity } from './stream-types.ts'
import type { SourceDirectoryFacts } from './source-directory-types.ts'
import type { PrivateStreamDirectory, PrivateStreamDirectoryPublication } from './stream-directory-types.ts'

/** Facts from this root-opening operation; preexisting namespace durability is not manufactured. */
export interface PrivateStreamRootReceipt {
  readonly kind: 'existing-root' | 'created' | 'indeterminate'
  readonly name: string
  readonly identity: StreamIdentity | null
  readonly parentIdentity: StreamIdentity | null
  readonly parentBefore: SourceDirectoryFacts | null
  readonly parentAfter: SourceDirectoryFacts | null
  readonly bindingVerification: 'unverified' | 'verified'
  readonly privacyVerification: 'unverified' | 'verified'
  readonly durability: 'not-attempted' | 'synced' | 'unconfirmed'
  readonly publications: readonly PrivateStreamDirectoryPublication[]
  readonly release: 'retained' | 'released' | 'failed'
}
/** Independently retained private root and the actual opening/publication observations. */
export interface PrivateStreamRootOpening {
  readonly directory: PrivateStreamDirectory
  readonly receipt: PrivateStreamRootReceipt
}
/** A failed opening can leave a published root; no cleanup of an uncertain pathname is authorized. */
export class PrivateStreamRootError extends PrivateStreamError {
  /** Known root publication, binding, durability and release facts retained after opening fails. */
  readonly receipt: PrivateStreamRootReceipt
  constructor(receipt: PrivateStreamRootReceipt, cause: unknown) {
    super('private root opening failed', cause, receipt.release === 'failed')
    this.name = 'PrivateStreamRootError'
    this.receipt = Object.freeze({ ...receipt, publications: Object.freeze([...receipt.publications]) })
  }
}
