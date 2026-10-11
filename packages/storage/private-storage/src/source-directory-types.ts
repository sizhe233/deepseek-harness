/** Complete readonly source-name enumeration remains separate from per-file content admission. */
import type { StreamIdentity } from './stream-types.ts'

/** Current retained directory observations without a private-owner permission claim. */
export interface SourceDirectoryFacts {
  readonly identity: StreamIdentity
  readonly links: number
  readonly changeToken: string
  readonly observations: Readonly<Record<string, string | number | boolean>>
}
/** Each name is accounted for; a refused object grants no copy or reconstruction authority. */
export type SourceDirectoryEntry = {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly identity: StreamIdentity
} | {
  readonly name: string
  readonly kind: 'unadmitted'
  readonly identity: StreamIdentity | null
  readonly reason: string
  readonly nativeStatus: number | null
  readonly win32Code: number | null
}
/** Complete enumerated names at checked before/after observations, never an immutable filesystem snapshot. */
export interface SourceDirectoryListing {
  readonly before: SourceDirectoryFacts
  readonly after: SourceDirectoryFacts
  readonly entries: readonly SourceDirectoryEntry[]
  readonly complete: true
  readonly admission: 'complete' | 'unadmitted-entries'
}
