/** Synthetic coverage-inventory checks. Hypothetical reports here are not native execution evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { privateStorageNativeContract, evaluatePrivateStorageNative } from './private-storage-native-contract.mjs'
import { evaluateNativeMatrices } from './private-storage-composite.mjs'
import { cases, blockedCases } from '../packages/storage/private-storage/tests/native/directory-boundary-support.mjs'

const baseline = (name, allocations, views) => ({ name, status: 'passed', detail: { allocationAttempts: allocations, viewAttempts: views } })
const input = () => new Map([['boundary', { results: [baseline('native-read-allocation-baseline', 2, 1), baseline('native-publish-allocation-baseline', 1, 2)] }]])
function hypothetical() {
  const validated = input()
  const contract = privateStorageNativeContract(validated)
  const specifications = ['primary', 'admission', 'boundary', 'directory'].map(id => ({ id, entrySha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40),
    oracleSha256: 'c'.repeat(64), oracleSourceSha256: 'd'.repeat(64) }))
  const rows = new Map(specifications.map(spec => [spec.id, new Map()]))
  for (const required of contract.requirements) for (const reference of required.evidence) rows.get(reference.matrix).set(reference.row, { name: reference.row, status: 'passed' })
  for (const replacement of contract.replacements) rows.get(replacement.matrix).set(replacement.row, { name: replacement.row, status: 'blocked', reason: 'Explicit placeholder' })
  for (const record of validated.get('boundary').results) rows.get('boundary').set(record.name, record)
  const runs = specifications.map(spec => {
    const results = [...rows.get(spec.id).values()]
    const summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, results.filter(row => row.status === status).length]))
    return { matrix: spec.id, exitCode: summary.blocked ? 2 : 0, signal: null, timedOut: false,
      rawReport: JSON.stringify({ schemaVersion: 1, nativeExecution: true, platform: 'win32', architecture: 'x64',
        sourceSha: spec.sourceSha, entrySha256: spec.entrySha256, oracleSha256: spec.oracleSha256, oracleSourceSha256: spec.oracleSourceSha256, results, summary }) }
  })
  return { specifications, runs, ...contract }
}

test('enumerates every allocation/view ordinal and all still-unimplemented obligations', () => {
  const contract = privateStorageNativeContract(input())
  const ids = contract.requirements.map(item => item.id)
  assert.deepEqual(ids.filter(id => id.includes('native-one-shot-')), [
    'boundary/native-one-shot-alloc:1', 'boundary/native-one-shot-alloc:2', 'boundary/native-one-shot-view:1',
    'boundary/native-one-shot-publish-alloc:1', 'boundary/native-one-shot-publish-view:1', 'boundary/native-one-shot-publish-view:2',
  ])
  for (const id of [
    'primary/restricted-primary-process-token-rejection', 'boundary/prewrite-failure-cannot-delete-externally-published-staging', 'admission/cloud-reparse-admission',
    'admission/volume-mount-point-admission', 'admission/authorized-remote-volume-admission',
    'admission/real-storage-failure', 'boundary/native-capability-lifetime-live-worker-terminate',
    'boundary/native-capability-lifetime-live-worker-close', 'boundary/sdk-child-does-not-inherit-private-handles-with-positive-control',
    'boundary/leaf-substitution-preserves-opened-identity-read-held',
    'boundary/leaf-substitution-preserves-opened-identity-read-after-chunk',
    'boundary/retained-intermediate-parent-prevents-substitution-and-relocation',
    'boundary/post-read-canonical-acl-drift-rejected-without-returning-bytes',
    'boundary/readonly-target-rejects-publication-without-changing-original', 'boundary/executing-target-publication',
    'boundary/cooperating-publishers-serialize-through-fixed-native-lease', 'directory/cleanup-genuine-kernel-release-failure',
    'directory/cleanup-koffi-free-failure',
  ]) assert.ok(ids.includes(id), `Missing unresolved obligation: ${id}`)
  const fault = contract.replacements.find(item => item.row === 'remaining-native-fault-boundaries')
  for (const id of ids.filter(value => value.includes('native-one-shot-'))) assert.ok(fault.requirements.includes(id))
})

test('missing native baseline creates an explicit missing-inventory obligation rather than zero cases', () => {
  const contract = privateStorageNativeContract(new Map())
  for (const mode of ['read', 'publish']) {
    const id = `boundary/native-${mode}-allocation-fault-inventory-unestablished`
    assert.ok(contract.requirements.some(item => item.id === id))
    assert.ok(contract.replacements.find(item => item.row === 'remaining-native-fault-boundaries').requirements.includes(id))
  }
})

test('rejects malformed and unbounded baseline counts', () => {
  for (const count of [0, -1, 513, 1.5, '2', [2], null, undefined, Infinity]) {
    const reports = input()
    reports.get('boundary').results[0].detail.allocationAttempts = count
    assert.throws(() => privateStorageNativeContract(reports), /reviewed bounds/)
  }
  const reports = input(); reports.get('boundary').results[0].detail.viewAttempts = 1025
  assert.throws(() => privateStorageNativeContract(reports), /reviewed bounds/)
})

test('a hypothetical complete row inventory composes, but one omitted ordinal does not', () => {
  const fixture = hypothetical()
  assert.equal(evaluateNativeMatrices(fixture).complete, true)
  const run = fixture.runs.find(item => item.matrix === 'boundary')
  const report = JSON.parse(run.rawReport)
  report.results = report.results.filter(row => row.name !== 'native-one-shot-publish-view:2')
  report.summary.passed--
  run.rawReport = JSON.stringify(report)
  const result = evaluateNativeMatrices(fixture)
  assert.equal(result.complete, false)
  assert.equal(result.subcases.find(row => row.id === 'boundary/native-one-shot-publish-view:2').status, 'blocked')
  assert.ok(result.unresolved.some(row => row.name === 'remaining-native-fault-boundaries'))
})

test('nearby implemented tests cannot substitute for live-worker or remote/cloud obligations', () => {
  for (const [matrix, name] of [['boundary', 'native-capability-lifetime-live-worker-terminate'],
    ['admission', 'cloud-reparse-admission'], ['admission', 'authorized-remote-volume-admission']]) {
    const fixture = hypothetical(), run = fixture.runs.find(item => item.matrix === matrix)
    const report = JSON.parse(run.rawReport)
    report.results = report.results.filter(row => row.name !== name); report.summary.passed--
    run.rawReport = JSON.stringify(report)
    const result = evaluateNativeMatrices(fixture)
    assert.equal(result.complete, false)
    assert.equal(result.subcases.find(row => row.id === `${matrix}/${name}`).status, 'blocked')
  }
})


test('final evaluator derives ordinals from the exact raw report it evaluates, rejecting a stale count map', () => {
  const fixture = hypothetical()
  assert.equal(evaluatePrivateStorageNative(fixture).complete, true)
  const run = fixture.runs.find(item => item.matrix === 'boundary')
  const report = JSON.parse(run.rawReport)
  report.results.find(row => row.name === 'native-read-allocation-baseline').detail.allocationAttempts = 3
  run.rawReport = JSON.stringify(report)
  // fixture still contains the old count-2 contract; the final evaluator must not use it.
  const result = evaluatePrivateStorageNative(fixture)
  assert.equal(result.complete, false)
  assert.equal(result.subcases.find(row => row.id === 'boundary/native-one-shot-alloc:3').status, 'blocked')
  assert.ok(result.unresolved.some(row => row.name === 'remaining-native-fault-boundaries'))
})

test('a readonly/executing/publisher or ACL-drift gap remains mandatory', () => {
  for (const name of ['readonly-target-rejects-publication-without-changing-original', 'executing-target-publication',
    'cooperating-publishers-serialize-through-fixed-native-lease', 'post-read-canonical-acl-drift-rejected-without-returning-bytes']) {
    const fixture = hypothetical(), run = fixture.runs.find(item => item.matrix === 'boundary')
    const report = JSON.parse(run.rawReport)
    report.results = report.results.filter(row => row.name !== name); report.summary.passed--
    run.rawReport = JSON.stringify(report)
    const result = evaluatePrivateStorageNative(fixture)
    assert.equal(result.complete, false)
    assert.equal(result.subcases.find(row => row.id === `boundary/${name}`).status, 'blocked')
  }
})

test('directory placeholder requires the complete executable and blocked directory fixture inventory', () => {
  const contract = privateStorageNativeContract(input())
  const expected = [...cases, ...blockedCases.map(row => row.name)].map(name => `directory/${name}`)
  assert.deepEqual(contract.requirements.filter(row => row.id.startsWith('directory/')).map(row => row.id), expected)
  assert.deepEqual(contract.replacements.find(row => row.matrix === 'boundary').requirements, expected)
  for (const id of expected) assert.ok(contract.replacements.find(row => row.row === 'remaining-native-fault-boundaries').requirements.includes(id))
  for (const name of ['directory-enumeration-total-query-ceiling', ...blockedCases.map(row => row.name)]) {
    const fixture = hypothetical(), run = fixture.runs.find(item => item.matrix === 'directory')
    const report = JSON.parse(run.rawReport)
    report.results = report.results.filter(row => row.name !== name); report.summary.passed--
    run.rawReport = JSON.stringify(report)
    const observed = evaluatePrivateStorageNative(fixture)
    assert.equal(observed.complete, false)
    assert.ok(observed.unresolved.some(row => row.name === 'remaining-directory-query-and-cleanup-fault-boundaries'))
    assert.ok(observed.unresolved.some(row => row.name === 'remaining-native-fault-boundaries'))
  }
})


test('a failed-write staging publication gap cannot be substituted by successful retained publication', () => {
  const fixture = hypothetical(), run = fixture.runs.find(item => item.matrix === 'boundary')
  const report = JSON.parse(run.rawReport)
  report.results = report.results.filter(row => row.name !== 'prewrite-failure-cannot-delete-externally-published-staging')
  report.summary.passed--
  run.rawReport = JSON.stringify(report)
  const result = evaluatePrivateStorageNative(fixture)
  assert.equal(result.complete, false)
  assert.equal(result.subcases.find(row => row.id === 'boundary/prewrite-failure-cannot-delete-externally-published-staging').status, 'blocked')
  assert.ok(result.unresolved.some(row => row.name === 'deterministic-race-and-crash-boundary-matrix'))
})
