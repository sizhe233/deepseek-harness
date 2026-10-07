/** Supplemental packed-entry directory/cleanup matrix; never a replacement for full candidate acceptance. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Blocked, digest, fixtureEnvironment, options, oracle, startChild, summary } from './boundary-support.mjs'
import { blockedCases, cases, installedBinding, oracleBinding, queryBudget, sourceBinding, validateReport, validateResult } from './directory-boundary-support.mjs'

const args = options(process.argv.slice(2))
const entry = args.get('--entry'), sdk = args.get('--oracle'), output = args.get('--output')
assert.ok(![entry, sdk].some(input => resolve(input) === resolve(output)), 'Report cannot overwrite a native input')
const fixture = sourceBinding()
const worker = fileURLToPath(new URL('directory-boundary-worker.mjs', import.meta.url))
const oldBytes = Buffer.from('synthetic original directory-boundary record\n')
const report = { schemaVersion: 1, evidence: 'packed-native-directory-cleanup-matrix',
  nativeExecution: false, platform: process.platform, architecture: process.arch, node: process.version, osRelease: release(),
  sourceSha: process.env.CANDIDATE_SHA ?? null, entrySha256: null, oracleSha256: null, oracleSourceSha256: fixture.files['windows-oracle.c'],
  nativeBinarySha256: null, fixtureSourceSha256: fixture.sha256, fixtureSources: fixture.files,
  results: [...cases.map(name => ({ name, status: 'blocked', reason: 'Native case has not executed' })),
    ...blockedCases.map(row => ({ ...row, status: 'blocked' }))],
  scope: [
    { name: 'private-plugin-composition', status: 'separate-requirement' },
    { name: 'windows-arm64', status: 'out-of-scope' },
    { name: 'abrupt-power-loss', status: 'out-of-scope' },
  ] }
let temporary, env, storage, token, binding
const children = new Set()
const replaceRow = (name, value) => { report.results[report.results.findIndex(row => row.name === name)] = { name, ...value } }
const inspect = path => oracle(sdk, env, 'inspect', path)

function privateFacts(path, directory) {
  const facts = inspect(path)
  assert.equal(facts.ownerSid, token.userSid)
  assert.equal(facts.daclPresent, true); assert.equal(facts.daclNull, false); assert.equal(facts.daclProtected, true)
  assert.equal(facts.directory, directory); assert.equal(facts.reparseTag, 0)
  if (!directory) assert.equal(facts.links, 1)
  assert.deepEqual(facts.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })),
    [{ type: 0, flags: directory ? 3 : 0, mask: 0x001f01ff, sid: token.userSid }])
  return { identity: facts.identity, descriptorHex: facts.descriptorHex, ownerSid: facts.ownerSid,
    daclProtected: facts.daclProtected, reparseTag: facts.reparseTag, links: facts.links,
    ...(directory ? {} : { bytesSha256: digest(readFileSync(path)) }) }
}
function snapshot(rootPath) {
  assert.deepEqual(readdirSync(rootPath).sort(), ['record.bin', 'writer.lock'])
  return { root: privateFacts(rootPath, true), record: privateFacts(join(rootPath, 'record.bin'), false),
    lease: privateFacts(join(rootPath, 'writer.lock'), false) }
}
function makeCase(ordinal) {
  const rootPath = join(temporary, `case-${ordinal}`)
  oracle(sdk, env, 'create', rootPath, 'directory', 'private')
  oracle(sdk, env, 'create', join(rootPath, 'record.bin'), 'file', 'private')
  oracle(sdk, env, 'create', join(rootPath, 'writer.lock'), 'file', 'private')
  writeFileSync(join(rootPath, 'record.bin'), oldBytes)
  return { rootPath, before: snapshot(rootPath) }
}
function observeAfterExit(fixtureCase) {
  const moved = `${fixtureCase.rootPath}-released`
  // A successful rename proves no retained no-delete-share guard remains after child exit.
  renameSync(fixtureCase.rootPath, moved)
  renameSync(moved, fixtureCase.rootPath)
  const root = storage.openPrivateDirectory(fixtureCase.rootPath, { create: false })
  let writer
  try {
    writer = storage.acquirePrivateWriterLease(root, 'writer.lock')
    assert.deepEqual(writer.identity, fixtureCase.before.lease.identity)
  } finally { try { writer?.close() } finally { root.close() } }
  const after = snapshot(fixtureCase.rootPath)
  assert.deepEqual(after, fixtureCase.before, 'Independent SDK identities, descriptors and bytes must stay unchanged')
  return { originalIdentitiesAndBytesRetained: true, originalPrivateDescriptorsRetained: true,
    sdkBefore: fixtureCase.before, sdkAfter: after, leaseReacquiredAfterChildExit: true, rootRenamedAfterChildExit: true }
}
async function runCase(scenario, ordinal) {
  const f = makeCase(ordinal)
  const child = startChild(process.execPath, [worker, entry, f.rootPath, scenario], env)
  children.add(child)
  try {
    const result = await child.next(30_000)
    if (result.event === 'query-budget-exhausted') {
      assert.equal(scenario, 'directory-enumeration-total-query-ceiling')
      assert.equal(result.scenario, scenario); assert.equal(result.budget, queryBudget)
      assert.equal(result.queryCalls, queryBudget + 1); assert.equal(result.forwardedDirectoryQueries, queryBudget)
      assert.equal(result.entrySha256, binding.entrySha256); assert.equal(result.nativeBinarySha256, binding.nativeBinarySha256)
      assert.equal(result.fixtureSourceSha256, fixture.sha256)
      await child.kill()
      assert.equal(child.settled, true)
      const observation = { ...observeAfterExit(f), ...result, ownedProcessTerminated: true,
        backendBoundObserved: false, wrapperStoppingCountsAsNativeBound: false }
      const error = new Error(`Packed backend attempted query ${queryBudget + 1} after ${queryBudget} injected dot-only pages; no backend total-query bound was observed`)
      error.observation = observation
      throw error
    }
    await child.complete()
    await assert.rejects(child.next(1), /already exited/u, 'Exactly one result event is permitted')
    assert.equal(child.settled, true)
    validateResult(result, scenario, binding, fixture.sha256)
    const observation = observeAfterExit(f)
    return { ...observation, faultOrigin: result.faultInjected ? 'test-owned-injection' : 'none',
      realStorageFailureClaimed: false, actualPendingRequest: false,
      releasedResourcesAreNeverRetried: true, backendBoundObserved: scenario.endsWith('total-query-ceiling') ? true : undefined,
      ...result }
  } finally {
    await child.kill()
    if (child.settled) children.delete(child)
  }
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Requires actual Windows x64; portable protocol tests never count as native acceptance')
  assert.match(report.sourceSha ?? '', /^[0-9a-f]{40}$/u, 'Artifact runner must supply the verified CANDIDATE_SHA')
  binding = installedBinding(entry)
  Object.assign(report, binding, oracleBinding(sdk))
  report.nativeExecution = true
  temporary = mkdtempSync(join(tmpdir(), 'dsh-directory-boundary-'))
  const home = join(temporary, 'home'); mkdirSync(home)
  env = fixtureEnvironment(home, temporary)
  token = oracle(sdk, env, 'token')
  storage = await import(pathToFileURL(entry).href)
  assert.equal(storage.capabilities().available, true)
  assert.equal(storage.capabilities().nativeArtifact.nativeBinarySha256, report.nativeBinarySha256)
  for (const [index, scenario] of cases.entries()) {
    try { replaceRow(scenario, { status: 'passed', detail: await runCase(scenario, index + 1) }) }
    catch (error) { replaceRow(scenario, { status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message,
      ...(error.observation ? { observation: error.observation } : {}) }) }
    if ([...children].some(child => !child.settled)) break
  }
} catch (error) {
  const status = error instanceof Blocked ? 'blocked' : 'failed'
  report.prerequisiteFailure = error.message
  for (const scenario of cases) replaceRow(scenario, { status, reason: error.message })
} finally {
  for (const child of children) {
    try { await child.kill() }
    catch (error) { report.teardownFailure = error.message }
  }
  if (temporary && [...children].some(child => !child.settled)) {
    report.teardownFailure ??= 'Recursive cleanup withheld while an owned child remains unsettled'
    report.retainedSyntheticRoot = temporary
  } else if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true }) }
    catch (error) { report.teardownFailure = error.message; report.retainedSyntheticRoot = temporary }
  }
  if (report.teardownFailure) replaceRow(cases[0], { status: 'failed', reason: report.teardownFailure })
  report.summary = summary(report.results)
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  process.exitCode = validateReport(report)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ acceptance: report.acceptance, summary: report.summary, output }))
}
