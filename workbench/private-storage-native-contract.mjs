/** Explicit public Windows x64 subcase inventory. Missing rows remain required, never silently skipped. */
import assert from 'node:assert/strict'
import { evaluateNativeMatrices } from './private-storage-composite.mjs'
import { applyPrivateStorageApplicability, validatePrivateStorageClaim } from './private-storage-applicability.mjs'
import { ownerOrdinalCases } from './private-storage-owner-fault-evidence.mjs'

const primaryRows = [
  'native-runtime', 'sdk-abi-observation', 'token-classification', 'built-backend-load', 'candidate-identities-recorded',
  'independent-private-root-admission', 'fresh-root-under-broad-parent', 'exclusive-whole-file-and-independent-facts',
  'token-denial-readable-control', 'ordinary-token-private-read', 'foreign-user-denial', 'same-user-restricted-token-denial',
  ...['same-user', 'anonymous', 'restricted'].map(kind => `reject-${kind}-thread-impersonation`),
  'collision-preserves-first-publication', 'full-identity-and-owner-survive-restart',
  'replace-retains-old-reader-and-publishes-new-bytes', 'reader-without-delete-sharing-fails-closed',
  'read-byte-ceilings-empty-exact-over-limit', 'full-64-mib-read-allocation-ceiling',
  'literal-names-and-malformed-utf16', 'case-alias-rejection',
  ...['public', 'null', 'empty', 'absent', 'inherited', 'deny-first', 'object', 'callback'].map(kind => `reject-${kind}-dacl-without-repair`),
  'private-child-directory-and-file-policy', 'hardlink-inside-and-outside-root-rejected',
  'final-symlink-and-dangling-symlink-rejected', 'intermediate-directory-symlink-rejected',
  'identity-safe-removal-refuses-stale-entry', 'kernel-lease-contention-monitor-death-and-writer-exit',
  'bounded-audit-under-owned-lease', 'idempotent-close-and-forged-capability-rejection',
  ...['creation-barrier', 'short-write', 'write-failure', 'pre-flush-failure', 'rename-failure', 'rename-return-lost',
    'rename-return-lost-unqueryable', 'post-flush-failure', 'verification-failure', 'close-failure'].map(kind => `real-native-instrumented-${kind}`),
  'prewrite-anonymous-private-denial', 'prewrite-restricted-private-denial',
  'deterministic-parent-rename-refused-by-worker-guard', 'real-native-gc-directories', 'real-native-gc-leases',
  'restricted-primary-process-token-rejection',
]
const admissionRows = [
  'private-root-prerequisite', 'conditional-acl-admission', 'malformed-acl-os-rejection', 'malformed-descriptor-os-rejection',
  'junction-admission', 'unknown-reparse-admission', 'short-name-alias-admission',
  'case-sensitive-directory-admission', 'named-pipe-admission', 'device-namespace-admission',
  'unsupported-volume-admission', 'real-storage-failure',
  // These remain missing/blocked until a real authorized fixture exists; nearby tags/volumes are not substitutes.
  'volume-mount-point-admission', 'cloud-reparse-admission', 'authorized-remote-volume-admission',
]
const readRows = [
  'retained-read-rejects-growth-truncation-and-same-size-write-read-held',
  'retained-read-rejects-growth-truncation-and-same-size-write-read-after-chunk',
  'existing-writer-prevents-private-read-admission', 'post-read-metadata-drift-rejects-without-returning-partial-bytes',
]
const raceRows = ['retained-root-cannot-be-renamed-during-operation', 'retained-source-publication-ignores-staging-path-lookalike',
  'prewrite-failure-cannot-delete-externally-published-staging',
  'leaf-substitution-preserves-opened-identity-read-held', 'leaf-substitution-preserves-opened-identity-read-after-chunk',
  'retained-intermediate-parent-prevents-substitution-and-relocation',
  'post-read-canonical-acl-drift-rejected-without-returning-bytes',
  ...['before-create', 'after-create', 'after-write', 'after-pre-flush', 'before-rename', 'after-rename', 'after-post-flush'].map(phase => `process-death-${phase}`)]
const lifetimeRows = ['stale-capabilities-cannot-close-reused-real-kernel-handles',
  'cloned-identity-cannot-cross-a-real-worker-capability-domain',
  'sdk-child-does-not-inherit-private-handles-with-positive-control',
  // Require the ordinary close control as well as abrupt termination with live leases.
  'native-capability-lifetime-live-worker-close', 'native-capability-lifetime-live-worker-terminate']
const callRows = ['open-token', 'token-size', 'token-read', 'security', 'security-length', 'file-type', 'file-id',
  'volume', 'native-query', 'native-volume', 'open-file', 'query-short', 'query-oversize',
  'read-failure', 'read-zero', 'read-overrun', 'read-extra-tail', 'read-short',
  'pending-settled', 'pending-unsettled', 'pending-wait-error', 'lock-failure', 'unlock-failure'].map(kind => `native-call-boundary-${kind}`)
const publicationRows = ['readonly-target-rejects-publication-without-changing-original', 'executing-target-publication',
  'cooperating-publishers-serialize-through-fixed-native-lease']
const boundaryRows = [...readRows, ...raceRows, ...lifetimeRows, ...callRows, ...publicationRows,
  'native-read-allocation-baseline', 'native-publish-allocation-baseline']
const directoryRows = ['directory-enumeration-baseline',
  ...['truncated-header', 'overlong-buffer', 'odd-name-length', 'zero-name-length', 'name-overruns-page',
    'next-record-truncated', 'next-offset-overlap', 'next-offset-unaligned', 'next-offset-overlong',
    'native-failure', 'warning-return', 'pending-settled', 'pending-unsettled', 'pending-wait-error',
    'entry-ceiling', 'total-query-ceiling'].map(name => `directory-enumeration-${name}`),
  ...['token-close', 'file-close', 'directory-close', 'unlock', 'local-free', 'staging-close',
    'staging-disposition'].map(name => `cleanup-real-${name}-return-failure`),
  'cleanup-genuine-kernel-release-failure', 'cleanup-koffi-free-failure']
const requirement = (matrix, row) => ({ id: `${matrix}/${row}`, evidence: [{ matrix, row }] })
const ownerRequirement = (matrix, row) => ({ id: `${matrix}/${row}`, evidence: [{ matrix: 'owner-faults', row }] })

/** Absent-DACL parser evidence changes only a copy returned by a real packed native security query. */
export function validateAbsentDescriptorEvidence(detail) {
  assert.equal(detail.evidence, 'instrumented-descriptor-buffer')
  assert.equal(detail.actualDiskAbsentDacl, false); assert.equal(detail.filesystemSecurityModified, false)
  assert.equal(detail.nativeSecurityCallsForwarded, true)
  assert.deepEqual(detail.refusals, ['read', 'replace'].map(operation => ({ operation, name: 'PrivateStorageError', code: 'privacy' })))
  assert.deepEqual(detail.original, detail.after)
  assert.ok(detail.original && typeof detail.original.bytesHex === 'string' && detail.original.descriptor && detail.original.identity)
  assert.ok(Array.isArray(detail.original.parentEntries))
  assert.equal(detail.injections.length, 2)
  for (const [index, operation] of ['read', 'replace'].entries()) {
    const injection = detail.injections[index]
    assert.equal(injection.operation, operation); assert.equal(injection.forwarded, true)
    for (const field of ['originalSha256', 'modifiedSha256']) assert.match(injection[field], /^[a-f0-9]{64}$/u)
    assert.notEqual(injection.originalSha256, injection.modifiedSha256)
    assert.equal(injection.originalControl & 4, 4); assert.equal(injection.modifiedControl & 4, 0)
    assert.ok(injection.originalDaclOffset >= 20); assert.equal(injection.modifiedDaclOffset, 0)
    assert.deepEqual(injection.identity, detail.original.identity)
  }
}

/** Inspect the concrete inventory; final acceptance must use evaluatePrivateStorageNative to bind the same raw reports. */
export function privateStorageNativeContract(validatedReports) {
  assert.ok(validatedReports instanceof Map, 'Validated report map is required')
  const requirements = [
    ...primaryRows.map(row => requirement('primary', row)),
    ...admissionRows.map(row => requirement('admission', row)),
    ...boundaryRows.map(row => callRows.includes(row) || row.endsWith('-allocation-baseline')
      ? ownerRequirement('boundary', row) : requirement('boundary', row)),
    ...directoryRows.map(row => ownerRequirement('directory', row)),
  ]
  const ordinalIds = []
  const owner = validatedReports.get('owner-faults')
  for (const mode of ['read', 'publish']) {
    const baselineName = `native-${mode}-allocation-baseline`
    const matches = owner?.results?.filter(row => row.name === baselineName) ?? []
    // Keep an explicit absent inventory requirement instead of inventing zero required fault cases.
    if (matches.length !== 1 || matches[0].status !== 'passed') {
      const missing = ownerRequirement('boundary', `native-${mode}-allocation-fault-inventory-unestablished`)
      requirements.push(missing); ordinalIds.push(missing.id)
      continue
    }
    for (const [field, bound] of [['allocations', 512], ['exposures', 1024]]) {
      const count = matches[0].detail?.[field]
      assert.ok(Number.isSafeInteger(count) && count > 0 && count <= bound, 'Native allocation inventory exceeds its reviewed bounds')
    }
    for (const row of ownerOrdinalCases(mode, matches[0].detail)) {
      const item = ownerRequirement('boundary', row)
      requirements.push(item); ordinalIds.push(item.id)
    }
  }
  const replace = (row, matrix, names) => ({ matrix: 'primary', row, requirements: names.map(name => `${matrix}/${name}`) })
  const replacements = [
    replace('conditional-malformed-acl-native-fixtures', 'admission', ['conditional-acl-admission', 'malformed-acl-os-rejection', 'malformed-descriptor-os-rejection']),
    replace('junction-mount-cloud-unknown-reparse-fixtures', 'admission', ['junction-admission', 'volume-mount-point-admission', 'cloud-reparse-admission', 'unknown-reparse-admission']),
    replace('deterministic-race-and-crash-boundary-matrix', 'boundary', raceRows),
    replace('growing-truncated-same-size-read-races', 'boundary', readRows),
    replace('device-pipe-short-name-case-sensitive-matrix', 'admission', ['device-namespace-admission', 'named-pipe-admission', 'short-name-alias-admission', 'case-sensitive-directory-admission']),
    replace('remaining-native-fault-boundaries', 'boundary', [...callRows, 'native-read-allocation-baseline', 'native-publish-allocation-baseline']),
    replace('remaining-worker-and-handle-lifetime-matrix', 'boundary', lifetimeRows),
    replace('remote-non-ntfs-disk-full-matrix', 'admission', ['unsupported-volume-admission', 'authorized-remote-volume-admission', 'real-storage-failure']),
  ]
  const directoryIds = directoryRows.map(name => `directory/${name}`)
  replacements.push({ matrix: 'boundary', row: 'remaining-directory-query-and-cleanup-fault-boundaries', requirements: directoryIds })
  replacements.find(item => item.row === 'remaining-native-fault-boundaries').requirements.push(...ordinalIds, ...directoryIds)
  for (const row of [...callRows, 'native-read-allocation-baseline', 'native-publish-allocation-baseline']) {
    replacements.push({ matrix: 'boundary', row, requirements: [`boundary/${row}`] })
  }
  for (const mode of ['read', 'publish']) {
    const baseline = requirements.find(item => item.id === `boundary/native-${mode}-allocation-baseline`)
    baseline.evidence.push({ matrix: 'owner-faults', row: `native-${mode}-allocation-fault-inventory` })
    const prefix = `boundary/native-one-shot-${mode === 'publish' ? 'publish-' : ''}`
    const required = ordinalIds.filter(id => mode === 'publish' ? id.startsWith(prefix) : id.startsWith(prefix) && !id.includes('-publish-'))
    const unknown = `boundary/native-${mode}-allocation-fault-inventory-unestablished`
    replacements.push({ matrix: 'boundary', row: `native-${mode}-allocation-fault-inventory`,
      requirements: [baseline.id, ...required, ...ordinalIds.includes(unknown) ? [unknown] : []] })
  }
  assert.equal(new Set(requirements.map(item => item.id)).size, requirements.length, 'Duplicate concrete native subcase')
  return { requirements, replacements }
}

/** Validate identities, derive dynamic ordinals and evaluate the exact same immutable report strings. */
export function evaluatePrivateStorageNative({ specifications, runs, claim }) {
  const fixedClaim = claim === undefined ? undefined : validatePrivateStorageClaim(claim)
  // Take one snapshot before parsing; callers cannot supply a separately derived or stale contract.
  const fixedSpecifications = specifications.map(item => Object.freeze({ ...item,
    ...(item.fixtureSources === undefined ? {} : { fixtureSources: Object.freeze({ ...item.fixtureSources }) }) }))
  const fixedRuns = runs.map(run => Object.freeze({ ...run }))
  assert.deepEqual(fixedSpecifications.map(item => item.id), ['primary', 'admission', 'boundary', 'owner-faults'], 'Required packed and source-owner matrix inventory differs')
  for (const item of fixedSpecifications) {
    assert.equal(item.evidencePlane, item.id === 'owner-faults' ? 'source-instrumented-native-owner-faults' : 'packed-production', 'Native requirement evidence plane differs')
  }
  const validation = evaluateNativeMatrices({ specifications: fixedSpecifications, runs: fixedRuns,
    requirements: [{ id: 'metadata-preflight', evidence: [{ matrix: 'primary', row: 'native-runtime' }] }] })
  const validated = new Map()
  for (const matrix of validation.matrices) {
    if (matrix.valid) validated.set(matrix.matrix, JSON.parse(fixedRuns.find(run => run.matrix === matrix.matrix).rawReport))
  }
  const contract = privateStorageNativeContract(validated)
  const expanded = evaluateNativeMatrices({ specifications: fixedSpecifications, runs: fixedRuns, ...contract })
  const absent = validated.get('primary')?.results.find(row => row.name === 'reject-absent-dacl-without-repair')
  if (absent?.status === 'passed') {
    const requirement = expanded.subcases.find(row => row.id === 'primary/reject-absent-dacl-without-repair')
    requirement.evidencePlane = 'instrumented-descriptor-buffer'
    try { validateAbsentDescriptorEvidence(absent.detail) }
    catch (error) {
      requirement.status = 'blocked'; expanded.complete = false; expanded.acceptance = 'failed'
      expanded.errors.push({ matrix: 'primary', row: absent.name, reason: error.message })
    }
  }
  const result = fixedClaim === undefined ? expanded
    : applyPrivateStorageApplicability({ expanded, contract, validatedReports: validated, claim: fixedClaim })
  return { ...result, contract: { requirements: contract.requirements, replacements: contract.replacements },
    ordinalDerivation: validation.matrices.filter(matrix => matrix.valid).map(matrix => ({ matrix: matrix.matrix, reportSha256: matrix.reportSha256 })) }
}
