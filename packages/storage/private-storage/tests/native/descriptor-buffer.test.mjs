/** Portable mutation checks; actual packed-entry refusals remain a Windows fixture obligation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { absentDaclCopy } from './descriptor-buffer-support.mjs'

function descriptor() {
  const value = Buffer.alloc(64, 0x5a)
  value[0] = 1; value[1] = 0
  value.writeUInt16LE(0x9004, 2)
  value.writeUInt32LE(32, 16)
  return value
}

test('absent-DACL injection changes only the test copy control and DACL offset', () => {
  const original = descriptor(), before = Buffer.from(original), modified = absentDaclCopy(original)
  assert.deepEqual(original, before)
  assert.notEqual(modified, original)
  assert.equal(modified.readUInt16LE(2), 0x9000)
  assert.equal(modified.readUInt32LE(16), 0)
  modified.writeUInt16LE(before.readUInt16LE(2), 2)
  modified.writeUInt32LE(before.readUInt32LE(16), 16)
  assert.deepEqual(modified, before)
})

test('missing native descriptor evidence cannot become an injected acceptance sample', () => {
  for (const value of [Buffer.alloc(19), Buffer.alloc(65537), [], new Uint8Array(64)]) assert.throws(() => absentDaclCopy(value))
  for (const mutate of [value => { value[0] = 2 }, value => value.writeUInt16LE(0x9000, 2),
    value => value.writeUInt16LE(4, 2), value => value.writeUInt32LE(0, 16), value => value.writeUInt32LE(60, 16)]) {
    const value = descriptor(); mutate(value)
    assert.throws(() => absentDaclCopy(value))
  }
})
