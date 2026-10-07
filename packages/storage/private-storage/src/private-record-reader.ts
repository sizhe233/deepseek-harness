/** Internal bounded observed-byte loop; callers separately enforce private-record or readonly-document policy. */
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { SourceReaderResource } from './stream-native.ts'
import type { SourceFileFacts } from './stream-types.ts'
import { sameStreamIdentity, MAX_STREAM_CHUNK_BYTES } from './stream-policy.ts'

/** Same-handle private record data; the digest is observed, not an artifact identity supplied in advance. */
export interface PrivateRecordReadResult {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly source: SourceFileFacts
}

/**
 * Read one policy-admitted small record without relaxing mandatory artifact-manifest digests.
 * @param maxBytes Consumer ceiling at most 64 MiB, validated before opening a resource.
 * @param open Same-handle native factory with policy already admitted by its owning endpoint.
 * Public private-record reads require private admission; readonly document imports require distinct source admission.
 * @returns Detached bytes and computed SHA-256 after exact EOF and unchanged full observations.
 */
export function readBoundedPrivateRecord(maxBytes: number, open: () => SourceReaderResource): PrivateRecordReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new RangeError('private record limit must be from 0 through 67108864')
  const resource = open()
  let result!: PrivateRecordReadResult
  const failures: unknown[] = []
  try {
    const initial = resource.inspect()
    if (initial.sizeBytes > maxBytes || !Number.isSafeInteger(initial.sizeBytes) || initial.sizeBytes < 0) {
      throw new RangeError('private record exceeds byte limit')
    }
    const source = Object.freeze({ ...initial, identity: Object.freeze({ ...initial.identity }),
      observations: Object.freeze({ ...initial.observations }) })
    const check = (): void => {
      const next = resource.inspect()
      if (!sameStreamIdentity(next.identity, source.identity) || next.sizeBytes !== source.sizeBytes
        || next.links !== source.links || next.changeToken !== source.changeToken) throw new Error('private record changed during read')
    }
    const bytes = Buffer.alloc(source.sizeBytes)
    const hash = createHash('sha256')
    let offset = 0
    while (true) {
      check()
      const bound = Math.min(MAX_STREAM_CHUNK_BYTES, source.sizeBytes - offset + 1)
      const chunk = resource.read(bound)
      if (!types.isUint8Array(chunk) || types.isSharedArrayBuffer(chunk.buffer) || chunk.byteLength > bound) throw new Error('native record reader violated its byte bound')
      check()
      if (chunk.byteLength === 0) break
      if (chunk.byteLength > source.sizeBytes - offset) throw new Error('private record exceeds observed length')
      bytes.set(chunk, offset)
      hash.update(chunk)
      offset += chunk.byteLength
    }
    if (offset !== source.sizeBytes) throw new Error('private record ended before observed length')
    result = Object.freeze({ bytes, sha256: hash.digest('hex'), source })
  } catch (error) { failures.push(error) }
  try { resource.close() } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, 'private record read failed')
  return result
}
