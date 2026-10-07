/** Portable report/protocol negatives. These tests do not execute or simulate the Windows backend. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, fixtureEnvironment, startChild, summary } from './boundary-support.mjs'
import { blockedCases, cases, injectDirectoryRecord, oracleBinding, queryBudget, sourceBinding, sourceFiles, validateReport, validateResult } from './directory-boundary-support.mjs'

const binding = { entrySha256: 'a'.repeat(64), nativeBinarySha256: 'b'.repeat(64) }
const fixtureHash = 'c'.repeat(64)
function workerResult(scenario = cases[0]) {
  return { event: 'result', scenario, ...binding, fixtureSourceSha256: fixtureHash, realNativeCalls: true,
    outcome: { ok: true, audit: { complete: true, entries: 2 } }, trace: Array.from({ length: 2 }, () => ({ name: 'NtQueryDirectoryFile', forwarded: true, actualReturn: 0 })),
    faultInjected: false, injections: 0, releaseErrors: [], protocolViolations: [], remainingStorageHandles: 0,
    remainingSecurityDescriptors: 0, remainingBackingAllocations: 0, inheritableStorageHandles: 0, queryCalls: 2,
    nativeCalls: 12, realStorageFailureClaimed: false, actualPendingRequest: false }
}
function reportFixture(native = false) {
  const fixtureSources = Object.fromEntries(sourceFiles.map(name => [name, 'd'.repeat(64)]))
  const value = { schemaVersion: 1, evidence: 'packed-native-directory-cleanup-matrix',
    nativeExecution: native, platform: native ? 'win32' : 'linux', architecture: 'x64',
    sourceSha: 'e'.repeat(40), ...binding, oracleSha256: 'f'.repeat(64), oracleSourceSha256: 'd'.repeat(64),
    fixtureSources, fixtureSourceSha256: digest(JSON.stringify(fixtureSources)),
    results: [...cases, ...blockedCases.map(row => row.name)].map(name => ({ name, status: 'blocked', reason: 'Portable report fixture only' })) }
  value.summary = summary(value.results); value.acceptance = 'partial'
  return value
}
function recount(report) {
  report.summary = summary(report.results)
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  return report
}

test('the finite native inventory keeps unsupported cleanup obligations explicit', () => {
  assert.equal(new Set([...cases, ...blockedCases.map(row => row.name)]).size, 26)
  assert.equal(cases.length, 24)
  assert.equal(queryBudget, 64)
  const report = reportFixture()
  assert.equal(validateReport(report), 2)
  report.results[0] = { name: cases[0], status: 'failed', reason: 'Observed operation failed' }
  assert.equal(validateReport(recount(report)), 1)
})

test('the portable report rejects an invented native pass, unknown statuses, missing and duplicate rows', () => {
  for (const mutate of [
    r => { r.results[0].status = 'passed'; recount(r) },
    r => { r.results[0].status = 'skipped'; recount(r) },
    r => { r.results.pop(); recount(r) },
    r => { r.results[1].name = r.results[0].name },
    r => { r.results.reverse() },
    r => { r.summary.blocked = 0 },
    r => { r.acceptance = 'complete' },
    r => { r.results[0].reason = '' },
  ]) {
    const report = reportFixture(); mutate(report)
    assert.throws(() => validateReport(report))
  }
})

test('native report acceptance requires its exact source, binary and reviewed fixture identities', () => {
  const original = reportFixture(true)
  assert.equal(validateReport(original, { sourceSha: original.sourceSha, ...binding }), 2)
  for (const name of ['sourceSha', 'entrySha256', 'oracleSha256', 'oracleSourceSha256', 'nativeBinarySha256', 'fixtureSourceSha256']) {
    const report = structuredClone(original); report[name] = null
    assert.throws(() => validateReport(report))
  }
  for (const mutate of [
    r => { r.platform = 'darwin' },
    r => { r.architecture = 'arm64' },
    r => { r.fixtureSources[sourceFiles[0]] = '0'.repeat(64) },
    r => { delete r.fixtureSources['boundary-support.mjs'] },
  ]) {
    const report = structuredClone(original); mutate(report)
    assert.throws(() => validateReport(report))
  }
  assert.throws(() => validateReport(original, { entrySha256: '0'.repeat(64) }), /binding differs/u)
})

test('native passed rows require a matching child result and cannot erase blocked cleanup cases', () => {
  const original = reportFixture(true)
  const result = workerResult(); result.fixtureSourceSha256 = original.fixtureSourceSha256
  const facts = { identity: { volumeSerial: '1'.repeat(16), fileId: '2'.repeat(32) },
    descriptorHex: '00'.repeat(20), ownerSid: '00'.repeat(8), daclProtected: true, reparseTag: 0, links: 1, bytesSha256: '3'.repeat(64) }
  Object.assign(result, { originalIdentitiesAndBytesRetained: true, originalPrivateDescriptorsRetained: true,
    leaseReacquiredAfterChildExit: true, rootRenamedAfterChildExit: true, releasedResourcesAreNeverRetried: true,
    sdkBefore: { root: facts, record: facts, lease: facts }, sdkAfter: { root: facts, record: facts, lease: facts } })
  original.results[0] = { name: cases[0], status: 'passed', detail: result }
  assert.equal(validateReport(recount(original)), 2)
  for (const mutate of [
    r => { delete r.results[0].detail },
    r => { r.results[0].detail.scenario = cases[1] },
    r => { r.results[0].detail.realStorageFailureClaimed = true },
    r => { r.results[0].detail.actualPendingRequest = true },
    r => { delete r.results[0].detail.outcome.audit },
    r => { delete r.results[0].detail.sdkBefore },
    r => { r.results[0].detail.sdkAfter = {} },
    r => { r.results[0].detail.leaseReacquiredAfterChildExit = false },
    r => { r.results[0].detail.entrySha256 = '0'.repeat(64) },
    r => { r.results.at(-1).status = 'passed'; r.results.at(-1).detail = result; recount(r) },
  ]) {
    const report = structuredClone(original); mutate(report)
    assert.throws(() => validateReport(report))
  }
})

test('child validation rejects leaked resources, false call labels, stale identity and exceeded budgets', () => {
  const original = workerResult()
  validateResult(original, cases[0], binding, fixtureHash)
  for (const mutate of [
    r => { r.event = 'ready' },
    r => { r.scenario = cases[1] },
    r => { r.entrySha256 = '0'.repeat(64) },
    r => { r.nativeBinarySha256 = '0'.repeat(64) },
    r => { r.fixtureSourceSha256 = '0'.repeat(64) },
    r => { r.realNativeCalls = false },
    r => { r.remainingStorageHandles = 1 },
    r => { r.remainingSecurityDescriptors = 1 },
    r => { r.remainingBackingAllocations = 1 },
    r => { r.inheritableStorageHandles = 1 },
    r => { r.queryCalls = queryBudget + 1 },
    r => { r.queryCalls = -1 },
    r => { r.nativeCalls = 0 },
    r => { r.releaseErrors = ['failure'] },
    r => { r.protocolViolations = ['Suppressed duplicate free'] },
    r => { r.trace = [] },
    r => { delete r.trace[0].actualReturn },
    r => { r.trace[0].forwarded = false },
    r => { r.injections = 1 },
    r => { r.faultInjected = true },
    r => { r.trace = [{ forwarded: true, injected: true, injectionOrigin: 'actual-kernel-failure' }] },
    r => { r.trace = [{ forwarded: 'yes' }] },
    r => { r.trace = Array(3001).fill({ forwarded: true }) },
  ]) {
    const result = structuredClone(original); mutate(result)
    assert.throws(() => validateResult(result, cases[0], binding, fixtureHash))
  }
})

test('a cleanup row cannot pass without its actual release, injected failure and failure receipt', () => {
  const scenario = 'cleanup-real-staging-close-return-failure'
  const original = { ...workerResult(scenario), queryCalls: 0, faultInjected: true, injections: 2, writeFailureInjected: true,
    outcome: { ok: false, code: 'native', receipt: { publication: 'not-published', durability: 'unconfirmed', phase: 'write', cleanup: 'failed' } },
    trace: [
      { name: 'WriteFile', forwarded: false, injected: true, injectionOrigin: 'test-owned-return', visibleReturn: 0 },
      { name: 'CloseHandle', role: 'staging', forwarded: true, actualReturn: 1, injected: true,
        injectionOrigin: 'test-owned-return', visibleReturn: 0, cleanupFault: true, actuallyReleased: true },
    ] }
  validateResult(original, scenario, binding, fixtureHash)
  for (const mutate of [
    r => { r.outcome = { ok: true } },
    r => { delete r.outcome.receipt },
    r => { r.outcome.receipt.cleanup = 'delete-pending' },
    r => { r.outcome.receipt.publication = 'published' },
    r => { r.writeFailureInjected = false },
    r => { r.trace[0].name = 'ReadFile' },
    r => { r.trace[0].forwarded = true; r.trace[0].actualReturn = 0 },
    r => { r.trace[1].actuallyReleased = false },
    r => { r.trace[1].name = 'LocalFree' },
    r => { r.trace[1].role = 'token' },
    r => { r.trace[1].actualReturn = 0 },
    r => { r.trace[1].visibleReturn = 1 },
    r => { delete r.trace[1].cleanupFault },
    r => { r.protocolViolations.push('Suppressed duplicate allocation free') },
  ]) {
    const value = structuredClone(original); mutate(value)
    assert.throws(() => validateResult(value, scenario, binding, fixtureHash))
  }
})

test('uncertain directory completion requires exactly two quarantined allocations', () => {
  for (const suffix of ['pending-unsettled', 'pending-wait-error']) {
    const scenario = `directory-enumeration-${suffix}`
    const result = workerResult(scenario); result.remainingBackingAllocations = 2
    result.outcome = { ok: false, code: 'unavailable' }
    result.trace[0].injected = true; result.trace[0].injectionOrigin = 'test-owned-return'
    result.injections = 1; result.faultInjected = true
    result.poisonProbe = { rejected: true, code: 'unavailable', nativeCalls: 0, allocationChange: 0 }
    validateResult(result, scenario, binding, fixtureHash)
    for (const count of [0, 1, 3]) {
      result.remainingBackingAllocations = count
      assert.throws(() => validateResult(result, scenario, binding, fixtureHash))
    }
  }
})

test('malformed record fixtures write only bounded data while retaining their explicit invalid fields', () => {
  const fields = {
    'truncated-header': [11n, 0, 20], 'overlong-buffer': [65537n, 0, 20], 'odd-name-length': [32n, 0, 1],
    'zero-name-length': [32n, 0, 0], 'name-overruns-page': [32n, 0, 22],
    'next-record-truncated': [32n, 32, 20], 'next-offset-overlap': [32n, 12, 20],
    'next-offset-unaligned': [32n, 33, 20], 'next-offset-overlong': [32n, 65532, 20],
    'total-query-ceiling': [14n, 0, 2],
  }
  for (const [kind, expected] of Object.entries(fields)) {
    const backing = Buffer.alloc(65536 + 16, 0x7f), io = Buffer.alloc(16)
    injectDirectoryRecord(kind, io, backing.subarray(8, -8))
    assert.deepEqual([io.readBigUInt64LE(8), backing.readUInt32LE(8), backing.readUInt32LE(16)], expected)
    assert.equal(io.readInt32LE(), 0)
    assert.deepEqual(backing.subarray(0, 8), Buffer.alloc(8, 0x7f))
    assert.deepEqual(backing.subarray(-8), Buffer.alloc(8, 0x7f))
  }
  assert.throws(() => injectDirectoryRecord('invented', Buffer.alloc(16), Buffer.alloc(65536)))
  assert.throws(() => injectDirectoryRecord('truncated-header', Buffer.alloc(8), Buffer.alloc(65536)))
})

test('SDK executable, C source and compiler-log substitutions are rejected before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'directory-binding-negative-'))
  const program = join(root, 'oracle.exe'), log = join(root, 'compiler.log'), buildPath = join(root, 'oracle-build.json')
  try {
    writeFileSync(program, 'portable byte fixture, never executed'); writeFileSync(log, 'portable compiler-log fixture')
    const build = { architecture: 'x64', sourceSha256: sourceBinding().files['windows-oracle.c'],
      binarySha256: digest(readFileSync(program)), compilerLogSha256: digest(readFileSync(log)) }
    writeFileSync(buildPath, JSON.stringify(build))
    assert.equal(oracleBinding(program).oracleSha256, build.binarySha256)
    for (const field of ['sourceSha256', 'binarySha256', 'compilerLogSha256', 'architecture']) {
      writeFileSync(buildPath, JSON.stringify({ ...build, [field]: 'wrong' }))
      assert.throws(() => oracleBinding(program))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('malformed output and a missing result terminate only the bounded owned protocol child', async () => {
  for (const source of ["console.log('not-json');setInterval(()=>{},1000)", "console.log(JSON.stringify({event:'ready'}));setInterval(()=>{},1000)"]) {
    const child = startChild(process.execPath, ['-e', source], fixtureEnvironment(resolve('synthetic-home'), tmpdir()), { closeTimeoutMs: 5000 })
    try {
      if (source.includes('not-json')) await assert.rejects(child.next(5000), SyntaxError)
      else { assert.deepEqual(await child.next(5000), { event: 'ready' }); await assert.rejects(child.next(20), /timed out/u) }
    } finally { await child.kill() }
    assert.equal(child.settled, true)
  }
})

test('a duplicate result is rejected even after the owned process exits normally', async () => {
  const source = "console.log(JSON.stringify({event:'result'}));console.log(JSON.stringify({event:'result'}))"
  const child = startChild(process.execPath, ['-e', source], fixtureEnvironment(resolve('synthetic-home'), tmpdir()))
  try {
    assert.deepEqual(await child.next(), { event: 'result' })
    await child.complete()
    await assert.rejects(async () => { await assert.rejects(child.next(1), /already exited/u) })
  } finally { await child.kill() }
  assert.equal(child.settled, true)
})

test('non-Windows CLI writes every required blocked row and never imports the supplied entry', { skip: process.platform === 'win32' && process.arch === 'x64' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'directory-nonnative-'))
  try {
    const entry = join(root, 'entry.js'), oracle = join(root, 'oracle.exe'), output = join(root, 'report.json')
    writeFileSync(entry, "throw new Error('entry must never be imported on this platform')")
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('directory-boundary-matrix.mjs', import.meta.url)),
      '--entry', entry, '--oracle', oracle, '--output', output], { encoding: 'utf8', timeout: 10_000,
      env: fixtureEnvironment(root, root) })
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 2, child.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(validateReport(report), 2)
    assert.equal(report.nativeExecution, false)
    assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 26 })
    assert.match(report.prerequisiteFailure, /actual Windows x64/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
