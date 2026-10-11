/** Strict SDK symbolic-link reparse parsing; this decoder never resolves a target. */
import { PrivateStorageError } from './error.ts'

/**
 * Decode the substitute target the kernel would use, preserving literal spelling.
 * @param bytes Complete FSCTL_GET_REPARSE_POINT result.
 * @param maximum Maximum UTF-8 bytes in the returned target.
 * @returns Literal symbolic-link target and relative flag.
 */
export function decodeWindowsLink(bytes: Buffer, maximum: number): { literalTarget: string; relative: boolean } {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32768) throw new RangeError('link target bound must be 1 through 32768')
  if (bytes.length < 20 || bytes.length > 16384 || bytes.readUInt32LE() !== 0xa000000c
    || bytes.readUInt16LE(4) + 8 !== bytes.length || bytes.readUInt16LE(6) !== 0) {
    throw new PrivateStorageError('unsupported', 'complete symbolic-link reparse data required')
  }
  const flags = bytes.readUInt32LE(16)
  if (flags !== 0 && flags !== 1) throw new PrivateStorageError('unsupported', 'unknown symbolic-link flags')
  const text = (offset: number, length: number): string => {
    if (offset % 2 || length % 2 || offset > bytes.length - 20 || length > bytes.length - 20 - offset) {
      throw new PrivateStorageError('native', 'symbolic-link target bounds')
    }
    const value = bytes.toString('utf16le', 20 + offset, 20 + offset + length)
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index)
      if (unit === 0 || unit >= 0xdc00 && unit <= 0xdfff) throw new PrivateStorageError('name', 'invalid symbolic-link target text')
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++index)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PrivateStorageError('name', 'invalid symbolic-link target text')
      }
    }
    return value
  }
  const literalTarget = text(bytes.readUInt16LE(8), bytes.readUInt16LE(10))
  text(bytes.readUInt16LE(12), bytes.readUInt16LE(14))
  if (literalTarget.length === 0 || Buffer.byteLength(literalTarget) > maximum) throw new PrivateStorageError('limit', 'symbolic-link target length')
  return Object.freeze({ literalTarget, relative: flags === 1 })
}
