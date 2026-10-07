/** Literal no-follow link observations grant no authority to resolve or copy their targets. */
import type { StreamIdentity } from './stream-types.ts'

/** Same retained link identity and complete provider observations. */
export interface SourceLinkFacts {
  readonly identity: StreamIdentity
  readonly links: number
  readonly changeToken: string
  readonly observations: Readonly<Record<string, string | number | boolean>>
}
/** A recognized symbolic link only; unsupported reparse kinds refuse. */
export interface SourceLinkObservation {
  readonly kind: 'symbolic-link'
  readonly literalTarget: string
  readonly relative: boolean
  readonly before: SourceLinkFacts
  readonly after: SourceLinkFacts
}
