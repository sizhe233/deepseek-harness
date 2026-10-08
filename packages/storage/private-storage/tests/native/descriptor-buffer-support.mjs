/** Test-only absent-DACL mutation after a real native self-relative descriptor has returned. */
import assert from 'node:assert/strict'

export function absentDaclCopy(value) {
  assert.ok(value instanceof Uint8Array)
  const original = Buffer.from(value)
  assert.ok(original.length >= 20 && original.length <= 65536)
  assert.equal(original[0], 1)
  const control = original.readUInt16LE(2), dacl = original.readUInt32LE(16)
  assert.equal(control & 0x8004, 0x8004, 'A real present self-relative DACL must precede injection')
  assert.ok(dacl >= 20 && dacl + 8 <= original.length)
  const modified = Buffer.from(original)
  modified.writeUInt16LE(control & ~4, 2)
  modified.writeUInt32LE(0, 16)
  assert.deepEqual(Buffer.from(value), original, 'Native returned bytes must remain unchanged')
  return modified
}
