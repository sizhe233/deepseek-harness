/** Pure checks for literal names, bounded data and exact protected descriptors. */

import { PrivateStorageError } from './error.ts'
import type { PrivateIdentity } from './types.ts'

/** Hard allocation ceiling independent of a consumer's smaller read limit. */
export const MAX_PRIVATE_BYTES = 64 * 1024 * 1024
/** Required allow mask, without generic rights that the OS might remap differently. */
export const PRIVATE_ACCESS_MASK = 0x001F01FF

/**
 * Accept one literal NTFS long-name component with exact stored casing.
 * @param name - Caller-provided component; no normalization is performed.
 */
export function validateName(name: string): void {
  if (name.length === 0 || name.length > 255 || name === '.' || name === '..'
    || /[\u0000-\u001f\u007f-\u009f\\/:*?"<>|]/u.test(name) || /[. ]$/u.test(name)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/iu.test(name)) {
    throw new PrivateStorageError('name', 'literal component required')
  }
  for (let i = 0; i < name.length; i++) {
    const value = name.charCodeAt(i)
    if (value >= 0xD800 && value <= 0xDBFF) {
      const next = name.charCodeAt(++i)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new PrivateStorageError('name', 'ill-formed UTF-16')
    } else if (value >= 0xDC00 && value <= 0xDFFF) throw new PrivateStorageError('name', 'ill-formed UTF-16')
  }
}

/**
 * Split a literal local drive path; UNC, arbitrary device namespaces and aliases are excluded.
 * @param path - Absolute DOS drive path with backslash separators.
 * @returns Trusted volume bootstrap name and individually validated components.
 */
export function splitRootPath(path: string): { volume: string; components: string[] } {
  if (!/^[A-Za-z]:\\/u.test(path) || path.includes('/') || path.length > 32760) {
    throw new PrivateStorageError('name', 'absolute local drive path required')
  }
  const components = path.slice(3).split('\\')
  if (components.length === 1 && components[0] === '') throw new PrivateStorageError('name', 'volume root is not private')
  for (const component of components) validateName(component)
  return { volume: `\\??\\${path[0]}:\\`, components }
}

/**
 * Bound allocation before copying or reading.
 * @param bytes - Requested byte ceiling.
 */
export function validateLimit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PRIVATE_BYTES) {
    throw new PrivateStorageError('limit', 'byte limit')
  }
}

/**
 * Compare every byte of the complete NTFS identity.
 * @param left - First live-domain identity.
 * @param right - Second live-domain identity.
 * @returns Whether both identities agree completely.
 */
export function sameIdentity(left: PrivateIdentity, right: PrivateIdentity): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId
}

function boundedSid(bytes: Buffer, offset: number, end: number): Buffer {
  if (offset < 8 || offset + 8 > end || bytes[offset] !== 1) throw new PrivateStorageError('privacy', 'SID header')
  const count = bytes.readUInt8(offset + 1)
  const length = 8 + 4 * count
  if (count > 15 || offset + length > end) throw new PrivateStorageError('privacy', 'SID bounds')
  return bytes.subarray(offset, offset + length)
}

/**
 * Validate a bounded SID copied from TokenUser.
 * @param sid - Complete copied SID bytes.
 */
export function validateSid(sid: Buffer): void {
  const padded = Buffer.concat([Buffer.alloc(8), sid])
  if (boundedSid(padded, 8, padded.length).length !== sid.length) throw new PrivateStorageError('privacy', 'SID length')
}

/**
 * Build the self-relative explicit owner/protected single-ACE descriptor supplied at creation.
 * @param sid - Validated current TokenUser SID bytes.
 * @param directory - Whether the allow ACE is inheritable by files and directories.
 * @returns Complete self-relative security descriptor.
 */
export function privateDescriptor(sid: Buffer, directory: boolean): Buffer {
  validateSid(sid)
  const dacl = 20 + sid.length
  const bytes = Buffer.alloc(dacl + 16 + sid.length)
  bytes[0] = 1
  bytes.writeUInt16LE(0x9004, 2)
  bytes.writeUInt32LE(20, 4)
  bytes.writeUInt32LE(dacl, 16)
  sid.copy(bytes, 20)
  bytes[dacl] = 2
  bytes.writeUInt16LE(16 + sid.length, dacl + 2)
  bytes.writeUInt16LE(1, dacl + 4)
  bytes[dacl + 9] = directory ? 3 : 0
  bytes.writeUInt16LE(8 + sid.length, dacl + 10)
  bytes.writeUInt32LE(PRIVATE_ACCESS_MASK, dacl + 12)
  sid.copy(bytes, dacl + 16)
  return bytes
}

/**
 * Reject incomplete, inherited, broadened or malformed descriptors without repairing them.
 * @param bytes - Complete bounded self-relative descriptor copied from GetSecurityInfo.
 * @param sid - TokenUser SID required as owner and sole beneficiary.
 * @param directory - Required exact inheritance flags.
 */
export function verifyPrivateDescriptor(bytes: Buffer, sid: Buffer, directory: boolean): void {
  if (bytes.length < 20 || bytes.length > 65536 || bytes[0] !== 1 || bytes[1] !== 0) {
    throw new PrivateStorageError('privacy', 'descriptor header')
  }
  const control = bytes.readUInt16LE(2)
  if ((control & 0x9004) !== 0x9004 || (control & 0x0109) !== 0) {
    throw new PrivateStorageError('privacy', 'protected explicit owner and DACL required')
  }
  const owner = bytes.readUInt32LE(4)
  const acl = bytes.readUInt32LE(16)
  if (owner < 20 || acl < 20 || acl + 8 > bytes.length) throw new PrivateStorageError('privacy', 'descriptor offsets')
  const ownerSid = boundedSid(bytes, owner, bytes.length)
  if (!ownerSid.equals(sid)) throw new PrivateStorageError('privacy', 'owner differs from TokenUser')
  for (const offset of [bytes.readUInt32LE(8), bytes.readUInt32LE(12)]) {
    if (offset !== 0) throw new PrivateStorageError('privacy', 'unexpected descriptor component')
  }
  const size = bytes.readUInt16LE(acl + 2)
  const end = acl + size
  if (bytes[acl] !== 2 || bytes[acl + 1] !== 0 || bytes.readUInt16LE(acl + 6) !== 0
    || bytes.readUInt16LE(acl + 4) !== 1 || end > bytes.length || size < 16
    || !(owner + ownerSid.length <= acl || end <= owner)) {
    throw new PrivateStorageError('privacy', 'ACL bounds and exact ACE count')
  }
  const ace = acl + 8
  const aceSize = bytes.readUInt16LE(ace + 2)
  if (bytes[ace] !== 0 || bytes[ace + 1] !== (directory ? 3 : 0)
    || aceSize !== size - 8 || aceSize < 16 || bytes.readUInt32LE(ace + 4) !== PRIVATE_ACCESS_MASK) {
    throw new PrivateStorageError('privacy', 'exact allow ACE required')
  }
  const beneficiary = boundedSid(bytes, ace + 8, end)
  if (beneficiary.length !== aceSize - 8 || !beneficiary.equals(sid)) {
    throw new PrivateStorageError('privacy', 'exact TokenUser beneficiary required')
  }
}
