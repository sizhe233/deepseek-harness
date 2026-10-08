/** Test-only internal-fault matrix. Packed Worker/security/sharing/inheritance acceptance remains separate. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createFixtureRoot, Blocked, fixtureEnvironment, oracle, startChild } from './boundary-support.mjs'
import { oracleBinding } from './directory-boundary-support.mjs'
import { ownerBinding } from './owner-observer.mjs'
import { ownerFaultCases, ownerFaultBlockedCases, ownerFaultBinding, ownerSourceBinding, ownerOrdinalCases,
  ownerOrdinalMapping, ownerSummary, ownerFileDigest, ownerDigest, validateOwnerFaultReport, validateOwnerFaultResult } from './owner-fault-support.mjs'

const { values } = parseArgs({ options: { fixture: { type: 'string' }, entry: { type: 'string' }, oracle: { type: 'string' },
  report: { type: 'string' }, 'source-sha': { type: 'string' } }, allowPositionals: false })
assert.ok(values.report && isAbsolute(values.report), '--report must be an absolute fresh file')
for (const input of [values.fixture, values.entry, values.oracle].filter(Boolean)) { assert.ok(isAbsolute(input)); assert.notEqual(input, values.report) }
const source = ownerSourceBinding()
const report = { schemaVersion: 1, evidence: 'source-instrumented-native-owner-faults', packedProductionBinaryExecution: false,
  nativeExecution: false, platform: process.platform, architecture: process.arch, node: process.version,
  sourceSha: values['source-sha'] ?? process.env.CANDIDATE_SHA ?? null, ...source, ordinalMapping: ownerOrdinalMapping,
  results: ownerFaultCases.map(name => ({ name, status: 'blocked', reason: 'Actual Windows x64 source-instrumented fixture has not executed' })),
  separateRequirements: ['packed-production-native-binary', 'packed-worker-cleanup', 'packed-security', 'packed-sharing', 'packed-inheritance'],
}
const worker = fileURLToPath(new URL('owner-fault-worker.mjs', import.meta.url))
const oldBytes = Buffer.from('synthetic original owner-fault record\n')
const newBytes = Buffer.from('synthetic source-instrumented replacement\n')
let temporary, env, token, ordinal = 0
const children = new Set(), dynamicRows = []
const replace = (name, fields) => { const index = report.results.findIndex(row => row.name === name); report.results[index] = { name, ...fields } }
const facts = (path, directory) => {
  const data = oracle(values.oracle, env, 'inspect', path)
  assert.equal(data.ownerSid, token.userSid); assert.equal(data.daclProtected, true)
  assert.equal(data.daclPresent, true); assert.equal(data.daclNull, false); assert.equal(data.reparseTag, 0)
  assert.equal(data.directory, directory); if (!directory) assert.equal(data.links, 1)
  assert.deepEqual(data.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })),
    [{ type: 0, flags: directory ? 3 : 0, mask: 0x001f01ff, sid: token.userSid }])
  return { identity: data.identity, descriptorHex: data.descriptorHex, ...(directory ? {} : { bytesHex: readFileSync(path).toString('hex') }) }
}
const snapshot = root => ({ root: facts(root, true), record: facts(join(root, 'record.bin'), false), lease: facts(join(root, 'writer.lock'), false) })
async function childRun(root, scenario) {
  const child = startChild(process.execPath, [worker, values.entry, values.fixture, root, scenario], env)
  children.add(child)
  try {
    const detail = await child.next(30000); await child.complete()
    await assert.rejects(child.next(1), /already exited/u)
    assert.equal(child.settled, true)
    return detail
  } finally { await child.kill(); if (child.settled) children.delete(child) }
}
async function runCase(name) {
  const root = join(temporary, `case-${++ordinal}`)
  oracle(values.oracle, env, 'create', root, 'directory', 'private')
  for (const leaf of ['record.bin', 'writer.lock']) oracle(values.oracle, env, 'create', join(root, leaf), 'file', 'private')
  writeFileSync(join(root, 'record.bin'), oldBytes)
  const before = snapshot(root)
  const detail = await childRun(root, name)
  try {
    if (detail.actualPendingRequest) throw new Blocked('Actual kernel pending I/O was observed; this fixture supports only return/completion injection after a synchronously completed real call')
    validateOwnerFaultResult(detail, name)
    if (detail.outcome.readSha256) assert.equal(detail.outcome.readSha256, ownerDigest(oldBytes))
  } catch (error) { error.observation = detail; throw error }
  assert.deepEqual(readdirSync(root).sort(), ['record.bin', 'writer.lock'], 'No unpublished staging entry may remain')
  const after = snapshot(root)
  assert.deepEqual(after.root, before.root); assert.deepEqual(after.lease, before.lease)
  assert.equal(after.record.descriptorHex, before.record.descriptorHex)
  const publishing = name.startsWith('native-publish-') || name.startsWith('native-one-shot-publish-')
  if (!publishing || detail.outcome.receipt?.publication === 'not-published') assert.deepEqual(after, before)
  else {
    assert.ok([oldBytes.toString('hex'), newBytes.toString('hex')].includes(after.record.bytesHex))
    if (detail.outcome.ok || detail.outcome.receipt?.publication === 'published') assert.equal(after.record.bytesHex, newBytes.toString('hex'))
  }
  renameSync(root, `${root}-released`); renameSync(`${root}-released`, root)
  const verifier = await childRun(root, 'verify')
  assert.equal(verifier.outcome.ok, true); assert.deepEqual(verifier.outcome.leaseIdentity, before.lease.identity)
  assert.equal(verifier.liveNativeHandles, 0); assert.equal(verifier.protocolViolations, 0)
  return { ...detail, sdkBefore: before, sdkAfter: after, rootRenamedAfterChildExit: true, leaseReacquiredAfterChildExit: true,
    originalPrivateDescriptorsRetained: true, originalIdentitiesAndBytesRetained: JSON.stringify(before) === JSON.stringify(after) }
}
async function row(name) {
  try { return { name, status: 'passed', detail: await runCase(name) } }
  catch (error) { return { name, status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message, ...(error.observation ? { observation: error.observation } : {}) } }
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Windows SDK/native execution unavailable on this platform; portable source/report tests confer zero native passes')
  if (!values.fixture || !values.entry || !values.oracle) throw new Blocked('Native execution requires --fixture, --entry, and --oracle from the same candidate')
  assert.match(report.sourceSha ?? '', /^[a-f0-9]{40}$/u)
  const fixture = ownerFaultBinding(values.fixture), packed = ownerBinding(values.entry)
  const sdkBinding = oracleBinding(values.oracle)
  Object.assign(report, sdkBinding, { fixtureBinarySha256: fixture.fixtureBinarySha256, fixtureBuildSha256: fixture.fixtureBuildSha256,
    compilerLogSha256: fixture.compilerLogSha256, compilerSha256: fixture.compilerSha256, entrySha256: ownerFileDigest(values.entry),
    productionBinarySha256: packed.sha256, packedInventorySha256: packed.inventorySha256, oracleCompilerLogSha256: sdkBinding.compilerLogSha256 })
  report.nativeExecution = true
  report.temporaryRoot = createFixtureRoot('dsh-owner-fault-')
  temporary = report.temporaryRoot.path
  const home = join(temporary, 'home'); mkdirSync(home); env = fixtureEnvironment(home, temporary)
  token = oracle(values.oracle, env, 'token')
  for (const name of ownerFaultCases.filter(value => !value.endsWith('-allocation-fault-inventory'))) {
    const result = await row(name); replace(name, result)
    if (children.size) throw new Error('Owned native child teardown did not settle')
  }
  for (const mode of ['read', 'publish']) {
    const baseline = report.results.find(result => result.name === `native-${mode}-allocation-baseline`)
    const inventory = `native-${mode}-allocation-fault-inventory`
    if (baseline.status !== 'passed') { replace(inventory, { status: 'blocked', reason: 'Native allocation/exposure baseline did not pass; required ordinal counts remain unknown' }); continue }
    const requiredCases = ownerOrdinalCases(mode, baseline.detail), results = []
    for (const name of requiredCases) { results.push(await row(name)); if (children.size) throw new Error('Owned native ordinal child teardown did not settle') }
    dynamicRows.push(...results)
    const status = results.every(result => result.status === 'passed') ? 'passed' : results.some(result => result.status === 'failed') ? 'failed' : 'blocked'
    replace(inventory, { status, requiredCases, ...(status === 'passed' ? {} : { reason: 'At least one observed native allocation/exposure ordinal did not pass' }) })
  }
} catch (error) {
  report.prerequisiteFailure = error.message
  for (const result of report.results) if (result.status === 'blocked' && !result.name.endsWith('-fault-inventory')) {
    result.status = error instanceof Blocked ? 'blocked' : 'failed'; result.reason = error.message
  }
} finally {
  for (const child of children) { try { await child.kill() } catch (error) { report.teardownFailure = error.message } }
  if (temporary && [...children].some(child => !child.settled)) report.teardownFailure ??= 'Synthetic tree retained because a native child did not settle'
  else if (temporary) { try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { report.teardownFailure = error.message } }
  if (report.teardownFailure) replace(ownerFaultCases[0], { status: 'failed', reason: report.teardownFailure })
  // A passed inventory baseline creates obligations even if a later child/setup failure stops execution.
  const observed = new Map(dynamicRows.map(row => [row.name, row])), completeDynamic = []
  for (const mode of ['read', 'publish']) {
    const baseline = report.results.find(row => row.name === `native-${mode}-allocation-baseline`)
    const inventory = `native-${mode}-allocation-fault-inventory`
    if (baseline.status !== 'passed') {
      replace(inventory, { status: 'blocked', reason: 'Native allocation/exposure baseline did not pass; required ordinal counts remain unknown' })
      continue
    }
    const requiredCases = ownerOrdinalCases(mode, baseline.detail)
    const rows = requiredCases.map(name => observed.get(name) ?? { name, status: 'blocked',
      reason: report.teardownFailure ?? report.prerequisiteFailure ?? 'Observed native ordinal has not executed' })
    completeDynamic.push(...rows)
    const status = rows.every(row => row.status === 'passed') ? 'passed' : rows.some(row => row.status === 'failed') ? 'failed' : 'blocked'
    replace(inventory, { status, requiredCases, ...(status === 'passed' ? {} : { reason: 'At least one observed native allocation/exposure ordinal did not pass' }) })
  }
  report.results.push(...completeDynamic, ...ownerFaultBlockedCases.map(value => ({ ...value, status: 'blocked' })))
  report.summary = ownerSummary(report.results); report.acceptance = report.summary.failed ? 'failed' : 'partial'
  process.exitCode = validateOwnerFaultReport(report)
  mkdirSync(dirname(values.report), { recursive: true }); writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ evidence: report.evidence, summary: report.summary, report: values.report }))
}
