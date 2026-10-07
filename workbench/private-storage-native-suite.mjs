/** Independent native preflights and matrices; failures are collected before the final gate is evaluated. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNativeMatrixProcess } from './private-storage-matrix-process.mjs'
import { bindNativeMatrixOracles, runPackedNativeMatrices } from './private-storage-native-matrices.mjs'

const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = path => digestBytes(readFileSync(path))

/** Reject contradictory, incomplete or unexecuted prerequisite reports. */
export function validateNativePreflight(name, run, expected) {
  assert.equal(run.error, undefined); assert.equal(run.exitCode, 0); assert.equal(run.signal, null); assert.equal(run.timedOut, false)
  assert.ok(typeof run.rawReport === 'string' && run.rawReport.length > 0)
  const report = JSON.parse(run.rawReport)
  if (name === 'loader') {
    assert.equal(report.nativeExecution, true); assert.equal(report.platform, 'win32'); assert.equal(report.architecture, 'x64')
    assert.equal(report.complete, true)
    assert.deepEqual(report.summary, { passed: 5, failed: 0, blocked: 0 })
    assert.deepEqual(report.results.map(row => [row.name, row.status]),
      ['baseline', 'missing-binary', 'corrupt-binary', 'shadow-object', 'shadow-throw'].map(name => [name, 'passed']))
  } else if (name === 'primary-compiler') {
    assert.equal(report.architecture, 'x64')
    assert.equal(report.sourceSha256, expected.oracleSourceSha256)
    assert.equal(report.binarySha256, expected.oracleSha256)
    assert.match(report.compilerLogSha256, /^[0-9a-f]{64}$/u)
  } else if (name === 'supplemental-compiler') {
    assert.equal(report.schemaVersion, 1); assert.equal(report.complete, true); assert.equal(report.architecture, 'x64')
    assert.deepEqual(report.fixtures.map(row => [row.name, row.complete, row.exitCode]),
      ['admission', 'inheritance-library', 'inheritance-child'].map(name => [name, true, 0]))
  } else {
    assert.equal(name, 'abi')
    assert.equal(report.schemaVersion, 1); assert.equal(report.complete, true); assert.equal(report.status, 'passed'); assert.equal(report.check, 'sdk-ffi-abi')
    assert.equal(report.nativeExecution, true); assert.equal(report.platform, 'win32'); assert.equal(report.architecture, 'x64')
    for (const field of ['sourceSha', 'oracleSha256', 'oracleSourceSha256', 'abiSha256']) assert.equal(report[field], expected[field])
  }
  return report
}

/** Run every independent preflight and usable matrix, retaining exact reports and strict final failure. */
export async function runPackedNativeSuite(input, invoke = runNativeMatrixProcess) {
  const { toolkit, fixtures, oracleDirectory, evidence, entry, consumerRoot, candidateArchive, manifest, sourceSha, abi, claim } = input
  assert.match(sourceSha, /^[0-9a-f]{40}$/u)
  const fixedInputs = [entry, abi, candidateArchive, manifest, ...['windows-oracle.c', 'windows-admission-oracle.c', 'boundary-inheritance.c'].map(name => join(fixtures, name))]
    .map(path => ({ path, sha256: digest(path) }))
  const entrySha256 = fixedInputs[0].sha256
  const preflights = [], errors = [], compilerBindingErrors = [], compilerBindings = {}
  let changedInput = false
  function checkInputs() {
    try { for (const item of fixedInputs) assert.equal(digest(item.path), item.sha256, `Native suite input changed: ${item.path}`) }
    catch (error) { changedInput = true; errors.push({ stage: 'immutable-inputs', reason: error.message }) }
  }
  async function attempt(name, command, args, reportPath, timeoutMs) {
    let run
    try {
      checkInputs()
      assert.equal(changedInput, false, 'Changed immutable inputs prevent preflight execution')
      run = await invoke(command, args, { cwd: evidence, env: { ...process.env, CANDIDATE_SHA: sourceSha }, reportPath,
      logPath: join(evidence, `${name}-preflight.log`), timeoutMs }) }
    catch (error) { run = { exitCode: null, signal: null, timedOut: false, rawReport: null, error: error.message } }
    checkInputs()
    preflights.push({ name, ...run })
    return run
  }
  function pinCompilerOutputs(name, run) {
    if (typeof run.rawReport !== 'string') {
      compilerBindingErrors.push({ stage: `${name}-output-binding`, reason: 'Compiler did not produce a captured build report' })
      return
    }
    try {
      const record = join(oracleDirectory, name === 'primary-compiler' ? 'oracle-build.json' : 'sdk-matrices-build.json')
      assert.equal(digest(record), digestBytes(run.rawReport), 'Compiler build record differs from its captured report')
      const observed = bindNativeMatrixOracles(fixtures, oracleDirectory)
      compilerBindingErrors.push(...observed.errors.filter(item => name === 'primary-compiler'
        ? item.stage === 'primary-sdk-binding' : item.stage !== 'primary-sdk-binding'))
      const admitted = observed.bindings
      const names = name === 'primary-compiler' ? ['primary'] : ['admission', 'inheritance-library', 'inheritance-child']
      for (const key of names) {
        const binding = admitted[key]
        if (!binding) {
          compilerBindingErrors.push({ stage: `${name}-output-binding`, reason: `SDK fixture was not admitted at compiler completion: ${key}` })
          continue
        }
        compilerBindings[key] = Object.freeze({ ...binding })
        for (const [path, sha256] of [[binding.program, binding.oracleSha256], [binding.compilerLog, binding.compilerLogSha256], [binding.buildRecord, binding.buildRecordSha256]]) {
          const prior = fixedInputs.find(item => item.path === path)
          if (prior) assert.equal(prior.sha256, sha256, 'Compiler attempted to rebind an admitted input')
          else fixedInputs.push({ path, sha256 })
        }
      }
      checkInputs()
    } catch (error) { changedInput = true; errors.push({ stage: `${name}-output-binding`, reason: error.message }) }
  }
  await attempt('loader', process.execPath, [join(fixtures, 'loader-negative.mjs'), consumerRoot, join(evidence, 'loader-negative.json')],
    join(evidence, 'loader-negative.json'), 180_000)
  const primaryCompilation = await attempt('primary-compiler', 'pwsh', ['-NoLogo', '-NoProfile', '-File', join(toolkit, 'workbench/private-storage-native.ps1'), '-OutputDirectory', oracleDirectory],
    join(oracleDirectory, 'oracle-build.json'), 180_000)
  pinCompilerOutputs('primary-compiler', primaryCompilation)
  const supplementalCompilation = await attempt('supplemental-compiler', 'pwsh', ['-NoLogo', '-NoProfile', '-File', join(toolkit, 'workbench/private-storage-sdk-matrices.ps1'), '-OutputDirectory', oracleDirectory],
    join(oracleDirectory, 'sdk-matrices-build.json'), 180_000)
  pinCompilerOutputs('supplemental-compiler', supplementalCompilation)
  const bindings = Object.freeze({ ...compilerBindings })
  errors.push(...compilerBindingErrors)
  const expected = { sourceSha, abiSha256: fixedInputs[1].sha256, oracleSha256: bindings.primary?.oracleSha256, oracleSourceSha256: bindings.primary?.oracleSourceSha256 }
  if (bindings.primary && !changedInput) {
    await attempt('abi', process.execPath, [join(fixtures, 'abi-acceptance.mjs'), bindings.primary.program, abi, join(evidence, 'sdk-abi-acceptance.json')],
      join(evidence, 'sdk-abi-acceptance.json'), 60_000)
  } else preflights.push({ name: 'abi', exitCode: null, signal: null, timedOut: false, rawReport: null, error: 'SDK ABI oracle or immutable suite inputs were not admitted' })
  for (const run of preflights) {
    try { validateNativePreflight(run.name, run, expected) }
    catch (error) { errors.push({ stage: run.name, reason: error.message }) }
  }
  checkInputs()
  const matrices = changedInput ? { complete: false, acceptance: 'failed', error: 'Changed immutable inputs prevent native matrix execution' }
    : await runPackedNativeMatrices({ fixtures, oracleDirectory, evidence, entry, candidateArchive, manifest, sourceSha, claim,
      admittedOracles: { bindings, errors: [...compilerBindingErrors] } }, async (...args) => {
      checkInputs()
      assert.equal(changedInput, false, 'Changed immutable suite inputs prevent matrix execution')
      const run = await invoke(...args)
      checkInputs()
      if (changedInput) run.error ??= 'Immutable suite inputs changed during this matrix'
      return run
    })
  checkInputs()
  const complete = errors.length === 0 && matrices.complete
  const report = { schemaVersion: 1, sourceSha, entrySha256, fixedInputs, complete,
    ...(claim === undefined ? {} : { claim, expandedComplete: matrices.evaluation?.expandedComplete ?? false }),
    acceptance: complete ? 'complete' : errors.length || matrices.acceptance === 'failed' ? 'failed' : 'partial', preflights, errors, matrices }
  writeFileSync(join(evidence, 'windows-native-suite.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return report
}
