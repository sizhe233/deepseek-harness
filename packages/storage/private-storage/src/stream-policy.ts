/** Fixed streaming bounds and complete platform identity comparisons. */
import { types } from 'node:util'
import type { PrivateFileWriterOptions, SourceFileReaderOptions, StreamIdentity } from './stream-types.ts'

/** Maximum owned input allocation per stream operation. */
export const MAX_STREAM_CHUNK_BYTES = 1024 * 1024
/** Independent stream ceiling; the existing byte API remains limited to 64 MiB. */
export const MAX_STREAM_FILE_BYTES = 1024 * 1024 * 1024

/**
 * Validate exact stream length and digest before native side effects.
 * @param options Frozen manifest fields checked before native creation or source opening.
 */
export function validateStreamExpectation(options: Pick<SourceFileReaderOptions, 'expectedBytes' | 'expectedSha256'>): void {
  if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0 || options.expectedBytes > MAX_STREAM_FILE_BYTES) {
    throw new RangeError('stream expectedBytes must be an integer from 0 through 1073741824')
  }
  if (typeof options.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(options.expectedSha256)) throw new TypeError('stream requires a canonical SHA-256')
}

/**
 * Validate correlation and fixed output metadata without making the identifier a path.
 * @param options Complete output expectations, captured before any resource is created.
 */
export function validateWriterOptions(options: PrivateFileWriterOptions): void {
  validateStreamExpectation(options)
  const replacementPolicy: unknown = options.replace
  if (replacementPolicy !== false || typeof options.executable !== 'boolean') throw new TypeError('stream requires fixed no-replace and executable policy')
  if (typeof options.operationId !== 'string' || options.operationId.length < 1 || options.operationId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(options.operationId)) throw new TypeError('stream operation identifier is invalid')
}

/**
 * Bound each native read request independently of the file ceiling.
 * @param value Requested read ceiling.
 */
export function validateStreamChunkSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STREAM_CHUNK_BYTES) throw new RangeError('stream chunk must be from 1 through 1048576 bytes')
}

/**
 * Validate before copying or writing, including cross-realm shared backing memory.
 * @param chunk Caller input.
 * @param remaining Remaining manifest length.
 */
export function validateStreamChunk(chunk: Uint8Array, remaining: number): void {
  if (!types.isUint8Array(chunk) || types.isSharedArrayBuffer(chunk.buffer)) throw new TypeError('stream requires an unshared Uint8Array')
  validateStreamChunkSize(chunk.byteLength)
  if (chunk.byteLength > remaining) throw new RangeError('stream input exceeds the manifest length')
}

/**
 * Compare the complete platform-qualified object identity.
 * @param left First live identity.
 * @param right Second live identity.
 * @returns Equality of every platform identity field.
 */
export function sameStreamIdentity(left: StreamIdentity, right: StreamIdentity): boolean {
  if (left.backend === 'posix') return right.backend === 'posix' && left.device === right.device && left.inode === right.inode
  return right.backend === 'windows-ntfs' && left.volumeSerial === right.volumeSerial && left.fileId === right.fileId
}

/**
 * Reject malformed external identity fields before opening a source.
 * @param value Complete canonical identity produced by the selected native backend.
 * @returns Narrows the external value only after complete platform field validation.
 */
export function validateStreamIdentity(value: unknown): asserts value is StreamIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('stream identity must be an object')
  if (!('backend' in value)) throw new TypeError('stream identity backend is missing')
  if (value.backend === 'posix') {
    for (const field of ['device' in value ? value.device : undefined, 'inode' in value ? value.inode : undefined]) {
      if (typeof field !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(field) || BigInt(field) > 18446744073709551615n) {
        throw new TypeError('POSIX stream identity requires complete unsigned decimal fields')
      }
    }
  } else if (value.backend === 'windows-ntfs') {
    if (!('volumeSerial' in value) || !('fileId' in value)) throw new TypeError('NTFS stream identity fields are missing')
    if (typeof value.volumeSerial !== 'string' || !/^[0-9a-f]{16}$/u.test(value.volumeSerial)
      || typeof value.fileId !== 'string' || !/^[0-9a-f]{32}$/u.test(value.fileId)) {
      throw new TypeError('NTFS stream identity requires canonical volume and file identifiers')
    }
  } else throw new TypeError('unsupported stream identity backend')
}
