/** Synthetic report-consistency tests only; these never establish native storage conformance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectNativeMatrices, evaluateNativeMatrices } from './private-storage-composite.mjs'

const sourceSha = 'a'.repeat(40)
const entrySha256 = 'b'.repeat(64)
const oracleSha256 = 'c'.repeat(64)
const oracleSourceSha256 = 'e'.repeat(64)
function fixture() {
  const specifications = ['primary', 'admission', 'boundary'].map(id => ({ id, entrySha256, oracleSha256, oracleSourceSha256, sourceSha }))
  const reports = {
    primary: [{ name: 'core', status: 'passed' }, { name: 'acl-placeholder', status: 'blocked', reason: 'Supplemental ACL cases must execute' },
      { name: 'windows-arm64', status: 'out-of-scope' }, { name: 'private-plugin-composition', status: 'separate-requirement' }],
    admission: [{ name: 'conditional', status: 'passed' }, { name: 'malformed', status: 'passed' }],
    boundary: [{ name: 'race', status: 'passed' }],
  }
  const runs = specifications.map(spec => {
    const results = reports[spec.id]
    const summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, results.filter(row => row.status === status).length]))
    const exitCode = summary.failed ? 1 : summary.blocked ? 2 : 0
    return { matrix: spec.id, exitCode, signal: null, timedOut: false, rawReport: JSON.stringify({ schemaVersion: 1, nativeExecution: true,
      platform: 'win32', architecture: 'x64', entrySha256, oracleSha256, oracleSourceSha256, sourceSha: spec.sourceSha,
      results, summary, complete: exitCode === 0, acceptance: exitCode === 1 ? 'failed' : exitCode === 2 ? 'partial' : 'complete' }) }
  })
  const requirements = [
    { id: 'native-core', evidence: [{ matrix: 'primary', row: 'core' }] },
    { id: 'conditional-acl', evidence: [{ matrix: 'admission', row: 'conditional' }] },
    { id: 'invalid-acl-submission', evidence: [{ matrix: 'admission', row: 'malformed' }] },
    { id: 'native-race', evidence: [{ matrix: 'boundary', row: 'race' }] },
  ]
  const replacements = [{ matrix: 'primary', row: 'acl-placeholder', requirements: ['conditional-acl', 'invalid-acl-submission'] }]
  return { specifications, runs, requirements, replacements }
}
function mutate(f, matrix, change, recompute = false) {
  const run = f.runs.find(item => item.matrix === matrix)
  const report = JSON.parse(run.rawReport)
  change(report)
  if (recompute) {
    report.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, report.results.filter(row => row.status === status).length]))
    run.exitCode = report.summary.failed ? 1 : report.summary.blocked ? 2 : 0
    report.complete = run.exitCode === 0
    report.acceptance = run.exitCode === 1 ? 'failed' : run.exitCode === 2 ? 'partial' : 'complete'
  }
  run.rawReport = JSON.stringify(report)
}

test('only explicit complete subcase evidence supersedes a retained broad placeholder', () => {
  const f = fixture(), result = evaluateNativeMatrices(f)
  assert.equal(result.complete, true)
  assert.equal(result.acceptance, 'complete')
  assert.equal(result.matrices[0].exitCode, 2, 'Original partial primary result is retained')
  assert.equal(result.replacedPlaceholders[0].original.status, 'blocked')
  assert.equal(result.replacedPlaceholders[0].original.reason, 'Supplemental ACL cases must execute')
  assert.deepEqual(result.replacedPlaceholders[0].requiredSubcases, ['conditional-acl', 'invalid-acl-submission'])
  assert.ok(result.matrices.every(matrix => matrix.valid && /^[a-f0-9]{64}$/.test(matrix.reportSha256)))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.unresolved, [])
})

test('an unmapped blocked row remains a blocker despite all mapped subcases passing', () => {
  const f = fixture()
  mutate(f, 'boundary', report => report.results.push({ name: 'inheritance', status: 'blocked', reason: 'Actual child has not run' }), true)
  const result = evaluateNativeMatrices(f)
  assert.equal(result.complete, false)
  assert.equal(result.acceptance, 'partial')
  assert.equal(result.unresolved[0].reason, 'Actual child has not run')
})

test('partial supplemental coverage cannot close a broad required area', () => {
  const f = fixture()
  mutate(f, 'admission', report => { report.results = report.results.filter(row => row.name !== 'malformed') }, true)
  const result = evaluateNativeMatrices(f)
  assert.equal(result.complete, false)
  assert.equal(result.replacedPlaceholders.length, 0)
  assert.equal(result.subcases.find(row => row.id === 'invalid-acl-submission').observations[0].status, 'missing')
  assert.ok(result.unresolved.some(row => row.name === 'acl-placeholder'))
})

test('a failing sibling matrix is fatal even if no required mapping references its extra failure', () => {
  const f = fixture()
  mutate(f, 'boundary', report => report.results.push({ name: 'cleanup', status: 'failed', reason: 'Owned handle leaked' }), true)
  const result = evaluateNativeMatrices(f)
  assert.equal(result.complete, false)
  assert.equal(result.acceptance, 'failed')
  assert.equal(result.unresolved[0].reason, 'Owned handle leaked')
})

for (const [name, change] of [
  ['missing report', f => { f.runs[1].rawReport = null }],
  ['missing matrix', f => { f.runs.pop() }],
  ['duplicate matrix', f => { f.runs.push({ ...f.runs[0] }) }],
  ['undeclared matrix', f => { f.runs.push({ ...f.runs[0], matrix: 'other' }) }],
  ['timeout with successful exit', f => { f.runs[1].timedOut = true }],
  ['missing timeout observation', f => { delete f.runs[1].timedOut }],
  ['missing signal observation', f => { delete f.runs[1].signal }],
  ['undefined own signal observation', f => { f.runs[1].signal = undefined }],
  ['interrupted process', f => { f.runs[1].signal = 'SIGKILL' }],
  ['failed launch', f => { f.runs[1].error = 'SDK process missing' }],
  ['invalid JSON', f => { f.runs[1].rawReport = '{' }],
  ['oversized report', f => { f.runs[1].rawReport = ' '.repeat(8 * 1024 * 1024 + 1) }],
  ['unknown process exit', f => { f.runs[1].exitCode = 134 }],
  ['partial exit reported green', f => { f.runs[0].exitCode = 0 }],
  ['successful report with failing exit', f => { f.runs[1].exitCode = 1 }],
]) test(`refuses ${name}`, () => {
  const f = fixture(); change(f)
  const result = evaluateNativeMatrices(f)
  assert.equal(result.complete, false)
  assert.equal(result.acceptance, 'failed')
  assert.ok(result.errors.length > 0)
})

for (const [name, change] of [
  ['mocked/native-unexecuted report', report => { report.nativeExecution = false }],
  ['different platform', report => { report.platform = 'linux' }],
  ['untested architecture', report => { report.architecture = 'arm64' }],
  ['different packed entry', report => { report.entrySha256 = 'd'.repeat(64) }],
  ['different SDK binary', report => { report.oracleSha256 = 'd'.repeat(64) }],
  ['missing source identity', report => { delete report.sourceSha }],
  ['malformed source identity', report => { report.sourceSha = { source: sourceSha } }],
  ['missing SDK source identity', report => { delete report.oracleSourceSha256 }],
  ['different SDK source identity', report => { report.oracleSourceSha256 = 'f'.repeat(64) }],
  ['different source', report => { report.sourceSha = 'd'.repeat(40) }],
  ['invented summary', report => { report.summary.passed++ }],
  ['contradictory acceptance', report => { report.acceptance = 'complete' }],
  ['contradictory completion', report => { report.complete = true }],
  ['duplicate native row', report => { report.results.push({ ...report.results[0] }) }],
  ['missing row status', report => { report.results.push({ name: 'undefined-status' }) }],
  ['unapproved skip', report => { report.results.push({ name: 'security', status: 'skipped' }) }],
  ['scope disguised as a pass', report => { report.results.find(row => row.name === 'windows-arm64').status = 'passed' }],
  ['hidden scope waiver', report => { report.scope = [{ name: 'native-security', status: 'out-of-scope' }] }],
]) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f, 'primary', change)
  assert.equal(evaluateNativeMatrices(f).complete, false)
  assert.ok(evaluateNativeMatrices(f).errors.some(error => error.matrix === 'primary'))
})

test('rejects missing, ambiguous or inconsistent mapping configuration', () => {
  for (const change of [
    f => { f.requirements = [] },
    f => { f.requirements.push(f.requirements[0]) },
    f => { f.requirements[0].evidence = [] },
    f => { f.requirements[0].evidence.push(f.requirements[0].evidence[0]) },
    f => { f.requirements[0].evidence[0].matrix = 'unknown' },
    f => { f.replacements[0].requirements = [] },
    f => { f.replacements[0].requirements.push('unreviewed') },
    f => { f.replacements.push(f.replacements[0]) },
    f => { delete f.specifications[1].sourceSha },
    f => { delete f.specifications[1].oracleSourceSha256 },
    f => { f.specifications[1].sourceSha = 'f'.repeat(40) },
    f => { f.specifications[0].entrySha256 = 'not-a-digest' },
    f => { f.specifications[0].entrySha256 = 'd'.repeat(64) },
  ]) {
    const f = fixture(); change(f)
    assert.throws(() => evaluateNativeMatrices(f))
  }
})

test('a mapped placeholder that disappears cannot silently waive its contract', () => {
  const f = fixture()
  f.replacements[0].row = 'missing-placeholder'
  const result = evaluateNativeMatrices(f)
  assert.equal(result.complete, false)
  assert.ok(result.errors.some(error => error.reason.includes('placeholder is missing')))
})

test('collector attempts every sibling after failed, blocked and throwing invocations', async () => {
  const seen = []
  const specifications = ['failed', 'blocked', 'throws', 'success'].map(id => ({ id }))
  const results = await collectNativeMatrices(specifications, async specification => {
    seen.push(specification.id)
    if (specification.id === 'throws') throw new Error('Missing report')
    return { exitCode: specification.id === 'failed' ? 1 : specification.id === 'blocked' ? 2 : 0, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.deepEqual(seen, specifications.map(item => item.id))
  assert.equal(results[2].error, 'Missing report')
  assert.equal(results[3].exitCode, 0)
  assert.equal(results.length, 4)
})

for (const status of [['failed'], ['blocked'], ['passed']]) {
  test(`rejects coercible array status ${JSON.stringify(status)} on an unmapped sibling`, () => {
    const f = fixture()
    mutate(f, 'boundary', report => {
      report.results.push({ name: 'unmapped-sibling', status })
      report.summary[status[0]]++
      report.complete = status[0] === 'passed'
      report.acceptance = status[0] === 'failed' ? 'failed' : status[0] === 'blocked' ? 'partial' : 'complete'
    })
    f.runs.find(run => run.matrix === 'boundary').exitCode = status[0] === 'failed' ? 1 : status[0] === 'blocked' ? 2 : 0
    const result = evaluateNativeMatrices(f)
    assert.equal(result.complete, false)
    assert.equal(result.acceptance, 'failed')
    assert.ok(result.errors.some(error => error.reason.includes('string literal')))
  })
}
