/** Portable evidence rejection tests; they never count as Windows/native fault execution. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ownerFaultCases, ownerFaultBlockedCases, ownerDirectoryCases, ownerInternalCases,
  ownerProductionSha256, ownerProductionFile, ownerSourceBinding, ownerOrdinalMapping, ownerOrdinalCases,
  ownerSummary, ownerFileDigest, validateOwnerFaultReport, validateOwnerFaultResult } from './owner-fault-support.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const hash = 'a'.repeat(64)
const event = { name: 'NtReadFile', forwarded: true, injected: false, actualReturn: 0, visibleReturn: 0, actuallyReleased: false }
const detail = (scenario = 'native-read-allocation-baseline') => ({
  event: 'result', scenario, evidence: 'source-instrumented-native-owner-faults', productionSourceSha256: ownerProductionSha256,
  packedProductionBinaryExecution: false, realStorageFailureClaimed: false, actualAllocatorFailureClaimed: false,
  actualPendingRequest: false, protocolViolations: 0, overflow: false, allocations: 2, exposures: 1,
  queryCalls: 0, injections: 0, faultInjected: false, trace: [{ ...event }], outcome: { ok: true },
  pendingContexts: 0, retainedContexts: 0, quarantinedOwners: 0, liveNativeHandles: 0, liveNativeDescriptors: 0,
  fixtureBinarySha256: hash, fixtureSourceSha256: hash, entrySha256: hash, productionBinarySha256: hash,
})
const blockedReport = () => ({ schemaVersion: 1, evidence: 'source-instrumented-native-owner-faults', packedProductionBinaryExecution: false,
  nativeExecution: false, platform: 'linux', architecture: 'x64', ...ownerSourceBinding(), ordinalMapping: ownerOrdinalMapping,
  results: [...ownerFaultCases.map(name => ({ name, status: 'blocked', reason: 'Windows SDK execution unavailable' })),
    ...ownerFaultBlockedCases.map(row => ({ ...row, status: 'blocked' }))], summary: { passed: 0, failed: 0, blocked: 53 }, acceptance: 'partial' })

test('original 24 directory/cleanup and 27 internal IDs survive source instrumentation', () => {
  assert.equal(ownerDirectoryCases.length, 24); assert.equal(ownerInternalCases.length, 27)
  assert.equal(ownerFaultCases.length, 51); assert.equal(new Set(ownerFaultCases).size, 51)
  assert.deepEqual(ownerFaultCases.slice(0, 24), ownerDirectoryCases)
  assert.equal(ownerFileDigest(ownerProductionFile), ownerProductionSha256)
  assert.equal(ownerOrdinalMapping.view.actualPointerViewClaimed, false)
  assert.match(ownerOrdinalMapping.view.replacement, /napi_create_buffer_copy.*napi_create_external/u)
})

test('non-native report has exactly zero passes and retains both blocked cleanup obligations', () => {
  const report = blockedReport()
  assert.equal(validateOwnerFaultReport(report), 2)
  assert.equal(report.results.at(-1).applicability, 'not-applicable')
  assert.equal(report.results.at(-1).passes, 0)
  for (const mutate of [
    value => { value.results.pop() },
    value => { value.results[0] = { ...value.results[0], status: 'passed', detail: detail('directory-enumeration-baseline') } },
    value => { value.results.at(-1).status = 'passed' },
    value => { value.packedProductionBinaryExecution = true },
    value => { value.evidence = 'packed-native-directory-cleanup-matrix' },
    value => { value.fixtureSources[Object.keys(value.fixtureSources)[0]] = 'b'.repeat(64) },
    value => { value.productionSourceSha256 = 'b'.repeat(64) },
    value => { value.results.push({ name: 'extra-unsupported-obligation', status: 'passed' }) },
  ]) {
    const changed = structuredClone(report); mutate(changed); changed.summary = ownerSummary(changed.results)
    assert.throws(() => validateOwnerFaultReport(changed))
  }
})

test('allocation and exposure inventory requires every observed ordinal, never unknown-as-zero', () => {
  assert.deepEqual(ownerOrdinalCases('read', { allocations: 2, exposures: 1 }), [
    'native-one-shot-alloc:1', 'native-one-shot-alloc:2', 'native-one-shot-view:1',
  ])
  assert.deepEqual(ownerOrdinalCases('publish', { allocations: 1, exposures: 2 }), [
    'native-one-shot-publish-alloc:1', 'native-one-shot-publish-view:1', 'native-one-shot-publish-view:2',
  ])
  for (const invalid of [{ allocations: 0, exposures: 1 }, { allocations: 1 }, { allocations: 4097, exposures: 1 }]) {
    assert.throws(() => ownerOrdinalCases('read', invalid))
  }
})

test('passing labels cannot hide retained contexts, absent forwarding, extra pending work or stale source identity', () => {
  validateOwnerFaultResult(detail(), 'native-read-allocation-baseline')
  for (const mutate of [
    value => { value.retainedContexts = 1 },
    value => { value.liveNativeHandles = 1 },
    value => { value.liveNativeDescriptors = 1 },
    value => { value.actualPendingRequest = true },
    value => { value.protocolViolations = 1 },
    value => { value.overflow = true },
    value => { value.trace[0].forwarded = false },
    value => { delete value.trace[0].actualReturn },
    value => { value.productionSourceSha256 = '0'.repeat(64) },
    value => { value.realStorageFailureClaimed = true },
  ]) {
    const changed = detail(); mutate(changed)
    assert.throws(() => validateOwnerFaultResult(changed, changed.scenario))
  }
})

test('pending quarantine requires a real wait/cancel trace and rejects later native acquisition', () => {
  const value = detail('native-call-boundary-pending-unsettled')
  Object.assign(value, { outcome: { ok: false, code: 'unavailable' }, pendingContexts: 1, retainedContexts: 1, quarantinedOwners: 1,
    faultInjected: true, injections: 1, poisonProbe: { rejected: true, code: 'unavailable', nativeCalls: 0, allocationChange: 0 } })
  value.trace = [{ ...event, injected: true, visibleReturn: 259, injectionOrigin: 'test-owned-return-and-completion' },
    { ...event, name: 'WaitForSingleObject' }, { ...event, name: 'CancelIoEx' }]
  validateOwnerFaultResult(value, value.scenario)
  for (const mutate of [
    changed => { changed.poisonProbe.nativeCalls = 1 },
    changed => { changed.retainedContexts = 0 },
    changed => { changed.trace = changed.trace.filter(row => row.name !== 'CancelIoEx') },
    changed => { changed.trace[0].name = 'FakeRead' },
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => validateOwnerFaultResult(changed, changed.scenario)) }
})

test('source fixture includes production directly, scopes macros to the include, and has no environment fault activation', () => {
  const source = readFileSync(join(here, 'owner-fault-fixture.c'), 'utf8')
  assert.match(source, /#include "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/native\/system\/packages\/entry\/src\/windows-private-owner\.c"/u)
  assert.ok(source.indexOf('#define calloc of_calloc') < source.indexOf('#include "../../../../../native'))
  assert.ok(source.indexOf('#undef calloc') > source.indexOf('#include "../../../../../native'))
  assert.doesNotMatch(source, /getenv\s*\(|GetEnvironmentVariable|__typeof_placeholder__/u)
  assert.match(source, /NAPI_MODULE_INIT\(\) static napi_value of_production_initializer/u)
  assert.match(source, /Disarm only: never erase live resources/u)
})

test('portable matrix emits a complete blocked report without executing a native binary', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-fault-report-'))
  try {
    const reportPath = join(directory, 'report.json')
    const child = spawnSync(process.execPath, [join(here, 'owner-fault-matrix.mjs'), '--report', reportPath], { encoding: 'utf8', timeout: 10000 })
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 2, child.stderr)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(validateOwnerFaultReport(report), 2); assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 53 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

const nodeHeaders = process.argv[2] ?? join(dirname(process.execPath), '../include/node')
test('instrumentation C parses against explicitly synthetic Linux declarations; this is not SDK/native evidence',
  { skip: process.platform !== 'linux' || !existsSync(join(nodeHeaders, 'node_api.h')) }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-fault-syntax-'))
    try {
      const extra = `#include ${JSON.stringify(join(here, 'owner-windows-model.h'))}\n#ifndef OF_SYNTAX_EXTRA\n#define OF_SYNTAX_EXTRA\n` +
        'typedef PVOID LPVOID; typedef PVOID HLOCAL; typedef PWSTR LPWSTR; typedef const char *LPCSTR; typedef LPDWORD PDWORD; typedef DWORD SECURITY_INFORMATION; typedef PVOID PACL; typedef uintptr_t ULONG_PTR; typedef OVERLAPPED *LPOVERLAPPED;\n' +
        '#define ERROR_INVALID_HANDLE 6\n#define ERROR_NOT_LOCKED 158\n#ifndef WAIT_FAILED\n#define WAIT_FAILED ((DWORD)0xffffffff)\n#endif\n#endif\n'
      for (const name of ['windows.h', 'winternl.h', 'aclapi.h']) writeFileSync(join(directory, name), extra)
      const result = spawnSync('cc', ['-std=c17', '-fshort-wchar', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
        '-D_WIN64', '-D_M_X64', '-DNAPI_VERSION=8', '-I', directory, '-I', nodeHeaders, '-fsyntax-only', join(here, 'owner-fault-fixture.c')],
      { encoding: 'utf8', timeout: 30000 })
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
