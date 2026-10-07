/** Source-instrumented Windows owner evidence. This never certifies a packed native payload. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ownerProductionSha256 = '4bbd66634eb5f1215d62c65b745c6483c2578f2ec762d54e4afd394eb419b77f'
export const ownerProductionFile = fileURLToPath(new URL('../../../../../native/system/packages/entry/src/windows-private-owner.c', import.meta.url))
export const ownerDirectoryCases = Object.freeze([
  'directory-enumeration-baseline',
  ...['truncated-header', 'overlong-buffer', 'odd-name-length', 'zero-name-length', 'name-overruns-page',
    'next-record-truncated', 'next-offset-overlap', 'next-offset-unaligned', 'next-offset-overlong', 'native-failure',
    'warning-return', 'pending-settled', 'pending-unsettled', 'pending-wait-error', 'entry-ceiling', 'total-query-ceiling']
    .map(name => `directory-enumeration-${name}`),
  ...['token-close', 'file-close', 'directory-close', 'unlock', 'local-free', 'staging-close', 'staging-disposition']
    .map(name => `cleanup-real-${name}-return-failure`),
])
export const ownerInternalCases = Object.freeze([
  ...['read', 'publish'].flatMap(mode => [`native-${mode}-allocation-baseline`, `native-${mode}-allocation-fault-inventory`]),
  ...['open-token', 'token-size', 'token-read', 'security', 'security-length', 'file-type', 'file-id', 'volume',
    'native-query', 'native-volume', 'open-file', 'query-short', 'query-oversize', 'read-failure', 'read-zero',
    'read-overrun', 'read-extra-tail', 'read-short', 'pending-settled', 'pending-unsettled', 'pending-wait-error',
    'lock-failure', 'unlock-failure'].map(name => `native-call-boundary-${name}`),
])
export const ownerFaultCases = Object.freeze([...ownerDirectoryCases, ...ownerInternalCases])
export const ownerFaultBlockedCases = Object.freeze([
  { name: 'cleanup-genuine-kernel-release-failure', reason: 'No safe deterministic OS fixture makes release of an owned live handle or descriptor fail. Invalid, already-freed or reused resources are never passed to native cleanup.' },
  { name: 'cleanup-koffi-free-failure', reason: 'Koffi free has no failure return. Throwing around a real free cannot establish allocator failure; retaining or re-freeing an uncertain pointer is not used as evidence.', applicability: 'not-applicable', passes: 0 },
])
export const ownerOrdinalMapping = Object.freeze({
  alloc: { original: 'Koffi allocation ordinal', replacement: 'production calloc allocation ordinal', injection: 'test-owned-allocation-refusal', actualAllocatorFailureClaimed: false },
  view: { original: 'Koffi pointer-view ordinal', replacement: 'production napi_create_buffer_copy or napi_create_external result-exposure ordinal', injection: 'test-owned-result-exposure-refusal', actualPointerViewClaimed: false },
})
export const ownerFaultSources = Object.freeze([
  'packages/storage/private-storage/tests/native/owner-fault-fixture.c',
  'packages/storage/private-storage/tests/native/owner-fault-support.mjs',
  'packages/storage/private-storage/tests/native/owner-fault-worker.mjs',
  'packages/storage/private-storage/tests/native/owner-fault-matrix.mjs',
  'packages/storage/private-storage/tests/native/owner-observer.mjs',
  'packages/storage/private-storage/tests/native/boundary-support.mjs',
  'packages/storage/private-storage/tests/native/directory-boundary-support.mjs',
  'packages/storage/private-storage/tests/native/windows-oracle.c',
  'workbench/private-storage-owner-fault.ps1',
])
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export const ownerDigest = value => createHash('sha256').update(value).digest('hex')
export const ownerFileDigest = path => { assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()); return ownerDigest(readFileSync(path)) }
export const ownerSummary = rows => Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, rows.filter(row => row.status === status).length]))

/** Bind every source input, including unchanged production C and imported orchestration helpers. */
export function ownerSourceBinding() {
  assert.equal(ownerFileDigest(ownerProductionFile), ownerProductionSha256, 'Production owner source differs from reviewed instrumentation pin')
  const fixtureSources = Object.fromEntries(ownerFaultSources.map(path => [path, ownerFileDigest(join(root, path))]))
  return { productionSourceSha256: ownerProductionSha256, fixtureSources, fixtureSourceSha256: ownerDigest(JSON.stringify(fixtureSources)) }
}

/** Reject stale source, compiler input, binary, or instrumentation evidence before loading the fixture. */
export function ownerFaultBinding(binary) {
  const actual = realpathSync(binary), buildPath = join(dirname(actual), 'owner-fault-build.json')
  const build = JSON.parse(readFileSync(buildPath, 'utf8')), source = ownerSourceBinding()
  assert.equal(build.schemaVersion, 1); assert.equal(build.evidence, 'source-instrumented-native-owner-faults')
  assert.equal(build.complete, true); assert.equal(build.exitCode, 0); assert.equal(build.sourceUnchanged, true)
  assert.equal(build.platform, 'win32'); assert.equal(build.architecture, 'x64'); assert.equal(build.nodeVersion, process.version)
  assert.equal(build.productionSourceSha256, ownerProductionSha256)
  assert.deepEqual(build.fixtureSources, source.fixtureSources)
  assert.equal(build.fixtureSourceSha256, source.fixtureSourceSha256)
  assert.equal(build.binary, 'owner-fault-fixture.node'); assert.equal(actual, realpathSync(join(dirname(actual), build.binary)))
  const fixtureBinarySha256 = ownerFileDigest(actual)
  assert.equal(build.binarySha256, fixtureBinarySha256)
  assert.equal(build.compilerLogSha256, ownerFileDigest(join(dirname(actual), 'owner-fault-compiler.log')))
  assert.equal(build.compiler.binarySha256, ownerFileDigest(build.compiler.path))
  assert.equal(build.compiler.developerScriptSha256, ownerFileDigest(build.compiler.developerScript))
  const output = dirname(actual), sdk = realpathSync(build.nodeSdk)
  assert.deepEqual(build.compiler.arguments, ['/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8', '/D_WIN32_WINNT=0x0602',
    `/I${join(sdk, 'include/node')}`, '/sourceDependencies', join(output, 'owner-fault-dependencies.json'),
    `/Fo${join(output, 'owner-fault.obj')}`, join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'),
    '/link', '/VERBOSE:LIB', `/OUT:${actual}`, `/IMPLIB:${join(output, 'owner-fault.lib')}`, join(sdk, 'node.lib'), 'kernel32.lib', 'advapi32.lib'])
  assert.ok(Array.isArray(build.inputs) && build.inputs.length > 5)
  assert.ok(Array.isArray(build.inputsBeforeCompilation) && build.inputsBeforeCompilation.length >= build.inputs.length
    && build.inputsBeforeCompilation.length <= 10000)
  const before = new Map(build.inputsBeforeCompilation.map(input => [realpathSync(input.path).toLowerCase(), input.sha256]))
  assert.equal(before.size, build.inputsBeforeCompilation.length)
  assert.equal(build.discoveryDependenciesSha256, ownerFileDigest(join(output, 'owner-fault-discovery.json')))
  assert.equal(build.discoveryLogSha256, ownerFileDigest(join(output, 'owner-fault-discovery.log')))
  assert.equal(build.librarySearchSha256, ownerFileDigest(join(output, 'owner-fault-library-search.txt')))
  assert.deepEqual(build.discoveryArguments, ['/nologo', '/Bv', '/std:c17', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8',
    '/D_WIN32_WINNT=0x0602', `/I${join(sdk, 'include/node')}`, '/Zs', '/sourceDependencies', join(output, 'owner-fault-discovery.json'),
    join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c')])
  assert.equal(new Set(build.inputs.map(input => input.path.toLowerCase())).size, build.inputs.length)
  for (const input of build.inputs) {
    assert.equal(input.sha256, before.get(realpathSync(input.path).toLowerCase()), 'Compiler input lacks matching precompile admission')
    assert.equal(input.sha256, ownerFileDigest(input.path))
  }
  const dependencies = JSON.parse(readFileSync(join(output, 'owner-fault-dependencies.json'), 'utf8'))
  assert.ok(Array.isArray(dependencies.Data.Includes) && dependencies.Data.Includes.length > 5)
  const inputPaths = new Set(build.inputs.map(input => realpathSync(input.path).toLowerCase()))
  for (const path of [ownerProductionFile, join(root, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'),
    join(sdk, 'node.lib'), join(sdk, 'verified.json'), join(sdk, 'headers.tar.gz'), ...dependencies.Data.Includes]) {
    assert.ok(inputPaths.has(realpathSync(path).toLowerCase()), `Unpinned compiler input: ${path}`)
  }
  const compilerLog = readFileSync(join(output, 'owner-fault-compiler.log'), 'utf8')
  const libraries = [...compilerLog.matchAll(/^\s*Searching\s+([A-Z]:\\[^\r\n]+\.lib):\s*$/gimu)]
  assert.ok(libraries.length >= 3)
  for (const [, path] of libraries) assert.ok(inputPaths.has(realpathSync(path).toLowerCase()), 'Unpinned resolved linker library')
  assert.equal(build.dependenciesSha256, ownerFileDigest(join(dirname(actual), 'owner-fault-dependencies.json')))
  assert.equal(build.producedBinarySha256, fixtureBinarySha256)
  assert.equal(build.compilerInputsComplete, true)
  return { ...source, fixtureBinarySha256, fixtureBuildSha256: ownerFileDigest(buildPath), compilerLogSha256: build.compilerLogSha256,
    compilerSha256: build.compiler.binarySha256, build }
}

/** Preserve the original dynamic IDs while recording their reviewed native allocation/exposure meaning. */
export function ownerOrdinalCases(mode, detail) {
  assert.ok(['read', 'publish'].includes(mode))
  const prefix = `native-one-shot-${mode === 'publish' ? 'publish-' : ''}`
  for (const field of ['allocations', 'exposures']) assert.ok(Number.isInteger(detail[field]) && detail[field] > 0 && detail[field] <= 4096, 'Unknown inventory is never an empty set')
  return ['alloc', 'view'].flatMap(kind => Array.from({ length: detail[kind === 'alloc' ? 'allocations' : 'exposures'] }, (_, i) => `${prefix}${kind}:${i + 1}`))
}

/** Require observable forwarding, rollback/quarantine, and bounded refusal before a row can pass. */
export function validateOwnerFaultResult(detail, scenario) {
  assert.equal(detail.event, 'result'); assert.equal(detail.scenario, scenario)
  assert.equal(detail.productionSourceSha256, ownerProductionSha256)
  assert.equal(detail.packedProductionBinaryExecution, false)
  assert.equal(detail.evidence, 'source-instrumented-native-owner-faults')
  assert.equal(detail.actualAllocatorFailureClaimed, false); assert.equal(detail.realStorageFailureClaimed, false)
  assert.equal(detail.actualPendingRequest, false); assert.equal(detail.protocolViolations, 0); assert.equal(detail.overflow, false)
  assert.ok(Array.isArray(detail.trace) && detail.trace.length > 0 && detail.trace.length <= 4096)
  assert.ok(detail.trace.some(event => event.forwarded && !['calloc', 'free'].includes(event.name)))
  for (const event of detail.trace) {
    assert.equal(typeof event.forwarded, 'boolean'); assert.equal(typeof event.injected, 'boolean')
    if (event.forwarded) assert.equal(typeof event.actualReturn, 'number')
    else assert.equal(event.injected, true)
    if (event.injected) assert.ok(['test-owned-return', 'test-owned-buffer', 'test-owned-return-and-completion',
      'test-owned-allocation-refusal', 'test-owned-result-exposure-refusal'].includes(event.injectionOrigin))
  }
  assert.equal(detail.injections, detail.trace.filter(row => row.injected).length)
  assert.equal(detail.faultInjected, detail.injections > 0)
  const kind = scenario.replace(/^native-call-boundary-|^directory-enumeration-|^cleanup-real-/u, '').replace(/-return-failure$/u, '')
  const target = {
    'open-token': 'OpenProcessToken', 'token-size': 'GetTokenInformation size', 'token-read': 'GetTokenInformation data',
    security: 'GetSecurityInfo', 'security-length': 'GetSecurityDescriptorLength', 'file-type': 'GetFileType',
    'file-id': 'GetFileInformationByHandleEx', volume: 'GetVolumeInformationByHandleW', 'native-query': 'NtQueryInformationFile',
    'native-volume': 'NtQueryVolumeInformationFile', 'open-file': 'NtCreateFile',
    'lock-failure': 'LockFileEx', 'unlock-failure': 'UnlockFileEx',
  }[kind] ?? (scenario.startsWith('directory-enumeration-') ? 'NtQueryDirectoryFile'
    : kind.startsWith('read-') || kind.startsWith('pending-') ? 'NtReadFile'
    : kind.startsWith('query-') ? 'NtQueryInformationFile' : undefined)
  if (target && !scenario.endsWith('-baseline') && !scenario.endsWith('-entry-ceiling')) {
    assert.ok(detail.trace.some(event => event.name === target && event.forwarded && event.injected), `Missing forwarded injection at ${target}`)
  }
  assert.ok(detail.outcome && typeof detail.outcome.ok === 'boolean')
  const baseline = scenario.endsWith('-baseline'), settled = scenario.endsWith('-pending-settled')
  const ceiling = scenario.endsWith('-entry-ceiling') || scenario.endsWith('-total-query-ceiling')
  if (baseline || settled) {
    assert.equal(detail.outcome.ok, true)
    if (scenario.startsWith('directory-enumeration-')) assert.deepEqual(detail.outcome.audit, { complete: true, entries: 2 })
  }
  else assert.equal(detail.outcome.ok, false)
  if (baseline || scenario.endsWith('-entry-ceiling')) assert.equal(detail.faultInjected, false)
  else assert.equal(detail.faultInjected, true)
  if (ceiling) assert.equal(detail.outcome.code, 'limit')
  if (scenario.startsWith('directory-enumeration-')) {
    assert.ok(detail.queryCalls > 0 && detail.queryCalls <= 64)
    assert.equal(detail.queryCalls, detail.trace.filter(row => row.name === 'NtQueryDirectoryFile').length)
    if (!baseline && !settled && !ceiling) assert.equal(detail.outcome.code, /pending-(?:unsettled|wait-error)$/u.test(scenario) ? 'unavailable' : 'native')
    if (!detail.outcome.ok) assert.equal(detail.outcome.audit, undefined)
    if (kind === 'native-failure') assert.equal(detail.outcome.nativeStatus, 0xc0000001)
    if (kind === 'warning-return') assert.equal(detail.outcome.nativeStatus, 0x80000005)
  }
  const expectedCode = { 'read-zero': 'changed', 'read-short': 'changed', 'read-extra-tail': 'changed',
    'read-failure': 'native', 'read-overrun': 'native', 'security-length': 'privacy', 'lock-failure': 'busy' }[kind]
  if (expectedCode) assert.equal(detail.outcome.code, expectedCode)
  if (scenario.endsWith('-total-query-ceiling')) { assert.equal(detail.backendBoundObserved, true); assert.ok(detail.queryCalls > 0 && detail.queryCalls <= 64) }
  if (/pending-(?:unsettled|wait-error)$/u.test(scenario)) {
    assert.ok(detail.pendingContexts > 0); assert.ok(detail.retainedContexts > 0); assert.ok(detail.quarantinedOwners > 0)
    assert.deepEqual(detail.poisonProbe, { rejected: true, code: 'unavailable', nativeCalls: 0, allocationChange: 0 })
    assert.ok(detail.trace.some(row => row.name === 'WaitForSingleObject' && row.forwarded))
    assert.ok(detail.trace.some(row => row.name === 'CancelIoEx' && row.forwarded))
  } else if (detail.quarantinedOwners === 0) {
    assert.equal(detail.pendingContexts, 0); assert.equal(detail.retainedContexts, 0)
    assert.equal(detail.liveNativeHandles, 0); assert.equal(detail.liveNativeDescriptors, 0)
  }
  if (scenario.startsWith('cleanup-real-')) {
    const cleanupCall = kind === 'local-free' ? 'LocalFree' : kind === 'unlock' ? 'UnlockFileEx' : kind === 'staging-disposition' ? 'NtSetInformationFile' : 'CloseHandle'
    const injected = detail.trace.filter(row => row.name === cleanupCall && row.injected)
    assert.equal(injected.length, 1); assert.equal(injected[0].forwarded, true); assert.equal(injected[0].actuallyReleased, true)
    const role = { 'token-close': 'token', 'file-close': 'file', 'directory-close': 'directory', 'staging-close': 'staging' }[kind]
    if (role) assert.equal(injected[0].role, role)
    if (role || kind === 'local-free') {
      assert.ok(detail.quarantinedOwners > 0)
      const afterFault = detail.trace.slice(detail.trace.indexOf(injected[0]) + 1)
      assert.equal(afterFault.filter(row => row.forwarded).length, 0, 'Unconfirmed retirement may not be retried or followed by new native acquisition')
    }
    assert.equal(detail.cleanupFailureInjected, true)
    assert.ok(detail.trace.some(row => row.injected && row.forwarded && row.actuallyReleased))
    if (scenario.includes('staging-')) {
      assert.equal(detail.writeFailureInjected, true)
      assert.equal(detail.outcome.receipt?.publication, 'not-published'); assert.equal(detail.outcome.receipt?.cleanup, 'failed')
    }
    if (scenario.includes('-unlock-') || scenario.includes('-directory-close-')) assert.deepEqual(detail.idempotence, { repeatCloseNativeCalls: 0 })
  }
  if (/native-one-shot-(?:publish-)?(?:alloc|view):/u.test(scenario)) {
    const [, kind, ordinal] = /(?:publish-)?(alloc|view):(\d+)$/u.exec(scenario)
    const injected = detail.trace.filter(row => row.injected)
    assert.equal(injected.length, 1); assert.equal(injected[0].ordinal, Number(ordinal))
    assert.equal(injected[0].injectionOrigin, ownerOrdinalMapping[kind].injection)
    assert.equal(detail.quarantinedOwners, 0)
  }
  for (const field of ['fixtureBinarySha256', 'fixtureSourceSha256', 'entrySha256', 'productionBinarySha256']) assert.match(detail[field], /^[a-f0-9]{64}$/u)
  return detail
}

/** Validate complete original IDs, dynamic inventories, pinned identity, and honest non-native blocking. */
export function validateOwnerFaultReport(report, expected = {}) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.evidence, 'source-instrumented-native-owner-faults')
  assert.equal(report.packedProductionBinaryExecution, false)
  assert.equal(report.productionSourceSha256, ownerProductionSha256)
  assert.deepEqual(report.ordinalMapping, ownerOrdinalMapping)
  assert.equal(report.fixtureSourceSha256, ownerDigest(JSON.stringify(report.fixtureSources)))
  assert.deepEqual(Object.keys(report.fixtureSources), ownerFaultSources)
  for (const hash of Object.values(report.fixtureSources)) assert.match(hash, /^[a-f0-9]{64}$/u)
  assert.ok(Array.isArray(report.results)); assert.equal(new Set(report.results.map(row => row.name)).size, report.results.length)
  assert.deepEqual(report.results.slice(0, ownerFaultCases.length).map(row => row.name), ownerFaultCases)
  for (const row of report.results) {
    assert.ok(['passed', 'failed', 'blocked'].includes(row.status))
    if (row.status !== 'passed') assert.ok(typeof row.reason === 'string' && row.reason.length > 0)
  }
  for (const blocked of ownerFaultBlockedCases) {
    const row = report.results.find(row => row.name === blocked.name)
    assert.equal(row?.status, 'blocked'); assert.equal(row.reason, blocked.reason)
  }
  const dynamic = []
  for (const mode of ['read', 'publish']) {
    const baseline = report.results.find(row => row.name === `native-${mode}-allocation-baseline`)
    const inventory = report.results.find(row => row.name === `native-${mode}-allocation-fault-inventory`)
    if (baseline.status !== 'passed') { assert.equal(inventory.status, 'blocked'); continue }
    const names = ownerOrdinalCases(mode, baseline.detail); dynamic.push(...names)
    assert.deepEqual(inventory.requiredCases, names)
    const rows = names.map(name => report.results.find(row => row.name === name))
    assert.ok(rows.every(Boolean), 'Every observed native allocation/exposure ordinal remains required')
    if (inventory.status === 'passed') assert.ok(rows.every(row => row.status === 'passed'))
  }
  assert.deepEqual(report.results.slice(ownerFaultCases.length).map(row => row.name), [...dynamic, ...ownerFaultBlockedCases.map(row => row.name)])
  assert.deepEqual(report.summary, ownerSummary(report.results))
  assert.equal(report.acceptance, report.summary.failed ? 'failed' : 'partial')
  if (!report.nativeExecution) assert.equal(report.summary.passed, 0)
  else {
    assert.equal(report.platform, 'win32'); assert.equal(report.architecture, 'x64')
    assert.match(report.sourceSha, /^[a-f0-9]{40}$/u)
    for (const field of ['fixtureBinarySha256', 'fixtureBuildSha256', 'compilerLogSha256', 'entrySha256', 'productionBinarySha256', 'oracleSha256']) assert.match(report[field], /^[a-f0-9]{64}$/u)
  }
  for (const row of report.results.filter(row => row.status === 'passed' && !row.name.endsWith('-fault-inventory'))) {
    validateOwnerFaultResult(row.detail, row.name)
    for (const field of ['fixtureBinarySha256', 'fixtureSourceSha256', 'entrySha256', 'productionBinarySha256']) assert.equal(row.detail[field], report[field])
    assert.equal(row.detail.rootRenamedAfterChildExit, true); assert.equal(row.detail.leaseReacquiredAfterChildExit, true)
    assert.equal(row.detail.originalPrivateDescriptorsRetained, true)
    if (!row.name.startsWith('native-publish-') && !row.name.startsWith('native-one-shot-publish-')) assert.equal(row.detail.originalIdentitiesAndBytesRetained, true)
  }
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(report[name], value)
  return report.summary.failed ? 1 : 2
}
