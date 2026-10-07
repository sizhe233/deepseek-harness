/** Synthetic SDK/report orchestration, never Windows execution evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { bindNativeMatrixOracles, runPackedNativeMatrices } from './private-storage-native-matrices.mjs'

import { PRIVATE_STORAGE_CLAIM } from './private-storage-applicability.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-matrices-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixtures = join(root, 'fixtures'), oracleDirectory = join(root, 'oracle'), evidence = join(root, 'evidence')
  for (const dir of [fixtures, oracleDirectory, evidence]) mkdirSync(dir)
  const put = (dir, name) => { const bytes = `synthetic non-executable ${name}`; writeFileSync(join(dir, name), bytes); return digest(bytes) }
  const sourceSha256 = put(fixtures, 'windows-oracle.c'), binarySha256 = put(oracleDirectory, 'private-storage-oracle.exe')
  const compilerLogSha256 = put(oracleDirectory, 'compiler.log')
  const primary = { architecture: 'x64', sourceSha256, binarySha256, compilerLogSha256 }
  writeFileSync(join(oracleDirectory, 'oracle-build.json'), JSON.stringify(primary))
  const sources = new Map()
  const records = [
    ['admission', 'windows-admission-oracle.c', 'private-storage-admission-oracle.exe'],
    ['inheritance-library', 'boundary-inheritance.c', 'boundary-inheritance.dll'],
    ['inheritance-child', 'boundary-inheritance.c', 'boundary-inheritance-child.exe'],
  ].map(([name, source, binary]) => {
    if (!sources.has(source)) sources.set(source, put(fixtures, source))
    const binarySha256 = put(oracleDirectory, binary), compilerLog = `${name}-compiler.log`
    return { name, source, binary, sourceSha256: sources.get(source), binarySha256, producedBinarySha256: binarySha256,
      compilerLog, compilerLogSha256: put(oracleDirectory, compilerLog), complete: true, sourceUnchanged: true, exitCode: 0 }
  })
  const supplemental = { schemaVersion: 1, architecture: 'x64', complete: true, fixtures: records }
  const seal = () => writeFileSync(join(oracleDirectory, 'sdk-matrices-build.json'), JSON.stringify(supplemental))
  seal()
  const entry = join(root, 'index.js'); writeFileSync(entry, 'export const synthetic=true')
  const candidateArchive = join(root, 'candidate.tgz'), manifest = join(root, 'candidate.json')
  writeFileSync(candidateArchive, 'synthetic'); writeFileSync(manifest, '{}')
  return { fixtures, oracleDirectory, evidence, entry, candidateArchive, manifest, sourceSha: 'a'.repeat(40), primary, supplemental, seal }
}

test('binds every SDK source, binary and compiler log to its exact build record', t => {
  const f = fixture(t), result = bindNativeMatrixOracles(f.fixtures, f.oracleDirectory)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(Object.keys(result.bindings), ['primary', 'admission', 'inheritance-library', 'inheritance-child'])
  writeFileSync(join(f.fixtures, 'boundary-inheritance.c'), 'changed source')
  const changed = bindNativeMatrixOracles(f.fixtures, f.oracleDirectory)
  assert.equal(changed.bindings['inheritance-library'], undefined); assert.equal(changed.bindings['inheritance-child'], undefined)
  assert.equal(changed.errors.length, 2); assert.ok(changed.bindings.primary && changed.bindings.admission)
})

for (const field of ['source', 'binary', 'compilerLog', 'sourceSha256', 'binarySha256', 'producedBinarySha256', 'compilerLogSha256', 'complete', 'sourceUnchanged', 'exitCode']) {
  test(`rejects changed admission SDK ${field} without discarding independent primary binding`, t => {
    const f = fixture(t)
    f.supplemental.fixtures[0][field] = field === 'complete' || field === 'sourceUnchanged' ? false : field === 'exitCode' ? 1 : 'different'
    f.supplemental.complete = f.supplemental.fixtures.every(item => item.complete === true); f.seal()
    const result = bindNativeMatrixOracles(f.fixtures, f.oracleDirectory)
    assert.ok(result.bindings.primary); assert.equal(result.bindings.admission, undefined); assert.equal(result.errors.length, 1)
  })
}

test('attempts all four matrices after failed, blocked, invalid and throwing siblings', async t => {
  const f = fixture(t), attempted = []
  const result = await runPackedNativeMatrices(f, async (_command, args, options) => {
    const name = args[0].split('/').at(-1); attempted.push(name)
    assert.equal(options.env.CANDIDATE_SHA, f.sourceSha)
    if (name === 'acceptance.mjs') {
      assert.ok(args.includes('--require-complete')); assert.equal(args.at(-1), 'true')
      return { exitCode: 2, signal: null, timedOut: false, rawReport: null }
    }
    if (name === 'admission-matrix.mjs') { assert.equal(args.at(-2), '--require-complete'); assert.equal(args.at(-1), 'true'); throw new Error('Owned launch failure') }
    return { exitCode: 1, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.deepEqual(attempted, ['acceptance.mjs', 'admission-matrix.mjs', 'boundary-matrix.mjs', 'directory-boundary-matrix.mjs'])
  assert.equal(result.complete, false); assert.equal(result.runs.length, 4)
  assert.equal(result.runs[1].error, 'Owned launch failure')
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence, 'windows-composite.json'), 'utf8')), result)
})

test('an absent primary oracle still permits independent admission evidence collection', async t => {
  const f = fixture(t), attempted = []
  rmSync(join(f.oracleDirectory, 'private-storage-oracle.exe'))
  const result = await runPackedNativeMatrices(f, async (_command, args) => {
    attempted.push(args[0].split('/').at(-1)); return { exitCode: 2, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.deepEqual(attempted, ['admission-matrix.mjs'])
  assert.equal(result.complete, false); assert.equal(result.acceptance, 'failed'); assert.equal(result.runs.length, 4)
  assert.equal(result.prerequisiteErrors[0].stage, 'primary-sdk-binding')
})

test('a changed SDK binary during execution cannot be accepted and later matrices are still attempted', async t => {
  const f = fixture(t), attempted = []
  const result = await runPackedNativeMatrices(f, async (_command, args) => {
    const name = args[0].split('/').at(-1); attempted.push(name)
    if (name === 'acceptance.mjs') writeFileSync(join(f.oracleDirectory, 'private-storage-oracle.exe'), 'changed')
    return { exitCode: 0, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.equal(result.complete, false); assert.match(result.runs[0].error, /binary changed/); assert.deepEqual(attempted, ['acceptance.mjs', 'admission-matrix.mjs']);
  assert.match(result.runs[2].error, /before native execution/); assert.match(result.runs[3].error, /before native execution/)
})

test('rejected inheritance artifacts never execute while other independent matrices still run', async t => {
  const f = fixture(t), attempted = []
  writeFileSync(join(f.oracleDirectory, 'boundary-inheritance.dll'), 'unadmitted')
  const result = await runPackedNativeMatrices(f, async (_command, args) => {
    attempted.push(args[0].split('/').at(-1)); return { exitCode: 2, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.deepEqual(attempted, ['acceptance.mjs', 'admission-matrix.mjs', 'directory-boundary-matrix.mjs'])
  assert.equal(result.complete, false)
  assert.match(result.runs.find(run => run.matrix === 'boundary').error, /Unadmitted SDK helper/)
})

for (const filename of ['private-storage-admission-oracle.exe', 'admission-compiler.log', 'sdk-matrices-build.json']) {
  test(`a prior sibling cannot substitute ${filename} before admission execution`, async t => {
    const f = fixture(t), attempted = []
    const result = await runPackedNativeMatrices(f, async (_command, args) => {
      const name = args[0].split('/').at(-1); attempted.push(name)
      if (name === 'acceptance.mjs') writeFileSync(join(f.oracleDirectory, filename), 'changed by prior synthetic sibling')
      return { exitCode: 2, signal: null, timedOut: false, rawReport: '{}' }
    })
    assert.equal(attempted.includes('admission-matrix.mjs'), false)
    assert.match(result.runs.find(run => run.matrix === 'admission').error, /before native execution/)
    assert.equal(result.complete, false)
  })
}

test('an explicit compiler-time admission set cannot be expanded by fresh on-disk rebinding', async t => {
  const f = fixture(t), attempted = []
  const admitted = bindNativeMatrixOracles(f.fixtures, f.oracleDirectory)
  delete admitted.bindings.admission
  const result = await runPackedNativeMatrices({ ...f, admittedOracles: admitted }, async (_command, args) => {
    attempted.push(basename(args[0])); return { exitCode: 2, signal: null, timedOut: false, rawReport: '{}' }
  })
  assert.equal(attempted.includes('admission-matrix.mjs'), false)
  assert.equal(result.sdkBindings.admission, undefined); assert.equal(result.complete, false)
})


test('a declared profile must match the immutable candidate manifest before invoking a matrix', async t => {
  const f = fixture(t)
  let calls = 0
  const invoke = async () => { calls++; throw new Error('Synthetic unavailable process') }
  await assert.rejects(runPackedNativeMatrices({ ...f, claim: PRIVATE_STORAGE_CLAIM }, invoke), /claim is required/)
  assert.equal(calls, 0)
  writeFileSync(f.manifest, JSON.stringify({ privateStorageAcceptance: { claim: { ...PRIVATE_STORAGE_CLAIM,
    requiredConditions: ['admission/cloud-reparse-admission'] } } }))
  await assert.rejects(runPackedNativeMatrices({ ...f, claim: PRIVATE_STORAGE_CLAIM }, invoke), /differs from immutable/)
  assert.equal(calls, 0)
  writeFileSync(f.manifest, JSON.stringify({ privateStorageAcceptance: { claim: PRIVATE_STORAGE_CLAIM } }))
  const result = await runPackedNativeMatrices({ ...f, claim: PRIVATE_STORAGE_CLAIM }, invoke)
  assert.equal(calls, 4)
  assert.deepEqual(result.claim, PRIVATE_STORAGE_CLAIM)
  assert.deepEqual(result.evaluation.claim, PRIVATE_STORAGE_CLAIM)
  assert.equal(result.complete, false)
  assert.equal(result.expandedComplete, false)
})
