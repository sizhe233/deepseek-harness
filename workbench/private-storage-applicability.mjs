/** Explicit applicability for ordinary Windows x64 local-NTFS private byte storage. */
import assert from 'node:assert/strict'

export const PRIVATE_STORAGE_CLAIM = Object.freeze({ schemaVersion: 1,
  profile: 'ordinary-local-ntfs-private-bytes-v1', requiredConditions: Object.freeze([]) })

const conditional = new Map([
  ['admission/unsupported-volume-admission', 'An authorized available local unsupported volume, or a declared unsupported-volume deployment'],
  ['admission/real-storage-failure', 'An authorized isolated storage-failure fixture or a declared fault-stack validation claim'],
  ['admission/volume-mount-point-admission', 'A declared mounted-volume deployment or an authorized real mount fixture'],
  ['admission/cloud-reparse-admission', 'A declared cloud-placeholder deployment or an authorized genuine provider fixture'],
  ['admission/authorized-remote-volume-admission', 'A declared authorized remote deployment or an authorized remote fixture'],
  ['boundary/executing-target-publication', 'A declared use replacing a running executable or mapped image'],
  ['directory/cleanup-genuine-kernel-release-failure', 'An adopted safe real-refusal fixture or a supported environment supplying that failure'],
])
const notApplicable = 'directory/cleanup-koffi-free-failure'
const freeReason = 'Pinned Koffi 3.1.1 free(value):void has no recoverable failure result for a valid owned allocation; actual alloc/view ownership and all observed ordinals remain mandatory'
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
const identity = reference => JSON.stringify([reference.matrix, reference.row])

/** Validate a candidate-bound declaration; it can activate conditions but cannot exclude arbitrary rows. */
export function validatePrivateStorageClaim(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Explicit private-storage acceptance claim is required')
  assert.deepEqual(Object.keys(value).sort(), ['profile', 'requiredConditions', 'schemaVersion'], 'Undeclared acceptance claim fields')
  assert.equal(value.schemaVersion, 1, 'Unsupported acceptance claim schema')
  assert.equal(value.profile, PRIVATE_STORAGE_CLAIM.profile, 'Unsupported private-storage acceptance profile')
  assert.ok(Array.isArray(value.requiredConditions), 'Explicit required condition inventory is missing')
  assert.equal(new Set(value.requiredConditions).size, value.requiredConditions.length, 'Duplicate required condition')
  for (const id of value.requiredConditions) assert.ok(conditional.has(id), 'Unknown conditional requirement; mandatory rows cannot be excluded')
  return Object.freeze({ schemaVersion: 1, profile: value.profile, requiredConditions: Object.freeze([...value.requiredConditions].sort()) })
}

function localVolumeInventory(report) {
  const inventory = report?.diagnostics?.inventory
  assert.ok(inventory && inventory.complete === true && inventory.readOnly === true
    && inventory.inventoryScope === 'mounted-drive-letters' && inventory.privilegesEnabled === false, 'Required read-only mounted-volume inventory is absent or invalid')
  assert.ok(Array.isArray(inventory.volumes) && inventory.volumes.length > 0 && inventory.volumes.length <= 26, 'Mounted-volume inventory has an invalid size')
  const roots = new Set(), availableUnsupported = [], unavailable = [], unqueried = []
  for (const volume of inventory.volumes) {
    assert.ok(volume && typeof volume.root === 'string' && /^[A-Z]:\\$/iu.test(volume.root), 'Invalid mounted-volume root')
    assert.ok(!roots.has(volume.root.toUpperCase()), 'Duplicate mounted-volume root'); roots.add(volume.root.toUpperCase())
    assert.ok(Number.isInteger(volume.driveType) && volume.driveType >= 0 && volume.driveType <= 6, 'Invalid mounted drive type')
    assert.equal(volume.remote, volume.driveType === 4, 'Contradictory remote-volume classification')
    assert.equal(volume.metadataAttempted, [2, 3, 5, 6].includes(volume.driveType), 'Unexpected local metadata query policy')
    assert.equal(typeof volume.metadataAvailable, 'boolean', 'Missing metadata availability observation')
    assert.ok(uint32(volume.win32Error) && uint32(volume.flags), 'Invalid volume result or flags')
    assert.equal(typeof volume.filesystem, 'string', 'Missing filesystem observation')
    assert.equal(volume.readOnly, Boolean(volume.flags & 0x80000), 'Contradictory read-only volume flag')
    assert.equal(volume.persistentAcls, Boolean(volume.flags & 8), 'Contradictory ACL volume flag')
    assert.equal(volume.reparsePoints, Boolean(volume.flags & 0x80), 'Contradictory reparse volume flag')
    if (!volume.metadataAttempted) {
      assert.equal(volume.metadataAvailable, false, 'Remote or unknown volume was unexpectedly queried')
      assert.equal(volume.metadataSkipped, 'remote-or-unknown-drive', 'Unqueried volume reason is missing')
      unqueried.push(volume)
    } else if (!volume.metadataAvailable) {
      assert.notEqual(volume.win32Error, 0, 'Unavailable local metadata requires its actual error')
      unavailable.push(volume)
    } else {
      assert.equal(volume.win32Error, 0, 'Available metadata contradicts its error')
      assert.ok(volume.filesystem.length > 0, 'Available filesystem name is missing')
      if (volume.filesystem !== 'NTFS' || volume.readOnly || !volume.persistentAcls || volume.driveType === 6) availableUnsupported.push(volume)
    }
  }
  return { scope: inventory.inventoryScope, availableUnsupported, unavailable, unqueried,
    limitation: 'Only readable mounted local drive letters establish available fixtures; unqueried or unavailable media do not establish absence of other storage classes' }
}

function checkSelectedFilesystem(report) {
  const observed = report?.filesystem
  assert.ok(observed, 'Selected private root filesystem facts are missing')
  assert.equal(observed.name, 'NTFS', 'Selected storage is outside the declared NTFS profile')
  assert.ok(uint32(observed.flags) && (observed.flags & 8) !== 0 && (observed.flags & 0x80000) === 0, 'Selected storage lacks writable persistent ACLs')
  assert.equal(observed.deviceType, 7, 'Selected storage is not a disk filesystem')
  assert.ok(uint32(observed.deviceCharacteristics) && (observed.deviceCharacteristics & 0x305a) === 0, 'Selected storage is remote, virtual, read-only, write-once or otherwise outside the admitted backing policy')
  return observed
}

/** Retain strict expanded evidence while deciding only the explicit candidate-bound local-storage claim. */
export function applyPrivateStorageApplicability({ expanded, contract, validatedReports, claim }) {
  const declared = validatePrivateStorageClaim(claim)
  assert.ok(validatedReports instanceof Map, 'Validated exact-report map is required')
  const errors = [...expanded.errors], decisions = new Map()
  let volumes = null, selectedFilesystem = null
  try { volumes = localVolumeInventory(validatedReports.get('admission')) }
  catch (error) { errors.push({ matrix: 'admission', reason: error.message }) }
  try { selectedFilesystem = checkSelectedFilesystem(validatedReports.get('primary')) }
  catch (error) { errors.push({ matrix: 'primary', reason: error.message }) }
  const ids = new Set(contract.requirements.map(item => item.id))
  for (const id of [...conditional.keys(), notApplicable]) assert.ok(ids.has(id), 'Applicability mapping refers to an absent contract row')
  const subcases = expanded.subcases.map(item => {
    let classification = 'must-pass', required = true, basis = 'Ordinary-user security, lifecycle or modeled error guarantee'
    if (conditional.has(item.id)) {
      classification = 'conditional'
      const activation = []
      if (declared.requiredConditions.includes(item.id)) activation.push('Explicit candidate-bound declared use or authorized fixture')
      if (item.observations.some(row => row.status === 'passed' || row.status === 'failed')) activation.push('Actual native scenario was attempted')
      if (item.id === 'admission/unsupported-volume-admission') {
        if (!volumes) activation.push('Required volume inventory is unestablished')
        else if (volumes.availableUnsupported.length) activation.push('Read-only inventory found an available local unsupported volume')
      }
      required = activation.length > 0
      basis = required ? activation.join('; ') : 'Outside the explicit ordinary-local-NTFS private-bytes claim; no authorized available scenario was established'
    } else if (item.id === notApplicable) {
      classification = 'not-applicable'; required = false; basis = freeReason
      if (item.observations.some(row => row.status === 'passed')) errors.push({ id: item.id, reason: 'An undefined Koffi free-failure scenario cannot be counted as a native pass' })
    }
    const decision = { ...item, classification, required, basis,
      ...(conditional.has(item.id) ? { activationRule: conditional.get(item.id) } : {}),
      status: required ? item.status : classification === 'not-applicable' ? 'not-applicable' : 'not-required-for-declared-use' }
    decisions.set(item.id, decision)
    return decision
  })
  const accepted = id => {
    const item = decisions.get(id)
    return item && (item.status === 'passed' || !item.required)
  }
  const optionalReferences = new Set(contract.requirements.filter(item => !decisions.get(item.id).required).flatMap(item => item.evidence.map(identity)))
  const replacements = new Map(contract.replacements.map(item => [identity(item), item]))
  const resolved = expanded.replacedPlaceholders.map(item => ({ ...item, resolution: 'all-expanded-subcases-passed' }))
  const unresolved = [], inactiveObservations = []
  for (const row of expanded.unresolved) {
    // Actual failures are never excused by applicability, including N/A and diagnostic rows.
    if (row.status !== 'blocked') { unresolved.push(row); continue }
    const reference = { matrix: row.matrix, row: row.name }, replacement = replacements.get(identity(reference))
    if (replacement && replacement.requirements.every(accepted)) {
      resolved.push({ original: row, requiredSubcases: replacement.requirements, resolution: 'explicit-declared-profile-subcases-satisfied',
        decisions: replacement.requirements.map(id => ({ id, status: decisions.get(id).status, basis: decisions.get(id).basis })) })
    } else if (optionalReferences.has(identity(reference))) inactiveObservations.push(row)
    else unresolved.push(row)
  }
  const complete = errors.length === 0 && unresolved.length === 0 && subcases.every(item => item.status === 'passed' || !item.required)
  return { ...expanded, complete,
    acceptance: complete ? 'complete' : errors.length || unresolved.some(row => row.status === 'failed') ? 'failed' : 'partial',
    completionMeaning: 'All requirements applicable to the explicit candidate-bound profile passed; expanded evidence and separate merge requirements remain distinct',
    claim: declared, selectedFilesystem, volumeInventory: volumes, expandedComplete: expanded.complete, expandedEvidence: expanded,
    subcases, errors, unresolved, replacedPlaceholders: resolved, inactiveObservations,
    applicabilitySummary: {
      mustPass: subcases.filter(row => row.classification === 'must-pass').length,
      conditional: subcases.filter(row => row.classification === 'conditional').length,
      activatedConditional: subcases.filter(row => row.classification === 'conditional' && row.required).length,
      notApplicable: subcases.filter(row => row.classification === 'not-applicable').length,
      passed: subcases.filter(row => row.status === 'passed').length,
      notRequired: subcases.filter(row => !row.required).length,
    } }
}
