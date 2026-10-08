/** Report-protocol tests only. These never count as Windows-native conformance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const harness = fileURLToPath(new URL('acceptance.mjs', import.meta.url))
const oracleSource = fileURLToPath(new URL('windows-oracle.c', import.meta.url))
const fixture = fileURLToPath(new URL('process-fixture.mjs', import.meta.url))

for (const strict of [false, true]) {
  test(`non-Windows report contains zero native passes (requireComplete=${strict})`, { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'private-storage-report-test-'))
    try {
      const output = join(root, 'report.json')
      const child = spawnSync(process.execPath, [harness, '--oracle', oracleSource, '--entry', fixture,
        '--output', output, '--require-complete', String(strict)], { encoding: 'utf8', timeout: 10_000 })
      assert.ifError(child.error)
      assert.equal(child.signal, null)
      assert.equal(child.status, strict ? 2 : 0, child.stderr)
      const report = JSON.parse(readFileSync(output, 'utf8'))
      assert.equal(report.nativeExecution, false)
      assert.equal(report.acceptance, 'partial')
      assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 1 })
      assert.equal(report.results.find(row => row.name === 'native-runtime')?.status, 'blocked')
      assert.equal(report.results.find(row => row.name === 'private-plugin-composition')?.status, 'separate-requirement')
      assert.equal(report.results.find(row => row.name === 'windows-arm64')?.status, 'out-of-scope')
      assert.equal(report.results.find(row => row.name === 'abrupt-power-loss')?.status, 'out-of-scope')
      assert.equal(report.results.filter(row => row.status === 'passed').length, 0)
      assert.equal(report.capabilities, undefined)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('missing native artifact arguments fail before claiming an acceptance result', () => {
  const child = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.notEqual(child.status, 0)
  assert.equal(child.stdout, '')
  assert.match(child.stderr, /Missing --oracle/)
})


test('non-Windows loader-negative reporting never claims a native loader pass', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'private-storage-loader-report-test-'))
  try {
    const script = fileURLToPath(new URL('loader-negative.mjs', import.meta.url))
    const output = join(root, 'loader.json')
    const child = spawnSync(process.execPath, [script, join(root, 'unused-consumer'), output], { encoding: 'utf8', timeout: 10_000 })
    assert.ifError(child.error)
    assert.equal(child.signal, null)
    assert.equal(child.status, 2, child.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.nativeExecution, false)
    assert.equal(report.complete, false)
    assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
