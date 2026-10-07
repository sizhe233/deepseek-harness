/** Supplemental native stream/source matrix. Portable runs retain every obligation with zero native passes. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Blocked, fixtureEnvironment, options, oracle, startChild, summary } from './boundary-support.mjs'
import { blockedCases, cases, diskPreflight, hashFile, installedBinding, largeCases, oracleBinding,
  sourceBinding, sourceFiles, validateReport, validateResult, validateSdk } from './stream-support.mjs'
import { validateAccessProbe } from './stream-support.mjs'

const args = options(process.argv.slice(2))
const entry = args.get('--entry'), sdk = args.get('--oracle'), output = args.get('--output')
const protectedInputs = [entry, sdk, join(dirname(entry), 'streams.js'), join(dirname(dirname(entry)), 'package.json'),
  ...sourceFiles.map(name => fileURLToPath(new URL(name, import.meta.url)))]
assert.ok(protectedInputs.every(path => resolve(path) !== resolve(output)), 'Report cannot overwrite a fixture or native input')
const fixture = sourceBinding(), worker = fileURLToPath(new URL('stream-worker.mjs', import.meta.url))
const probeWorker = fileURLToPath(new URL('stream-access-probe.mjs', import.meta.url))
const report = { schemaVersion: 1, evidence: 'packed-native-stream-source-matrix', nativeExecution: false,
  platform: process.platform, architecture: process.arch, node: process.version, osRelease: release(),
  sourceSha: process.env.CANDIDATE_SHA ?? null, entrySha256: null, streamsEntrySha256: null,
  nativeBinarySha256: null, oracleSha256: null, oracleSourceSha256: fixture.files['windows-oracle.c'],
  fixtureSourceSha256: fixture.sha256, fixtureSources: fixture.files,
  results: [...cases.map(name => ({ name, status: 'blocked', reason: 'Native case has not executed' })),
    ...blockedCases.map(row => ({ ...row, status: 'blocked' }))],
  scope: [
    { name: 'existing-byte-api-and-admission-matrices', status: 'separate-requirement' },
    { name: 'windows-arm64', status: 'out-of-scope' },
    { name: 'power-loss-survival', status: 'out-of-scope' },
    { name: 'source-access-time-and-audit-events', status: 'not-asserted' },
  ] }
let temporary, env, binding
const children = new Set()
const replaceRow = (name, value) => { report.results[report.results.findIndex(row => row.name === name)] = { name, ...value } }
const inspect = path => oracle(sdk, env, 'inspect', path)

async function accessProbe(rootPath, name, mode) {
  const child = startChild(process.execPath, [probeWorker, entry, rootPath, name, mode], env)
  children.add(child)
  let result, primaryFailure
  try {
    result = await child.next()
    await child.complete()
    await assert.rejects(child.next(1), /already exited/u)
    validateAccessProbe(result, mode === 'released', binding, fixture.sha256)
    return result
  } catch (error) {
    primaryFailure = error
    if (result) error.observation = { independentAccessProbe: result }
    throw error
  } finally {
    try { await child.kill() }
    catch (error) {
      error.observation = { independentAccessProbe: result ?? null, primaryFailure: primaryFailure?.message ?? null, teardownFailure: error.message }
      throw error
    }
    if (child.settled) children.delete(child)
  }
}

async function runCase(scenario, ordinal) {
  const rootPath = join(temporary, `case-${ordinal}`)
  oracle(sdk, env, 'create', rootPath, 'directory', scenario === 'source-shared-readable' ? 'public' : 'private')
  const preflight = Object.hasOwn(largeCases, scenario) ? diskPreflight(rootPath, largeCases[scenario]) : null
  const child = startChild(process.execPath, [worker, entry, sdk, rootPath, scenario, JSON.stringify(preflight)], env)
  children.add(child)
  let result, accessControls, primaryFailure
  try {
    result = await child.next(preflight ? 10 * 60_000 : 60_000)
    if (scenario.endsWith('denies-delete')) {
      assert.equal(result.event, 'retained-ready'); assert.equal(result.scenario, scenario)
      for (const name of ['entrySha256', 'streamsEntrySha256', 'nativeBinarySha256']) assert.equal(result[name], binding[name])
      assert.equal(result.fixtureSourceSha256, fixture.sha256)
      if (scenario.startsWith('source-')) assert.equal(result.name, 'source.bin')
      else assert.match(result.name, /^\.dsh-private-[0-9a-f]{40}$/u)
      const sdkWhileLive = inspect(join(rootPath, result.name))
      const live = await accessProbe(rootPath, result.name, 'retained')
      accessControls = { live, sdkWhileLive, independentProcesses: true }
      child.resume()
      result = await child.next(60_000)
    }
    await child.complete()
    await assert.rejects(child.next(1), /already exited/u, 'Exactly one native result is required')
    assert.equal(child.settled, true)
    validateResult(result, scenario, binding, fixture.sha256)
    if (accessControls) accessControls.released = await accessProbe(rootPath, scenario.startsWith('source-') ? 'source.bin' : 'result.bin', 'released')
    const moved = `${rootPath}-released`
    renameSync(rootPath, moved); renameSync(moved, rootPath)
    const sdkRootAfter = inspect(rootPath)
    validateSdk(sdkRootAfter)
    const value = result.observations
    // The controller independently reopens only after the fixture's complete process/pipe exit.
    if (value.fileHash) {
      assert.deepEqual(hashFile(join(rootPath, 'result.bin')), value.fileHash)
      assert.deepEqual(inspect(join(rootPath, 'result.bin')), value.sdkFinal)
    }
    if (value.sourceAfter) {
      assert.deepEqual(hashFile(join(rootPath, 'source.bin')), value.sourceHashAfter)
      assert.deepEqual(inspect(join(rootPath, 'source.bin')), value.sourceAfter)
    }
    if (value.existingAfter) {
      assert.deepEqual(hashFile(join(rootPath, 'result.bin')), value.existingHashBefore)
      assert.deepEqual(inspect(join(rootPath, 'result.bin')), value.existingBefore)
    }
    if (value.stagingAfter) {
      const staging = join(rootPath, value.writerReceipt.stagingName)
      assert.deepEqual(hashFile(staging), value.stagingHashBefore)
      assert.deepEqual(inspect(staging), value.stagingBefore)
      assert.equal(existsSync(join(rootPath, 'result.bin')), false)
    }
    if (value.unpublishedRemoved) {
      assert.equal(existsSync(join(rootPath, 'result.bin')), false)
      if (value.writerReceipt?.stagingName) assert.equal(existsSync(join(rootPath, value.writerReceipt.stagingName)), false)
    }
    return { ...result, ...(accessControls ? { accessControls } : {}), processExited: true, streamClosed: true, rootRenamedAfterChildExit: true, sdkRootAfter }
  } catch (error) {
    primaryFailure = error
    if (result) error.observation = { ...result, ...(accessControls ? { accessControls } : {}),
      ...(error.observation ? { probeFailure: error.observation } : {}) }
    throw error
  } finally {
    try {
      await child.kill()
      if (child.settled) {
        children.delete(child)
        // Remove each synthetic case before the next large file is admitted.
        if (![...children].some(other => !other.settled)) rmSync(rootPath, { recursive: true, force: true })
      }
    } catch (error) {
      error.observation = { nativeResult: result ?? null, accessControls: accessControls ?? null,
        primaryFailure: primaryFailure?.message ?? null, teardownFailure: error.message }
      throw error
    }
  }
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Requires actual Windows x64; portable orchestration never counts as native acceptance')
  assert.match(report.sourceSha ?? '', /^[0-9a-f]{40}$/u, 'Artifact runner must supply the fixed verified CANDIDATE_SHA')
  binding = installedBinding(entry)
  Object.assign(report, binding, oracleBinding(sdk))
  temporary = mkdtempSync(join(tmpdir(), 'dsh-native-stream-'))
  const home = join(temporary, 'home'); mkdirSync(home)
  env = fixtureEnvironment(home, temporary)
  oracle(sdk, env, 'token')
  report.nativeExecution = true
  for (const [index, scenario] of cases.entries()) {
    try { replaceRow(scenario, { status: 'passed', detail: await runCase(scenario, index + 1) }) }
    catch (error) {
      replaceRow(scenario, { status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message,
        ...(error.observation ? { observation: error.observation } : {}) })
    }
    if ([...children].some(child => !child.settled)) break
  }
} catch (error) {
  report.prerequisiteFailure = error.message
  for (const scenario of cases) replaceRow(scenario, { status: error instanceof Blocked ? 'blocked' : 'failed', reason: error.message })
} finally {
  for (const child of children) {
    try { await child.kill() } catch (error) { report.teardownFailure = error.message }
  }
  if (temporary && [...children].some(child => !child.settled)) {
    report.teardownFailure ??= 'Synthetic files retained because an owned process or output stream remains unsettled'
    report.retainedSyntheticRoot = temporary
  } else if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true }) }
    catch (error) { report.teardownFailure = error.message; report.retainedSyntheticRoot = temporary }
  }
  if (report.teardownFailure) replaceRow(cases[0], { status: 'failed', reason: report.teardownFailure })
  report.summary = summary(report.results)
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  try { process.exitCode = validateReport(report) }
  catch (error) {
    report.validationFailure = error.message
    for (const row of [...report.results]) {
      if (row.status === 'passed') replaceRow(row.name, { status: 'failed', reason: `Report validation failed: ${error.message}`, observation: row.detail })
    }
    report.summary = summary(report.results); report.acceptance = 'failed'; process.exitCode = 1
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ acceptance: report.acceptance, summary: report.summary, output }))
}
