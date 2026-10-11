/** Synthetic SDK bytes test parsing only; real no-follow and lifetime checks remain native gates. */
import { expect, it } from 'vitest'
import { decodeWindowsLink } from '../src/windows-link-data.ts'
import { linkBytes } from './link-fixture.ts'
it('preserves literal targets, relative flags and non-BMP characters without resolving', () => {
  expect(decodeWindowsLink(linkBytes(), 32768)).toEqual({ literalTarget: '../package/bin.js', relative: true })
  const absolute = linkBytes('C:\\😀\\target'); absolute.writeUInt32LE(0, 16)
  expect(decodeWindowsLink(absolute, 32768)).toEqual({ literalTarget: 'C:\\😀\\target', relative: false })
})
it('rejects unsupported tags, flags, incomplete data and every out-of-bounds UTF-16 field', () => {
  const invalid = [Buffer.alloc(4), Buffer.alloc(16385), linkBytes(), linkBytes(), linkBytes(), linkBytes(),
    linkBytes(), linkBytes(), linkBytes()]
  invalid[2]!.writeUInt32LE(0xa0000003); invalid[3]!.writeUInt32LE(2, 16)
  invalid[4]!.writeUInt16LE(1, 4); invalid[5]!.writeUInt16LE(1, 6)
  invalid[6]!.writeUInt16LE(1, 8); invalid[7]!.writeUInt16LE(32766, 10); invalid[8]!.writeUInt16LE(32766, 12)
  for (const bytes of invalid) expect(() => decodeWindowsLink(bytes, 32768)).toThrow()
  for (const target of ['', '\0', '\ud800', '\udfff']) expect(() => decodeWindowsLink(linkBytes(target), 32768)).toThrow()
  for (const limit of [0, 32769, 1.5, NaN]) expect(() => decodeWindowsLink(linkBytes(), limit)).toThrow()
  expect(() => decodeWindowsLink(linkBytes(), 2)).toThrow()
})
