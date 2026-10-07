/** Synthetic applicability controls. No hypothetical report is native evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PRIVATE_STORAGE_CLAIM, validatePrivateStorageClaim } from './private-storage-applicability.mjs'
import { evaluatePrivateStorageNative, privateStorageNativeContract } from './private-storage-native-contract.mjs'
import { syntheticOwnerReport, syntheticSpecifications, syntheticAbsentDescriptor } from './private-storage-native-test-fixture.mjs'

const conditional = ['admission/unsupported-volume-admission', 'admission/real-storage-failure',
  'admission/volume-mount-point-admission', 'admission/cloud-reparse-admission',
  'admission/authorized-remote-volume-admission', 'boundary/executing-target-publication',
  'directory/cleanup-genuine-kernel-release-failure']
const na = 'directory/cleanup-koffi-free-failure'
const volume = () => ({ root: 'C:\\', driveType: 3, metadataAttempted: true, metadataAvailable: true,
  win32Error: 0, filesystem: 'NTFS', flags: 0x88, readOnly: false, persistentAcls: true, reparsePoints: true, remote: false })

function fixture() {
  const baselines = ['read', 'publish'].map(mode => ({ name: `native-${mode}-allocation-baseline`, status: 'passed',
    detail: { allocations: 2, exposures: 1 } }))
  const contract = privateStorageNativeContract(new Map([['owner-faults', { results: baselines }]]))
  const specifications = syntheticSpecifications()
  const reports = new Map(specifications.map(spec => [spec.id, { schemaVersion: 1, nativeExecution: true, platform: 'win32', architecture: 'x64',
    ...spec, results: [] }]))
  for (const requirement of contract.requirements) {
    for (const ref of requirement.evidence.filter(ref => ref.matrix !== 'owner-faults')) reports.get(ref.matrix).results.push({ name: ref.row,
      status: conditional.includes(requirement.id) || requirement.id === na ? 'blocked' : 'passed', reason: 'Synthetic case observation' })
  }
  for (const replacement of contract.replacements) reports.get(replacement.matrix).results.push({ name: replacement.row, status: 'blocked', reason: 'Original broad placeholder' })
  reports.set('owner-faults', syntheticOwnerReport(specifications.at(-1), { read: { allocations: 2, exposures: 1 }, publish: { allocations: 2, exposures: 1 } }))
  reports.get('primary').results.find(row => row.name === 'reject-absent-dacl-without-repair').detail = syntheticAbsentDescriptor()
  reports.get('primary').filesystem = { name: 'NTFS', flags: 0x88, deviceType: 7, deviceCharacteristics: 0 }
  reports.get('admission').diagnostics = { inventory: { complete: true, readOnly: true,
    inventoryScope: 'mounted-drive-letters', privilegesEnabled: false, volumes: [volume()] } }
  const seal = (claim = PRIVATE_STORAGE_CLAIM) => ({ specifications, claim, runs: specifications.map(spec => {
    const report = reports.get(spec.id)
    report.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, report.results.filter(row => row.status === status).length]))
    if (spec.id === 'owner-faults') report.acceptance = report.summary.failed ? 'failed' : 'partial'
    return { matrix: spec.id, signal: null, timedOut: false, exitCode: report.summary.failed ? 1 : report.summary.blocked ? 2 : 0, rawReport: JSON.stringify(report) }
  }) })
  const row = id => { const ref = contract.requirements.find(row => row.id === id).evidence[0]; return reports.get(ref.matrix).results.find(row => row.name === ref.row) }
  return { reports, seal, row, contract }
}

test('ordinary profile preserves all expanded rows and raw facts without counting inactive conditions or N/A as passes', () => {
  const f = fixture(), input = f.seal(), result = evaluatePrivateStorageNative(input)
  assert.equal(result.complete, true)
  assert.equal(result.expandedComplete, false)
  assert.equal(result.expandedEvidence.complete, false)
  assert.equal(result.applicabilitySummary.mustPass, 145) // 139 fixed + six exact observed allocation/view ordinals.
  assert.equal(result.applicabilitySummary.conditional, 7)
  assert.equal(result.applicabilitySummary.notApplicable, 1)
  assert.equal(result.applicabilitySummary.passed, 145)
  assert.equal(result.applicabilitySummary.notRequired, 8)
  assert.equal(result.subcases.length, f.contract.requirements.length)
  assert.equal(result.inactiveObservations.length, 8)
  assert.equal(result.replacedPlaceholders.length, 36)
  assert.ok(result.replacedPlaceholders.every(row => row.original.status === 'blocked'))
  assert.ok(result.matrices.some(matrix => matrix.exitCode === 2))
  assert.equal(result.subcases.find(row => row.id === na).status, 'not-applicable')
  assert.equal(evaluatePrivateStorageNative({ ...input, claim: undefined }).complete, false)
})

test('unestablished dynamic baselines retain 141 mandatory requirements, never a zero-fault inventory', () => {
  const f = fixture()
  for (const row of f.reports.get('owner-faults').results) if (row.name.endsWith('allocation-baseline')) { row.status = 'blocked'; row.reason = 'Synthetic blocked baseline' }
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false)
  assert.equal(result.applicabilitySummary.mustPass, 141)
  for (const mode of ['read', 'publish']) assert.equal(result.subcases.find(row => row.id === `boundary/native-${mode}-allocation-fault-inventory-unestablished`).required, true)
})

for (const id of conditional) test(`declaring ${id} activates its exact still-blocked obligation`, () => {
  const f = fixture(), result = evaluatePrivateStorageNative(f.seal({ ...PRIVATE_STORAGE_CLAIM, requiredConditions: [id] }))
  assert.equal(result.complete, false)
  assert.equal(result.subcases.find(row => row.id === id).required, true)
  assert.equal(result.subcases.find(row => row.id === id).status, 'blocked')
  f.row(id).status = 'passed'
  const available = evaluatePrivateStorageNative(f.seal({ ...PRIVATE_STORAGE_CLAIM, requiredConditions: [id] }))
  if (id.startsWith('directory/')) {
    assert.equal(available.complete, false, 'No safe genuine cleanup-failure fixture exists; a passing label must be rejected')
    assert.ok(available.errors.some(row => row.matrix === 'owner-faults'))
  } else assert.equal(available.complete, true)
})

for (const id of conditional) test(`an actual failure remains fatal for otherwise conditional ${id}`, () => {
  const f = fixture(); f.row(id).status = 'failed'
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed')
  if (id.startsWith('directory/')) {
    assert.ok(result.errors.some(row => row.matrix === 'owner-faults'), 'An unsupported cleanup claim invalidates its report')
    assert.equal(JSON.parse(f.seal().runs.at(-1).rawReport).results.find(row => row.name === id.split('/')[1]).status, 'failed')
  } else {
    assert.equal(result.subcases.find(row => row.id === id).required, true)
    assert.equal(result.applicabilitySummary.activatedConditional, 1)
    assert.ok(result.unresolved.some(row => `${row.matrix}/${row.name}` === id && row.status === 'failed'))
  }
})

for (const change of [
  item => { item.filesystem = 'FAT32' },
  item => { item.flags |= 0x80000; item.readOnly = true },
  item => { item.flags &= ~8; item.persistentAcls = false },
  item => { item.driveType = 6 },
]) test('an observed available unsupported local volume activates its rejection probe', () => {
  const f = fixture(); change(f.reports.get('admission').diagnostics.inventory.volumes[0])
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false)
  assert.equal(result.volumeInventory.availableUnsupported.length, 1)
  assert.equal(result.subcases.find(row => row.id === conditional[0]).required, true)
})

test('unreadable media and unqueried remote mappings retain observations and are not falsely called absent', () => {
  const f = fixture(), volumes = f.reports.get('admission').diagnostics.inventory.volumes
  volumes.push({ ...volume(), root: 'D:\\', driveType: 5, metadataAvailable: false, win32Error: 21,
    filesystem: '', flags: 0, persistentAcls: false, reparsePoints: false })
  volumes.push({ ...volume(), root: 'Z:\\', driveType: 4, metadataAttempted: false, metadataAvailable: false,
    filesystem: '', flags: 0, persistentAcls: false, reparsePoints: false, remote: true, metadataSkipped: 'remote-or-unknown-drive' })
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, true)
  assert.equal(result.volumeInventory.unavailable.length, 1)
  assert.equal(result.volumeInventory.unqueried.length, 1)
  assert.match(result.volumeInventory.limitation, /do not establish absence/)
  assert.equal(evaluatePrivateStorageNative(f.seal({ ...PRIVATE_STORAGE_CLAIM, requiredConditions: [conditional[4]] })).complete, false)
})

for (const change of [
  report => { delete report.diagnostics },
  report => { report.diagnostics.inventory.complete = false },
  report => { report.diagnostics.inventory.readOnly = false },
  report => { report.diagnostics.inventory.privilegesEnabled = true },
  report => { report.diagnostics.inventory.volumes = [] },
  report => { report.diagnostics.inventory.volumes.push(volume()) },
  report => { report.diagnostics.inventory.volumes[0].metadataAttempted = false },
  report => { report.diagnostics.inventory.volumes[0].persistentAcls = false },
  report => { report.diagnostics.inventory.volumes[0].metadataAvailable = false },
  report => { report.diagnostics.inventory.volumes[0].driveType = 4 },
]) test('missing or contradictory capability inventory cannot establish an inactive condition', () => {
  const f = fixture(); change(f.reports.get('admission'))
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed')
  assert.equal(result.subcases.find(row => row.id === conditional[0]).required, true)
})

for (const change of [
  report => { delete report.filesystem },
  report => { report.filesystem.name = 'ReFS' },
  report => { report.filesystem.flags = 0 },
  report => { report.filesystem.flags |= 0x80000 },
  report => { report.filesystem.deviceType = 20 },
  report => { report.filesystem.deviceCharacteristics = 0x40 },
  report => { report.filesystem.deviceCharacteristics = 0x10 },
]) test('selected storage outside the declared supported backing fails closed with a specific diagnostic', () => {
  const f = fixture(); change(f.reports.get('primary'))
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed')
  assert.ok(result.errors.some(row => row.matrix === 'primary' && row.reason.length > 0))
})

test('every mandatory row, including each dynamic ordinal, independently remains blocking', () => {
  const original = fixture(), rows = evaluatePrivateStorageNative(original.seal()).subcases.filter(row => row.required)
  for (const { id } of rows) {
    const f = fixture(); f.row(id).status = 'blocked'; f.row(id).reason = 'Synthetic required case unavailable'
    if (id.includes('native-one-shot-')) {
      const inventory = f.row(`boundary/native-${id.includes('-publish-') ? 'publish' : 'read'}-allocation-baseline`)
      const row = f.reports.get('owner-faults').results.find(row => row.name === inventory.name.replace('-baseline', '-fault-inventory'))
      row.status = 'blocked'; row.reason = 'Synthetic ordinal unavailable'
    }
    const result = evaluatePrivateStorageNative(f.seal())
    assert.equal(result.complete, false, id)
    assert.equal(result.subcases.find(row => row.id === id).required, true, id)
  }
})

for (const status of ['failed', 'blocked']) test(`an undeclared diagnostic ${status} row remains fatal or incomplete`, () => {
  const f = fixture(); f.reports.get('boundary').results.push({ name: 'unmapped-cleanup-obligation', status, reason: 'Original failure' })
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false)
  assert.ok(result.unresolved.some(row => row.name === 'unmapped-cleanup-obligation' && row.status === status))
})

for (const status of ['passed', 'failed']) test(`N/A Koffi free-failure cannot silently admit a ${status} row`, () => {
  const f = fixture(); f.row(na).status = status
  const result = evaluatePrivateStorageNative(f.seal())
  assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed')
  assert.equal(result.subcases.find(row => row.id === na).status, 'not-applicable')
  assert.ok(result.errors.some(row => row.matrix === 'owner-faults'))
  assert.equal(result.subcases.find(row => row.id === 'directory/directory-enumeration-baseline').status, 'blocked')
})

for (const claim of [undefined, null, {}, { ...PRIVATE_STORAGE_CLAIM, schemaVersion: 2 },
  { ...PRIVATE_STORAGE_CLAIM, profile: 'all-windows-filesystems' }, { ...PRIVATE_STORAGE_CLAIM, exclude: ['token-denial'] },
  { ...PRIVATE_STORAGE_CLAIM, requiredConditions: ['unknown'] }, { ...PRIVATE_STORAGE_CLAIM, requiredConditions: [na] },
  { ...PRIVATE_STORAGE_CLAIM, requiredConditions: [conditional[0], conditional[0]] }]) test('undeclared profiles, exclusions and conditions are rejected', () => {
  assert.throws(() => validatePrivateStorageClaim(claim))
})

test('exit/status contradictions, wrong source and unexecuted reports remain fatal', () => {
  for (const mutation of [run => { run.exitCode = 0 }, run => { run.rawReport = null },
    run => { const report = JSON.parse(run.rawReport); report.sourceSha = 'f'.repeat(40); run.rawReport = JSON.stringify(report) },
    run => { const report = JSON.parse(run.rawReport); report.nativeExecution = false; run.rawReport = JSON.stringify(report) }]) {
    const f = fixture(), input = f.seal(); mutation(input.runs.find(row => row.matrix === 'admission'))
    const result = evaluatePrivateStorageNative(input)
    assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed')
  }
})

test('an omitted active condition is missing evidence rather than an inactive case', () => {
  const f = fixture(), report = f.reports.get('admission')
  report.results = report.results.filter(row => row.name !== 'cloud-reparse-admission')
  const result = evaluatePrivateStorageNative(f.seal({ ...PRIVATE_STORAGE_CLAIM, requiredConditions: [conditional[3]] }))
  assert.equal(result.complete, false)
  assert.equal(result.subcases.find(row => row.id === conditional[3]).observations[0].status, 'missing')
})

test('the claim and exact native reports are snapshotted before evidence derivation', () => {
  const f = fixture(), claim = { ...PRIVATE_STORAGE_CLAIM, requiredConditions: [conditional[3]] }, input = f.seal(claim)
  let reads = 0
  Object.defineProperty(input.runs[0], 'rawReport', { enumerable: true, get() { reads++; claim.requiredConditions.length = 0; return JSON.stringify(f.reports.get('primary')) } })
  const result = evaluatePrivateStorageNative(input)
  assert.equal(reads, 1); assert.equal(result.complete, false)
  assert.deepEqual(result.claim.requiredConditions, [conditional[3]])
})
