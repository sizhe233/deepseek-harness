/** Collect every independent packed Windows matrix, then apply the reviewed explicit subcase contract. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectNativeMatrices } from './private-storage-composite.mjs'
import { evaluatePrivateStorageNative, privateStorageNativeContract } from './private-storage-native-contract.mjs'
import { runNativeMatrixProcess } from './private-storage-matrix-process.mjs'

import { validatePrivateStorageClaim } from './private-storage-applicability.mjs'
import { ownerDigest, ownerFaultSources, ownerProductionSha256 } from './private-storage-owner-fault-evidence.mjs'

const hash = path => {
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'SDK input must be a regular file')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
const json = path => JSON.parse(readFileSync(path, 'utf8'))
export const privateStorageNativeMatrixBudgets = Object.freeze({ primary: 20 * 60 * 1000, admission: 10 * 60 * 1000,
  boundary: 30 * 60 * 1000, 'owner-faults': 30 * 60 * 1000 })

/** Admit the source-owner build at compiler completion, before any later matrix can change it. */
export function bindNativeOwnerFault(toolkit, directory, productionBinarySha256) {
  assert.match(productionBinarySha256, /^[a-f0-9]{64}$/u, 'Packed production owner identity is required')
  const program = join(directory, 'owner-fault-fixture.node'), buildRecord = join(directory, 'owner-fault-build.json')
  const compilerLog = join(directory, 'owner-fault-compiler.log'), build = json(buildRecord)
  assert.equal(build.schemaVersion, 1); assert.equal(build.evidence, 'source-instrumented-native-owner-faults')
  assert.equal(build.complete, true); assert.equal(build.sourceUnchanged, true); assert.equal(build.compilerInputsComplete, true)
  assert.equal(build.exitCode, 0); assert.equal(build.platform, 'win32'); assert.equal(build.architecture, 'x64')
  assert.equal(build.nodeVersion, process.version); assert.equal(build.binary, 'owner-fault-fixture.node')
  assert.equal(build.productionSourceSha256, ownerProductionSha256)
  const fixtureSources = Object.fromEntries(ownerFaultSources.map(path => [path, hash(join(toolkit, path))]))
  assert.deepEqual(build.fixtureSources, fixtureSources)
  assert.equal(build.fixtureSourceSha256, ownerDigest(JSON.stringify(fixtureSources)))
  assert.equal(hash(join(toolkit, 'native/system/packages/entry/src/windows-private-owner.c')), ownerProductionSha256)
  assert.equal(build.binarySha256, hash(program)); assert.equal(build.producedBinarySha256, build.binarySha256)
  assert.equal(build.compilerLogSha256, hash(compilerLog))
  assert.ok(Array.isArray(build.inputs) && build.inputs.length > 5, 'Compiler input inventory is missing')
  assert.equal(new Set(build.inputs.map(input => input.path.toLowerCase())).size, build.inputs.length)
  for (const input of build.inputs) assert.equal(hash(input.path), input.sha256, 'Admitted compiler input changed')
  const admittedInputs = new Set(build.inputs.map(input => input.path.toLowerCase()))
  for (const path of [join(toolkit, 'packages/storage/private-storage/tests/native/owner-fault-fixture.c'),
    join(toolkit, 'native/system/packages/entry/src/windows-private-owner.c'),
    ...['verified.json', 'headers.tar.gz', 'node.lib'].map(name => join(build.nodeSdk, name))]) {
    assert.ok(admittedInputs.has(path.toLowerCase()), `Required source-owner compiler input is absent: ${path}`)
  }
  const identity = { productionSourceSha256: ownerProductionSha256, fixtureSources, fixtureSourceSha256: build.fixtureSourceSha256,
    fixtureBinarySha256: build.binarySha256, fixtureBuildSha256: hash(buildRecord), compilerLogSha256: build.compilerLogSha256,
    productionBinarySha256 }
  const files = [
    { path: program, sha256: identity.fixtureBinarySha256 }, { path: buildRecord, sha256: identity.fixtureBuildSha256 },
    { path: compilerLog, sha256: identity.compilerLogSha256 },
    ...build.inputs.map(input => ({ path: input.path, sha256: input.sha256 })),
    ...ownerFaultSources.map(path => ({ path: join(toolkit, path), sha256: fixtureSources[path] })),
    { path: join(toolkit, 'native/system/packages/entry/src/windows-private-owner.c'), sha256: ownerProductionSha256 },
  ]
  return { program, buildRecord, compilerLog, identity, files }
}

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
export async function runPackedNativeMatrices({ fixtures, oracleDirectory, evidence, entry, candidateArchive, manifest, sourceSha, admittedOracles, admittedOwnerFault, claim }, invoke = runNativeMatrixProcess) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/u)
  const fixedClaim = claim === undefined ? undefined : validatePrivateStorageClaim(claim)
  if (fixedClaim) assert.deepEqual(validatePrivateStorageClaim(json(manifest).privateStorageAcceptance?.claim), fixedClaim, 'Acceptance claim differs from immutable candidate manifest')
  const entrySha256 = hash(entry)
  const { bindings, errors } = admittedOracles ?? bindNativeMatrixOracles(fixtures, oracleDirectory)
  const layout = [
    { id: 'primary', file: 'acceptance.mjs', binding: 'primary', reportEvidence: 'native-synthetic-acceptance-harness' },
    { id: 'admission', file: 'admission-matrix.mjs', binding: 'admission', reportEvidence: 'native-sdk-admission-matrix' },
    { id: 'boundary', file: 'boundary-matrix.mjs', binding: 'primary', reportEvidence: 'packed-native-boundary-matrix' },
    { id: 'owner-faults', file: 'owner-fault-matrix.mjs', binding: 'primary' },
  ].map(item => ({ ...item, timeoutMs: privateStorageNativeMatrixBudgets[item.id] }))
  const specifications = layout.map(item => ({ id: item.id, sourceSha, entrySha256,
    evidencePlane: item.id === 'owner-faults' ? 'source-instrumented-native-owner-faults' : 'packed-production',
    ...(item.id === 'owner-faults' ? { ...admittedOwnerFault?.identity, oracleCompilerLogSha256: bindings[item.binding]?.compilerLogSha256 } : { reportEvidence: item.reportEvidence }),
    oracleSha256: bindings[item.binding]?.oracleSha256, oracleSourceSha256: bindings[item.binding]?.oracleSourceSha256 }))
  const runs = await collectNativeMatrices(specifications, async specification => {
    const item = layout.find(candidate => candidate.id === specification.id), binding = bindings[item.binding]
    assert.ok(binding, `Required SDK fixture is unavailable: ${item.binding}`)
    assert.equal(hash(entry), entrySha256, 'Packed entry changed before native execution')
    assert.equal(hash(binding.program), binding.oracleSha256, 'SDK binary changed before native execution')
    assert.equal(hash(binding.source), binding.oracleSourceSha256, 'SDK source changed before native execution')
    assert.equal(hash(binding.compilerLog), binding.compilerLogSha256, 'Compiler log changed before native execution')
    assert.equal(hash(binding.buildRecord), binding.buildRecordSha256, 'SDK build record changed before native execution')
    const checkOwner = () => {
      assert.ok(admittedOwnerFault, 'Required source-owner compiler evidence is unavailable')
      for (const file of admittedOwnerFault.files) assert.equal(hash(file.path), file.sha256, 'Source-owner compiler input or output changed')
    }
    if (item.id === 'owner-faults') checkOwner()
    const helpers = item.id === 'primary' ? ['inheritance-library'] : item.id === 'boundary' ? ['inheritance-library', 'inheritance-child'] : []
    if (helpers.length) {
      for (const name of helpers) {
        const helper = bindings[name]
        assert.ok(helper, `Unadmitted SDK helper prevents ${item.id} execution: ${name}`)
        assert.equal(hash(helper.program), helper.oracleSha256, 'Inheritance binary changed before native execution')
        assert.equal(hash(helper.source), helper.oracleSourceSha256, 'Inheritance source changed before native execution')
        assert.equal(hash(helper.compilerLog), helper.compilerLogSha256, 'Inheritance compiler log changed before native execution')
        assert.equal(hash(helper.buildRecord), helper.buildRecordSha256, 'Inheritance build record changed before native execution')
      }
    }
    const reportPath = join(evidence, `windows-${item.id}.json`)
    const args = [join(fixtures, item.file), '--entry', entry, '--oracle', binding.program,
      item.id === 'owner-faults' ? '--report' : '--output', reportPath]
    if (item.id === 'owner-faults') args.push('--fixture', admittedOwnerFault.program, '--source-sha', sourceSha)
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
      if (item.id === 'owner-faults') checkOwner()
      for (const name of helpers) {
        const helper = bindings[name]
        assert.equal(hash(helper.program), helper.oracleSha256); assert.equal(hash(helper.source), helper.oracleSourceSha256)
        assert.equal(hash(helper.compilerLog), helper.compilerLogSha256); assert.equal(hash(helper.buildRecord), helper.buildRecordSha256)
      }
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
    sdkBindings: bindings, ownerFaultBinding: admittedOwnerFault ?? null, prerequisiteErrors: errors,
    matrixBudgets: layout.map(({ id, timeoutMs }) => ({ id, timeoutMs })), specifications, runs, evaluation }
  writeFileSync(join(evidence, 'windows-composite.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return report
}
