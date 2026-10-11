/** Bounded readonly user-document import; installed artifact readers keep their independently expected digest. */
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts } from './stream-types.ts'
import { sameStreamIdentity, validateStreamIdentity } from './stream-policy.ts'
import { readBoundedPrivateRecord, type PrivateRecordReadResult } from './private-record-reader.ts'
import { SourceObservationError } from './stream-error.ts'

/** Exact provisional source observations and an independent small-document ceiling. */
export interface SourceDocumentReadOptions {
  readonly maxBytes: number
  readonly expectedSource: SourceFileFacts
}
/** Readonly document bytes with a computed digest; this is not an artifact-manifest admission. */
export type SourceDocumentReadResult = PrivateRecordReadResult
/**
 * Read an observed original/draft document through one native readonly resource without a prior content digest.
 * @param options Complete previously observed source facts and at most 64 MiB.
 * @param open Source-policy factory; it never grants private destination or control-record authority.
 * @returns Detached bytes and computed digest after exact EOF, unchanged observations and confirmed release.
 */
export function readBoundedSourceDocument(options: SourceDocumentReadOptions, open: () => SourceReaderResource): SourceDocumentReadResult {
  validateStreamIdentity(options.expectedSource.identity)
  const expected = Object.freeze({ ...options.expectedSource, identity: Object.freeze({ ...options.expectedSource.identity }),
    observations: Object.freeze({ ...options.expectedSource.observations }) })
  return readBoundedPrivateRecord(options.maxBytes, () => {
    const resource = open()
    return {
      inspect: () => {
        const actual = resource.inspect()
        if (!sameStreamIdentity(actual.identity, expected.identity) || actual.sizeBytes !== expected.sizeBytes
          || actual.links !== expected.links || actual.changeToken !== expected.changeToken
          || Object.keys(actual.observations).length !== Object.keys(expected.observations).length
          || Object.entries(expected.observations).some(([key, value]) =>
            !Object.hasOwn(actual.observations, key) || actual.observations[key] !== value)) {
          throw new SourceObservationError(new Error('source document differs from its observed selection'))
        }
        return actual
      },
      read: maximum => resource.read(maximum), close: () => { resource.close() },
    }
  })
}
