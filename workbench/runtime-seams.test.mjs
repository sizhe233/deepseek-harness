import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { applySeams } from './apply-runtime-seams.mjs'
const manifest = JSON.parse(readFileSync(new URL('runtime-seams.json', import.meta.url), 'utf8'))
for (const spec of manifest.files) {
  test('compiled production-compatible seams: ' + spec.name, () => {
    const source = readFileSync(new URL('../' + spec.path, import.meta.url), 'utf8')
    const patched = applySeams(spec.name, source)
    assert.equal(createHash('sha256').update(patched).digest('hex'), spec.afterSha256)
    assert.throws(() => applySeams(spec.name, patched), /source shape/)
    assert.throws(() => applySeams(spec.name, source + source), /source shape/)
  })
}
test('unknown bundle and source shape fail closed', () => {
  assert.throws(() => applySeams('unknown', ''), /unsupported bundle/)
  assert.throws(() => applySeams('dsh-agent-loop', 'changed upstream'), /source shape/)
})
