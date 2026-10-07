/** Collect every independent packed Windows matrix, then apply the reviewed explicit subcase contract. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectNativeMatrices } from './private-storage-composite.mjs'
import { evaluatePrivateStorageNative, privateStorageNativeContract } from './private-storage-native-contract.mjs'
import { runNativeMatrixProcess } from './private-storage-matrix-process.mjs'

import { validatePrivateStorageClaim } from './private-storage-applicability.mjs'

const hash = path => {
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'SDK input must be a regular file')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
const json = path => JSON.parse(readFileSync(path, 'utf8'))

/** Bind generated SDK bytes to the candidate's exact fixture sources and retained compiler logs. */
export function bindNativeMatrixOracles(fixtures, oracleDirectory) {
  const bindings = {}, errors = []
  try {
    const build = json(join(oracleDirectory, 'oracle-build.json'))
    const program = join(oracleDirectory, 'private-storage-oracle.exe')
    const source = join(fixtures, 'windows-oracle.c')
    assert.equal(build.architecture, 'x64')
    assert.equal(build.binarySha256, hash(program))
    assert.equal(build.sourceSha256, hash(source))
    assert.equal(build.compilerLogSha256, hash(join(oracleDirectory, 'compiler.log')))
    bindings.primary = { program, source, oracleSha256: build.binarySha256, oracleSourceSha256: build.sourceSha256,
      compilerLog: join(oracleDirectory, 'compiler.log'), compilerLogSha256: build.compilerLogSha256,
      buildRecord: join(oracleDirectory, 'oracle-build.json'), buildRecordSha256: hash(join(oracleDirectory, 'oracle-build.json')) }
  } catch (error) { errors.push({ stage: 'primary-sdk-binding', reason: error.message }) }
  try {
    const build = json(join(oracleDirectory, 'sdk-matrices-build.json'))
    assert.equal(build.schemaVersion, 1); assert.equal(build.architecture, 'x64')
    assert.ok(Array.isArray(build.fixtures))
    assert.equal(build.complete, build.fixtures.every(record => record.complete === true), 'Contradictory SDK build completion')
    const expected = [
      ['admission', 'windows-admission-oracle.c', 'private-storage-admission-oracle.exe'],
      ['inheritance-library', 'boundary-inheritance.c', 'boundary-inheritance.dll'],
      ['inheritance-child', 'boundary-inheritance.c', 'boundary-inheritance-child.exe'],
    ]
    assert.equal(build.fixtures.length, expected.length, 'SDK build inventory differs')
    assert.equal(new Set(build.fixtures.map(record => record.name)).size, expected.length)
    for (const [name, sourceName, binaryName] of expected) {
      try {
        const record = build.fixtures.find(item => item.name === name)
        assert.ok(record, `Missing SDK fixture: ${name}`)
        assert.equal(record.source, sourceName); assert.equal(record.binary, binaryName)
        assert.equal(record.complete, true); assert.equal(record.sourceUnchanged, true); assert.equal(record.exitCode, 0)
        assert.equal(record.compilerLog, `${name}-compiler.log`)
        const program = join(oracleDirectory, binaryName), source = join(fixtures, sourceName)
        assert.equal(record.binarySha256, hash(program)); assert.equal(record.producedBinarySha256, record.binarySha256)
        assert.equal(record.sourceSha256, hash(source))
        assert.equal(record.compilerLogSha256, hash(join(oracleDirectory, record.compilerLog)))
        bindings[name] = { program, source, oracleSha256: record.binarySha256, oracleSourceSha256: record.sourceSha256,
          compilerLog: join(oracleDirectory, record.compilerLog), compilerLogSha256: record.compilerLogSha256,
          buildRecord: join(oracleDirectory, 'sdk-matrices-build.json'), buildRecordSha256: hash(join(oracleDirectory, 'sdk-matrices-build.json')) }
      } catch (error) { errors.push({ stage: `${name}-sdk-binding`, reason: error.message }) }
    }
  } catch (error) { errors.push({ stage: 'supplemental-sdk-binding', reason: error.message }) }
  return { bindings, errors }
}

/** Attempt all usable independent matrices, preserving failures and missing SDK prerequisites. */
export async function runPackedNativeMatrices({ fixtures, oracleDirectory, evidence, entry, candidateArchive, manifest, sourceSha, admittedOracles, claim }, invoke = runNativeMatrixProcess) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/u)
  const fixedClaim = claim === undefined ? undefined : validatePrivateStorageClaim(claim)
  if (fixedClaim) assert.deepEqual(validatePrivateStorageClaim(json(manifest).privateStorageAcceptance?.claim), fixedClaim, 'Acceptance claim differs from immutable candidate manifest')
  const entrySha256 = hash(entry)
  const { bindings, errors } = admittedOracles ?? bindNativeMatrixOracles(fixtures, oracleDirectory)
  const layout = [
    { id: 'primary', file: 'acceptance.mjs', binding: 'primary', timeoutMs: 20 * 60 * 1000 },
    { id: 'admission', file: 'admission-matrix.mjs', binding: 'admission', timeoutMs: 10 * 60 * 1000 },
    { id: 'boundary', file: 'boundary-matrix.mjs', binding: 'primary', timeoutMs: 30 * 60 * 1000 },
    { id: 'directory', file: 'directory-boundary-matrix.mjs', binding: 'primary', timeoutMs: 10 * 60 * 1000 },
  ]
  const specifications = layout.map(item => ({ id: item.id, sourceSha, entrySha256,
    oracleSha256: bindings[item.binding]?.oracleSha256, oracleSourceSha256: bindings[item.binding]?.oracleSourceSha256 }))
  const runs = await collectNativeMatrices(specifications, async specification => {
    const item = layout.find(candidate => candidate.id === specification.id), binding = bindings[item.binding]
    assert.ok(binding, `Required SDK fixture is unavailable: ${item.binding}`)
    assert.equal(hash(entry), entrySha256, 'Packed entry changed before native execution')
    assert.equal(hash(binding.program), binding.oracleSha256, 'SDK binary changed before native execution')
    assert.equal(hash(binding.source), binding.oracleSourceSha256, 'SDK source changed before native execution')
    assert.equal(hash(binding.compilerLog), binding.compilerLogSha256, 'Compiler log changed before native execution')
    assert.equal(hash(binding.buildRecord), binding.buildRecordSha256, 'SDK build record changed before native execution')
    if (item.id === 'boundary') {
      for (const name of ['inheritance-library', 'inheritance-child']) {
        const helper = bindings[name]
        assert.ok(helper, `Unadmitted SDK helper prevents boundary execution: ${name}`)
        assert.equal(hash(helper.program), helper.oracleSha256, 'Inheritance binary changed before native execution')
        assert.equal(hash(helper.source), helper.oracleSourceSha256, 'Inheritance source changed before native execution')
        assert.equal(hash(helper.compilerLog), helper.compilerLogSha256, 'Inheritance compiler log changed before native execution')
        assert.equal(hash(helper.buildRecord), helper.buildRecordSha256, 'Inheritance build record changed before native execution')
      }
    }
    const reportPath = join(evidence, `windows-${item.id}.json`)
    const args = [join(fixtures, item.file), '--entry', entry, '--oracle', binding.program, '--output', reportPath]
    if (item.id === 'primary') args.push('--candidate-archive', candidateArchive, '--manifest', manifest, '--source-sha', sourceSha)
    if (item.id === 'primary' || item.id === 'admission') args.push('--require-complete', 'true')
    const run = await invoke(process.execPath, args, { cwd: evidence, env: { ...process.env, CANDIDATE_SHA: sourceSha },
      reportPath, logPath: join(evidence, `${item.id}-native.log`), timeoutMs: item.timeoutMs })
    try {
      assert.equal(hash(entry), entrySha256, 'Packed entry changed during native matrix execution')
      assert.equal(hash(binding.program), specification.oracleSha256, 'SDK binary changed during execution')
      assert.equal(hash(binding.source), specification.oracleSourceSha256, 'SDK source changed during execution')
      assert.equal(hash(binding.compilerLog), binding.compilerLogSha256, 'Compiler log changed during execution')
      assert.equal(hash(binding.buildRecord), binding.buildRecordSha256, 'SDK build record changed during execution')
      if (item.id === 'boundary' && run.rawReport !== null) {
        const report = JSON.parse(run.rawReport)
        const library = bindings['inheritance-library'], child = bindings['inheritance-child']
        assert.equal(report.inheritanceSourceSha256, hash(join(fixtures, 'boundary-inheritance.c')))
        const inherited = report.results.find(row => row.name === 'sdk-child-does-not-inherit-private-handles-with-positive-control')
        if (library && child) {
          for (const helper of [library, child]) {
            assert.equal(hash(helper.program), helper.oracleSha256); assert.equal(hash(helper.source), helper.oracleSourceSha256)
            assert.equal(hash(helper.compilerLog), helper.compilerLogSha256); assert.equal(hash(helper.buildRecord), helper.buildRecordSha256)
          }
          if (inherited?.status === 'passed') {
            assert.equal(inherited.detail.sdkDllSha256, library.oracleSha256)
            assert.equal(inherited.detail.sdkChildSha256, child.oracleSha256)
          }
        } else assert.notEqual(inherited?.status, 'passed', 'Unbound inheritance artifacts cannot produce accepted evidence')
      }
    } catch (error) { run.error ??= error.message }
    return run
  })
  let evaluation
  try { evaluation = evaluatePrivateStorageNative({ specifications, runs, claim: fixedClaim }) }
  catch (error) {
    evaluation = { schemaVersion: 1, complete: false, acceptance: 'failed', errors: [{ reason: error.message }],
      subcases: privateStorageNativeContract(new Map()).requirements.map(item => ({ id: item.id, status: 'blocked', reason: 'Complete expected SDK identity inventory was not established' })) }
  }
  const complete = errors.length === 0 && evaluation.complete
  const report = { schemaVersion: 1, sourceSha, entrySha256, complete,
    ...(fixedClaim === undefined ? {} : { claim: fixedClaim, expandedComplete: evaluation.expandedComplete ?? false }),
    acceptance: complete ? 'complete' : errors.length || evaluation.acceptance === 'failed' ? 'failed' : 'partial',
    sdkBindings: bindings, prerequisiteErrors: errors, matrixBudgets: layout.map(({ id, timeoutMs }) => ({ id, timeoutMs })), specifications, runs, evaluation }
  writeFileSync(join(evidence, 'windows-composite.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return report
}
