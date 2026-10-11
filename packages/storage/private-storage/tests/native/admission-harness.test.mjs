/** Report-protocol checks; these assertions are never native conformance evidence. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { selectUnsupportedLocalVolumes } from './admission-volumes.mjs'

const matrix = fileURLToPath(new URL('admission-matrix.mjs', import.meta.url))
const oracle = fileURLToPath(new URL('windows-admission-oracle.c', import.meta.url))
const required = [
  'conditional-acl-admission', 'malformed-acl-os-rejection', 'malformed-descriptor-os-rejection',
  'junction-admission', 'unknown-reparse-admission', 'short-name-alias-admission',
  'case-sensitive-directory-admission', 'named-pipe-admission', 'device-namespace-admission',
  'unsupported-volume-admission', 'real-storage-failure',
]
for (const strict of [false, true]) {
  test(`non-Windows admission report retains every required row (strict=${strict})`, { skip: process.platform === 'win32' }, () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'admission-report-test-'))
    try {
      const output = join(sandbox, 'report.json')
      const child = spawnSync(process.execPath, [matrix, '--oracle', oracle, '--entry', matrix, '--output', output,
        '--require-complete', String(strict)], { encoding: 'utf8', timeout: 10_000 })
      assert.ifError(child.error)
      assert.equal(child.signal, null)
      assert.equal(child.status, strict ? 2 : 0, child.stderr)
      const report = JSON.parse(readFileSync(output, 'utf8'))
      assert.equal(report.nativeExecution, false)
      assert.equal(report.complete, false)
      assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: required.length + 1 })
      for (const name of required) assert.equal(report.results.find(row => row.name === name)?.status, 'blocked', name)
      assert.equal(report.results.find(row => row.name === 'native-prerequisite')?.status, 'blocked')
      assert.equal(report.scope.find(row => row.name === 'windows-arm64')?.status, 'out-of-scope')
      assert.equal(report.scope.find(row => row.name === 'private-plugin-composition')?.status, 'separate-requirement')
      assert.equal(report.scope.find(row => row.name === 'abrupt-power-loss')?.status, 'out-of-scope')
      assert.deepEqual(report.diagnostics, {})
    } finally { rmSync(sandbox, { recursive: true, force: true }) }
  })
}
test('missing artifact retains required blocked rows and records a failed prerequisite', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'admission-missing-test-'))
  try {
    const output = join(sandbox, 'report.json')
    const child = spawnSync(process.execPath, [matrix, '--oracle', oracle, '--entry', join(sandbox, 'missing.js'), '--output', output],
      { encoding: 'utf8', timeout: 10_000 })
    assert.ifError(child.error)
    assert.equal(child.signal, null)
    assert.equal(child.status, 1, child.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.nativeExecution, false)
    assert.deepEqual(report.summary, { passed: 0, failed: 1, blocked: required.length })
    for (const name of required) assert.equal(report.results.find(row => row.name === name)?.status, 'blocked', name)
    assert.equal(report.results.find(row => row.name === 'native-prerequisite')?.status, 'failed')
    assert.equal(report.scope.length, 3)
  } finally { rmSync(sandbox, { recursive: true, force: true }) }
})
test('argument omissions do not manufacture a report', () => {
  const child = spawnSync(process.execPath, [matrix], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.notEqual(child.status, 0)
  assert.equal(child.stdout, '')
  assert.match(child.stderr, /Missing --entry/)
})


test('unsupported local selection includes NTFS RAM disks without probing remote or unavailable media', () => {
  const ordinary = { root: 'C:', metadataAvailable: true, driveType: 3, filesystem: 'NTFS', remote: false, readOnly: false, persistentAcls: true }
  const ram = { ...ordinary, root: 'R:', driveType: 6 }
  const fat = { ...ordinary, root: 'F:', filesystem: 'FAT32' }
  const readonly = { ...ordinary, root: 'D:', driveType: 5, readOnly: true }
  const noAcl = { ...ordinary, root: 'N:', persistentAcls: false }
  const candidates = [ordinary, ram, fat, readonly, noAcl,
    { ...fat, driveType: 4, remote: true }, { ...ram, metadataAvailable: false }, { ...fat, driveType: 0 }]
  assert.deepEqual(selectUnsupportedLocalVolumes(candidates), [ram, fat, readonly, noAcl])
  assert.deepEqual(selectUnsupportedLocalVolumes([ordinary]), [])
})
