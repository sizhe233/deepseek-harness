/** Test-only native evidence composition. This module never converts skipped or simulated work into a native pass. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const allowedScope = new Map([
  ['private-plugin-composition', 'separate-requirement'],
  ['windows-arm64', 'out-of-scope'],
  ['abrupt-power-loss', 'out-of-scope'],
])
const key = reference => JSON.stringify([reference.matrix, reference.row])

/** Attempt every declared independent matrix even if a previous launch, report or native case fails. */
export async function collectNativeMatrices(specifications, invoke) {
  assert.ok(Array.isArray(specifications) && specifications.length > 0)
  assert.equal(new Set(specifications.map(item => item.id)).size, specifications.length, 'Duplicate matrix specification')
  const results = []
  for (const specification of specifications) {
    try { results.push({ ...await invoke(specification), matrix: specification.id }) }
    catch (error) { results.push({ matrix: specification.id, exitCode: null, signal: null,
      timedOut: error?.code === 'ETIMEDOUT', error: error instanceof Error ? error.message : 'Unknown matrix invocation failure', rawReport: null }) }
  }
  return results
}

/** Validate actual report bytes and explicit subcase coverage; preserve original failed and blocked observations. */
export function evaluateNativeMatrices({ specifications, runs, requirements, replacements = [] }) {
  assert.ok(Array.isArray(specifications) && specifications.length > 0, 'Required matrix specifications are missing')
  assert.ok(Array.isArray(requirements) && requirements.length > 0, 'Required subcase inventory is missing')
  assert.ok(Array.isArray(runs) && Array.isArray(replacements))
  const specs = new Map()
  for (const item of specifications) {
    assert.ok(typeof item.id === 'string' && item.id.length > 0 && !specs.has(item.id), 'Invalid or duplicate matrix identity')
    assert.ok(sha256(item.entrySha256) && sha256(item.oracleSha256) && sha256(item.oracleSourceSha256), 'Expected native artifact identities are missing')
    assert.match(item.sourceSha, /^[0-9a-f]{40}$/u, 'Expected candidate source is missing')
    specs.set(item.id, item)
  }
  assert.equal(new Set(specifications.map(item => item.entrySha256)).size, 1, 'Matrices must share one packed entry')
  assert.equal(new Set(specifications.map(item => item.sourceSha)).size, 1, 'Matrices must share one candidate source')
  const requirementMap = new Map()
  for (const requirement of requirements) {
    assert.ok(typeof requirement.id === 'string' && requirement.id.length > 0 && !requirementMap.has(requirement.id), 'Invalid or duplicate subcase')
    assert.ok(Array.isArray(requirement.evidence) && requirement.evidence.length > 0, 'Subcase requires explicit evidence')
    const references = new Set()
    for (const reference of requirement.evidence) {
      assert.ok(specs.has(reference.matrix) && typeof reference.row === 'string' && reference.row.length > 0, 'Unknown evidence reference')
      assert.ok(!references.has(key(reference)), 'Duplicate evidence reference')
      references.add(key(reference))
    }
    requirementMap.set(requirement.id, requirement)
  }
  const replacementMap = new Map()
  for (const replacement of replacements) {
    assert.ok(specs.has(replacement.matrix) && typeof replacement.row === 'string' && replacement.row.length > 0)
    assert.ok(!replacementMap.has(key(replacement)), 'Duplicate placeholder replacement')
    assert.ok(Array.isArray(replacement.requirements) && replacement.requirements.length > 0, 'A placeholder cannot be waived without explicit subcases')
    assert.equal(new Set(replacement.requirements).size, replacement.requirements.length)
    for (const id of replacement.requirements) assert.ok(requirementMap.has(id), 'Unknown replacement subcase')
    replacementMap.set(key(replacement), replacement)
  }

  const errors = [], rows = new Map(), matrices = []
  for (const run of runs) if (!specs.has(run.matrix)) errors.push({ matrix: run.matrix, reason: 'Undeclared matrix result' })
  for (const specification of specifications) {
    const selected = runs.filter(run => run.matrix === specification.id)
    const evidence = { matrix: specification.id, exitCode: null, signal: null, timedOut: null, valid: false, reportSha256: null }
    matrices.push(evidence)
    try {
      assert.equal(selected.length, 1, 'Exactly one result is required for every matrix')
      const run = selected[0]
      evidence.exitCode = run.exitCode
      evidence.signal = run.signal ?? null
      evidence.timedOut = run.timedOut ?? null
      assert.ok(Object.hasOwn(run, 'signal'), 'Process signal observation is missing')
      assert.equal(run.timedOut, false, 'Matrix timed out or lacks timeout observation')
      assert.equal(run.error, undefined, 'Matrix invocation failed')
      assert.equal(run.signal, null, 'Matrix process was interrupted or lacks signal observation')
      assert.ok([0, 1, 2].includes(run.exitCode), 'Unexpected matrix exit code')
      assert.ok(typeof run.rawReport === 'string' && Buffer.byteLength(run.rawReport) > 0
        && Buffer.byteLength(run.rawReport) <= 8 * 1024 * 1024, 'Required report is missing or exceeds its bound')
      evidence.reportSha256 = digest(run.rawReport)
      const report = JSON.parse(run.rawReport)
      assert.equal(report.schemaVersion, 1, 'Unsupported native report schema')
      assert.equal(report.nativeExecution, true, 'Report does not establish real native execution')
      assert.equal(report.platform, 'win32', 'Unexpected native platform')
      assert.equal(report.architecture, 'x64', 'Untested native architecture')
      assert.equal(report.entrySha256, specification.entrySha256, 'Packed entry identity differs')
      assert.equal(report.oracleSha256, specification.oracleSha256, 'SDK oracle identity differs')
      assert.equal(report.sourceSha, specification.sourceSha, 'Candidate source differs')
      assert.equal(report.oracleSourceSha256, specification.oracleSourceSha256, 'SDK oracle source identity differs')
      assert.ok(Array.isArray(report.results) && report.results.length > 0, 'Native row inventory is missing')
      const names = new Set(), counts = { passed: 0, failed: 0, blocked: 0 }
      for (const row of report.results) {
        assert.ok(typeof row.name === 'string' && row.name.length > 0 && !names.has(row.name), 'Duplicate or invalid native row')
        names.add(row.name)
        assert.equal(typeof row.status, 'string', 'Native row status must be a string literal')
        if (allowedScope.has(row.name)) assert.equal(row.status, allowedScope.get(row.name), 'Untested or separate scope cannot count as a native pass')
        else {
          assert.ok(Object.hasOwn(counts, row.status), 'Unaccepted skipped or scope-excluded row')
          counts[row.status]++
        }
      }
      if (report.scope !== undefined) {
        assert.ok(Array.isArray(report.scope), 'Invalid native scope inventory')
        for (const row of report.scope) {
          assert.ok(allowedScope.has(row.name), 'Undeclared native scope exclusion')
          assert.equal(row.status, allowedScope.get(row.name), 'Untested or separate scope cannot count as a native pass')
        }
      }
      assert.deepEqual(report.summary, counts, 'Native report summary contradicts its rows')
      const expectedExit = counts.failed ? 1 : counts.blocked ? 2 : 0
      assert.equal(run.exitCode, expectedExit, 'Native exit and report status contradict each other')
      const acceptance = counts.failed ? 'failed' : counts.blocked ? 'partial' : 'complete'
      if (report.acceptance !== undefined) assert.equal(report.acceptance, acceptance, 'Contradictory acceptance label')
      if (report.complete !== undefined) assert.equal(report.complete, expectedExit === 0, 'Contradictory completion label')
      for (const row of report.results) rows.set(key({ matrix: specification.id, row: row.name }), { ...row, matrix: specification.id })
      evidence.valid = true
      evidence.summary = counts
    } catch (error) {
      errors.push({ matrix: specification.id, reason: error instanceof Error ? error.message : 'Invalid native report',
        ...(selected[0]?.error === undefined ? {} : { invocationError: selected[0].error }) })
    }
  }

  const subcases = requirements.map(requirement => {
    const observations = requirement.evidence.map(reference => {
      const observed = rows.get(key(reference))
      return observed ? { matrix: reference.matrix, row: reference.row, status: observed.status, reason: observed.reason ?? null }
        : { ...reference, status: 'missing', reason: 'Required row was not established by a valid native report' }
    })
    return { id: requirement.id, status: observations.every(row => row.status === 'passed') ? 'passed' : 'blocked', observations }
  })
  const fulfilled = new Set(subcases.filter(item => item.status === 'passed').map(item => item.id))
  const replaced = [], unresolved = []
  for (const replacement of replacements) {
    if (!rows.has(key(replacement))) errors.push({ matrix: replacement.matrix, row: replacement.row, reason: 'Mapped placeholder is missing from its valid native report' })
  }
  for (const [identity, row] of rows) {
    if (row.status === 'failed') { unresolved.push(row); continue }
    if (row.status !== 'blocked') continue
    const replacement = replacementMap.get(identity)
    if (replacement && replacement.requirements.every(id => fulfilled.has(id))) {
      replaced.push({ original: row, requiredSubcases: replacement.requirements })
    } else unresolved.push(row)
  }
  const complete = errors.length === 0 && unresolved.length === 0 && subcases.every(item => item.status === 'passed')
  return { schemaVersion: 1, complete, acceptance: complete ? 'complete' : errors.length || unresolved.some(row => row.status === 'failed') ? 'failed' : 'partial',
    matrices, subcases, replacedPlaceholders: replaced, unresolved, errors }
}
