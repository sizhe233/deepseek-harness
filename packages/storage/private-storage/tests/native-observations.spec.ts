/** Reject incomplete binary facts before interpreting their fields. */
import { expect, it } from 'vitest'
import { decodeNativeIdentity, decodeNativeMetadata } from '../src/native-observations.ts'

it.each([[39, 24, 4], [40, 23, 4], [40, 24, 3]])('refuses metadata buffers of incomplete widths %j', (basic, standard, mode) => {
  expect(() => decodeNativeMetadata(Buffer.alloc(basic), Buffer.alloc(standard), Buffer.alloc(mode), true)).toThrow(/metadata length/u)
})
it('refuses incomplete full identities rather than silently truncating them', () => {
  expect(() => decodeNativeIdentity(Buffer.alloc(23))).toThrow(/identity length/u)
  expect(() => decodeNativeIdentity(Buffer.alloc(25))).toThrow(/identity length/u)
})
