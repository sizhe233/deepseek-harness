/** Shared decoding of complete Windows native observations; no handle acquisition occurs here. */
import { PrivateStorageError } from './error.ts'
import type { NativeFacts } from './native.ts'
import type { PrivateIdentity } from './types.ts'

/**
 * Validate complete same-object information before attaching an independently queried full identity.
 * @param basic FILE_BASIC_INFORMATION bytes.
 * @param standard FILE_STANDARD_INFORMATION bytes.
 * @param mode FILE_MODE_INFORMATION bytes.
 * @param singleLink Whether private live-file admission requires exactly one link.
 * @param retired Whether this is only a retained replacement observation, never live-file admission.
 * @returns Bounded non-security metadata.
 */
export function decodeNativeMetadata(basic: Buffer, standard: Buffer, mode: Buffer, singleLink: boolean, retired = false):
Omit<NativeFacts, 'identity' | 'ownerSid' | 'daclProtected'> {
  if (basic.length !== 40 || standard.length !== 24 || mode.length !== 4) throw new PrivateStorageError('native', 'native metadata length')
  const attributes = basic.readUInt32LE(32)
  if ((attributes & (0x400 | 0x1000 | 0x40000 | 0x400000)) !== 0) throw new PrivateStorageError('unsupported', 'reparse or recalled object')
  const directory = standard[21] === 1, links = standard.readUInt32LE(16)
  if (standard.readUInt8(20) > 1 || (!retired && standard[20] !== 0) || (standard[21] !== 0 && !directory)
    || (!directory && ((!retired && links < 1) || (singleLink && links !== 1)))) throw new PrivateStorageError('identity', 'single-link live file required')
  const sizeBytes = standard.readBigInt64LE(8)
  if (sizeBytes < 0n) throw new PrivateStorageError('native', 'negative file size')
  return Object.freeze({ complete: true, kind: directory ? 'directory' : 'file', links, sizeBytes, attributes,
    writeThrough: (mode.readUInt32LE() & 2) !== 0, lastWriteTime: basic.readBigInt64LE(16), changeTime: basic.readBigInt64LE(24) })
}
/** @param bytes Complete SDK FILE_ID_INFO. @returns Lossless full volume and file identity. */
export function decodeNativeIdentity(bytes: Buffer): PrivateIdentity {
  if (bytes.length !== 24) throw new PrivateStorageError('native', 'native file identity length')
  const fileId = bytes.subarray(8, 24).toString('hex')
  if (/^0+$/u.test(fileId)) throw new PrivateStorageError('unsupported', 'usable full file identity required')
  return Object.freeze({ volumeSerial: bytes.readBigUInt64LE().toString(16).padStart(16, '0'), fileId })
}
