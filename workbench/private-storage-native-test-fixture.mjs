/** Hypothetical report builders for portable rejection tests. These never establish native execution. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerFaultCases, ownerFaultBlockedCases, ownerFaultSources, ownerProductionSha256,
  ownerDigest, ownerOrdinalCases, ownerOrdinalMapping, ownerSummary } from './private-storage-owner-fault-evidence.mjs'

export const syntheticOwnerIdentity = () => {
  const fixtureSources = Object.fromEntries(ownerFaultSources.map(path => [path, 'e'.repeat(64)]))
  return { productionSourceSha256: ownerProductionSha256, fixtureSources, fixtureSourceSha256: ownerDigest(JSON.stringify(fixtureSources)),
    fixtureBinarySha256: 'f'.repeat(64), fixtureBuildSha256: '1'.repeat(64), compilerLogSha256: '2'.repeat(64), productionBinarySha256: '3'.repeat(64), oracleCompilerLogSha256: '4'.repeat(64) }
}

export function syntheticOwnerDetail(scenario, identity, counts) {
  const kind = scenario.replace(/^native-call-boundary-|^directory-enumeration-|^cleanup-real-/u, '').replace(/-return-failure$/u, '')
  const target = { 'open-token': 'OpenProcessToken', 'token-size': 'GetTokenInformation size', 'token-read': 'GetTokenInformation data',
    security: 'GetSecurityInfo', 'security-length': 'GetSecurityDescriptorLength', 'file-type': 'GetFileType',
    'file-id': 'GetFileInformationByHandleEx', volume: 'GetVolumeInformationByHandleW', 'native-query': 'NtQueryInformationFile',
    'native-volume': 'NtQueryVolumeInformationFile', 'open-file': 'NtCreateFile', 'lock-failure': 'LockFileEx', 'unlock-failure': 'UnlockFileEx' }[kind]
    ?? (scenario.startsWith('directory-enumeration-') ? 'NtQueryDirectoryFile' : kind.startsWith('query-') ? 'NtQueryInformationFile' : 'NtReadFile')
  const baseline = scenario.endsWith('-baseline'), settled = scenario.endsWith('-pending-settled')
  const entryCeiling = scenario.endsWith('-entry-ceiling'), ceiling = entryCeiling || scenario.endsWith('-total-query-ceiling')
  const pending = /pending-(?:unsettled|wait-error)$/u.test(scenario), cleanup = scenario.startsWith('cleanup-real-')
  const fault = !baseline && !entryCeiling
  const event = (name, injected = false) => ({ name, forwarded: true, injected, actualReturn: 0,
    ...(injected ? { injectionOrigin: 'test-owned-return' } : {}) })
  const trace = [event(target, fault)]
  const code = ceiling ? 'limit' : pending ? 'unavailable' : ({ 'read-zero': 'changed', 'read-short': 'changed', 'read-extra-tail': 'changed',
    'security-length': 'privacy', 'lock-failure': 'busy' }[kind] ?? 'native')
  const outcome = { ok: baseline || settled, ...baseline || settled ? {} : { code } }
  if (scenario.startsWith('directory-enumeration-') && outcome.ok) outcome.audit = { complete: true, entries: 2 }
  if (kind === 'native-failure') outcome.nativeStatus = 0xc0000001
  if (kind === 'warning-return') outcome.nativeStatus = 0x80000005
  const detail = { event: 'result', scenario, evidence: 'source-instrumented-native-owner-faults', packedProductionBinaryExecution: false,
    productionSourceSha256: ownerProductionSha256, actualAllocatorFailureClaimed: false, realStorageFailureClaimed: false,
    actualPendingRequest: false, protocolViolations: 0, overflow: false, ...counts, outcome, trace,
    pendingContexts: pending ? 1 : 0, retainedContexts: pending ? 1 : 0, quarantinedOwners: pending ? 1 : 0,
    liveNativeHandles: 0, liveNativeDescriptors: 0, queryCalls: scenario.startsWith('directory-enumeration-') ? 1 : 0,
    backendBoundObserved: true, rootRenamedAfterChildExit: true, leaseReacquiredAfterChildExit: true,
    originalPrivateDescriptorsRetained: true, originalIdentitiesAndBytesRetained: true,
    ...Object.fromEntries(['fixtureBinarySha256', 'fixtureSourceSha256', 'entrySha256', 'productionBinarySha256'].map(field => [field, identity[field]])) }
  if (pending) {
    trace.push(event('WaitForSingleObject'), event('CancelIoEx'))
    detail.poisonProbe = { rejected: true, code: 'unavailable', nativeCalls: 0, allocationChange: 0 }
  }
  if (cleanup) {
    const call = kind === 'local-free' ? 'LocalFree' : kind === 'unlock' ? 'UnlockFileEx' : kind === 'staging-disposition' ? 'NtSetInformationFile' : 'CloseHandle'
    const role = { 'token-close': 'token', 'file-close': 'file', 'directory-close': 'directory', 'staging-close': 'staging' }[kind]
    trace.splice(0, trace.length, { ...event(call, true), actuallyReleased: true, ...role ? { role } : {} })
    detail.cleanupFailureInjected = true
    if (role || kind === 'local-free') detail.quarantinedOwners = 1
    if (scenario.includes('staging-')) {
      detail.writeFailureInjected = true; outcome.receipt = { publication: 'not-published', cleanup: 'failed' }
    }
    if (kind === 'unlock' || kind === 'directory-close') detail.idempotence = { repeatCloseNativeCalls: 0 }
  }
  const ordinal = /(?:publish-)?(alloc|view):(\d+)$/u.exec(scenario)
  if (ordinal) Object.assign(trace[0], { ordinal: Number(ordinal[2]), injectionOrigin: ownerOrdinalMapping[ordinal[1]].injection })
  detail.injections = trace.filter(row => row.injected).length; detail.faultInjected = detail.injections > 0
  return detail
}

export function syntheticOwnerReport(specification, counts = { read: { allocations: 2, exposures: 1 }, publish: { allocations: 1, exposures: 2 } }) {
  const identity = { ...syntheticOwnerIdentity(), ...specification }
  const results = ownerFaultCases.map(name => {
    const mode = name.includes('publish') ? 'publish' : 'read'
    return name.endsWith('-fault-inventory') ? { name, status: 'passed', requiredCases: ownerOrdinalCases(mode, counts[mode]) }
      : { name, status: 'passed', detail: syntheticOwnerDetail(name, identity, counts[mode]) }
  })
  for (const mode of ['read', 'publish']) for (const name of ownerOrdinalCases(mode, counts[mode])) {
    results.push({ name, status: 'passed', detail: syntheticOwnerDetail(name, identity, counts[mode]) })
  }
  results.push(...ownerFaultBlockedCases.map(row => ({ ...row, status: 'blocked' })))
  return { schemaVersion: 1, nativeExecution: true, platform: 'win32', architecture: 'x64', ...identity,
    evidence: 'source-instrumented-native-owner-faults', packedProductionBinaryExecution: false, ordinalMapping: ownerOrdinalMapping,
    oracleSha256: specification.oracleSha256, results, summary: ownerSummary(results), acceptance: 'partial' }
}

export function syntheticSpecifications(identity = {}) {
  return ['primary', 'admission', 'boundary', 'owner-faults'].map(id => ({ id, sourceSha: 'a'.repeat(40), entrySha256: 'b'.repeat(64),
    oracleSha256: 'c'.repeat(64), oracleSourceSha256: 'd'.repeat(64), ...identity,
    evidencePlane: id === 'owner-faults' ? 'source-instrumented-native-owner-faults' : 'packed-production',
    ...id === 'owner-faults' ? syntheticOwnerIdentity() : {} }))
}

export function syntheticAbsentDescriptor() {
  const original = { bytesHex: '00', descriptor: { control: 0x8004 }, identity: { volume: '1', fileId: '2' }, parentEntries: ['record.bin'] }
  return { evidence: 'instrumented-descriptor-buffer', actualDiskAbsentDacl: false, filesystemSecurityModified: false,
    nativeSecurityCallsForwarded: true, original, after: structuredClone(original),
    refusals: ['read', 'replace'].map(operation => ({ operation, name: 'PrivateStorageError', code: 'privacy' })),
    injections: ['read', 'replace'].map(operation => ({ operation, forwarded: true, originalSha256: 'a'.repeat(64), modifiedSha256: 'b'.repeat(64),
      originalControl: 0x8004, modifiedControl: 0x8000, originalDaclOffset: 20, modifiedDaclOffset: 0, identity: original.identity })) }
}

// These files and compiler records are inert inputs for orchestration tests, never executable SDK evidence.
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
export const syntheticFileHash = path => ownerDigest(readFileSync(path))
export function copySyntheticOwnerInputs(toolkit) {
  for (const path of [...ownerFaultSources, 'native/system/packages/entry/src/windows-private-owner.c',
    'native/system/scripts/prepare-windows-node-sdk.mjs', 'native/system/scripts/download-node-sdk.mjs']) {
    const target = join(toolkit, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(sourceRoot, path), target)
  }
}
export function writeSyntheticOwnerBuild(toolkit, directory, nodeSdk) {
  mkdirSync(directory, { recursive: true })
  const emit = (name, bytes) => { const path = join(directory, name); writeFileSync(path, bytes); return syntheticFileHash(path) }
  const fixtureSources = Object.fromEntries(ownerFaultSources.map(path => [path, syntheticFileHash(join(toolkit, path))]))
  const inputs = [...ownerFaultSources.map(path => join(toolkit, path)), join(toolkit, 'native/system/packages/entry/src/windows-private-owner.c'),
    ...['verified.json', 'headers.tar.gz', 'node.lib'].map(name => join(nodeSdk, name))].map(path => ({ path, sha256: syntheticFileHash(path) }))
  const binarySha256 = emit('owner-fault-fixture.node', 'Synthetic inert source-owner binary')
  const build = { schemaVersion: 1, evidence: 'source-instrumented-native-owner-faults', complete: true, sourceUnchanged: true,
    compilerInputsComplete: true, exitCode: 0, platform: 'win32', architecture: 'x64', nodeVersion: process.version,
    binary: 'owner-fault-fixture.node', binarySha256, producedBinarySha256: binarySha256,
    compilerLogSha256: emit('owner-fault-compiler.log', 'Synthetic compiler log; no compiler ran'),
    productionSourceSha256: ownerProductionSha256, fixtureSources, fixtureSourceSha256: ownerDigest(JSON.stringify(fixtureSources)), inputs, nodeSdk }
  emit('owner-fault-build.json', JSON.stringify(build))
  return build
}
export function writeSyntheticNodeSdk(directory) {
  mkdirSync(directory, { recursive: true })
  const files = ['headers.tar.gz', 'node.lib'].map((name, index) => {
    const bytes = Buffer.from(`Synthetic inert SDK ${name}`); writeFileSync(join(directory, name), bytes)
    return { name: index === 0 ? `node-${process.version}-headers.tar.gz` : 'win-x64/node.lib', sha256: ownerDigest(bytes), bytes: bytes.length }
  })
  const receipt = { version: process.version, architecture: 'x64', source: `https://nodejs.org/dist/${process.version}/`, files }
  writeFileSync(join(directory, 'verified.json'), JSON.stringify(receipt)); return receipt
}
