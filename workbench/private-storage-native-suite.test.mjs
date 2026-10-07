/** Hypothetical orchestration reports; none establish actual Windows execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { privateStorageNativeContract } from './private-storage-native-contract.mjs'
import { runPackedNativeSuite, validateNativePreflight } from './private-storage-native-suite.mjs'
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const loader = () => ({ nativeExecution: true, platform: 'win32', architecture: 'x64', complete: true,
  summary: { passed: 5, failed: 0, blocked: 0 }, results: ['baseline', 'missing-binary', 'corrupt-binary', 'shadow-object', 'shadow-throw'].map(name => ({ name, status: 'passed' })) })
const observation = report => ({ exitCode: 0, signal: null, timedOut: false, rawReport: JSON.stringify(report) })

for (const [name, change] of [
  ['timeout', run => { run.timedOut = true }], ['exit', run => { run.exitCode = 2 }], ['signal', run => { run.signal = 'SIGKILL' }],
  ['error', run => { run.error = 'launch failed' }], ['report', run => { run.rawReport = null }],
  ['platform', (_run, report) => { report.platform = 'linux' }], ['architecture', (_run, report) => { report.architecture = 'arm64' }],
  ['native', (_run, report) => { report.nativeExecution = false }], ['complete', (_run, report) => { report.complete = false }],
  ['summary', (_run, report) => { report.summary.passed = 4 }], ['missing row', (_run, report) => { report.results.pop() }],
  ['failed row', (_run, report) => { report.results[1].status = 'failed' }],
]) {
  test(`loader prerequisite rejects ${name} evidence`, () => {
    const report = loader(), run = observation(report)
    change(run, report)
    if (run.rawReport !== null) run.rawReport = JSON.stringify(report)
    assert.throws(() => validateNativePreflight('loader', run, {}))
  })
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-suite-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = { toolkit: join(root, 'toolkit'), fixtures: join(root, 'fixtures'), oracleDirectory: join(root, 'oracle'), evidence: join(root, 'evidence'),
    entry: join(root, 'entry.js'), abi: join(root, 'abi.json'), candidateArchive: join(root, 'candidate.tgz'), manifest: join(root, 'candidate.json'),
    sourceSha: 'a'.repeat(40), consumerRoot: join(root, 'consumer') }
  for (const directory of [input.toolkit, input.fixtures, input.oracleDirectory, input.evidence]) mkdirSync(directory)
  for (const file of [input.entry, input.abi, input.candidateArchive, input.manifest,
    ...['windows-oracle.c', 'windows-admission-oracle.c', 'boundary-inheritance.c'].map(name => join(input.fixtures, name))]) writeFileSync(file, `synthetic ${basename(file)}`)
  const calls = []
  let primary, supplemental
  const emit = (name, bytes = `synthetic ${name}`) => { const path = join(input.oracleDirectory, name); writeFileSync(path, bytes); return hash(path) }
  const reports = new Map([['boundary', { results: ['read', 'publish'].map(mode => ({ name: `native-${mode}-allocation-baseline`, status: 'passed', detail: { allocationAttempts: 1, viewAttempts: 1 } })) }]])
  const contract = privateStorageNativeContract(reports)
  const rows = new Map(['primary', 'admission', 'boundary', 'directory'].map(name => [name, new Map()]))
  for (const requirement of contract.requirements) for (const ref of requirement.evidence) rows.get(ref.matrix).set(ref.row, { name: ref.row, status: 'passed' })
  for (const item of contract.replacements) rows.get(item.matrix).set(item.row, { name: item.row, status: 'blocked', reason: 'Retained hypothetical placeholder' })
  for (const row of reports.get('boundary').results) rows.get('boundary').set(row.name, row)
  async function invoke(command, args, options) {
    const file = command === 'pwsh' ? basename(args[args.indexOf('-File') + 1]) : basename(args[0])
    calls.push(file)
    if (file === 'loader-negative.mjs') return observation(loader())
    if (file === 'private-storage-native.ps1') {
      primary = { architecture: 'x64', sourceSha256: hash(join(input.fixtures, 'windows-oracle.c')),
        binarySha256: emit('private-storage-oracle.exe'), compilerLogSha256: emit('compiler.log') }
      writeFileSync(options.reportPath, JSON.stringify(primary)); return observation(primary)
    }
    if (file === 'private-storage-sdk-matrices.ps1') {
      supplemental = { schemaVersion: 1, complete: true, architecture: 'x64', fixtures: [
        ['admission', 'windows-admission-oracle.c', 'private-storage-admission-oracle.exe'],
        ['inheritance-library', 'boundary-inheritance.c', 'boundary-inheritance.dll'],
        ['inheritance-child', 'boundary-inheritance.c', 'boundary-inheritance-child.exe'],
      ].map(([name, source, binary]) => {
        const binarySha256 = emit(binary), compilerLog = `${name}-compiler.log`
        return { name, source, binary, complete: true, sourceUnchanged: true, exitCode: 0,
          binarySha256, producedBinarySha256: binarySha256, sourceSha256: hash(join(input.fixtures, source)), compilerLog, compilerLogSha256: emit(compilerLog) }
      }) }
      writeFileSync(options.reportPath, JSON.stringify(supplemental)); return observation(supplemental)
    }
    if (file === 'abi-acceptance.mjs') return observation({ schemaVersion: 1, complete: true, status: 'passed', check: 'sdk-ffi-abi', nativeExecution: true,
      platform: 'win32', architecture: 'x64', sourceSha: input.sourceSha, oracleSha256: primary.binarySha256, oracleSourceSha256: primary.sourceSha256, abiSha256: hash(input.abi) })
    const id = file === 'acceptance.mjs' ? 'primary' : file === 'admission-matrix.mjs' ? 'admission' : file === 'boundary-matrix.mjs' ? 'boundary' : 'directory'
    if (id === 'boundary') rows.get(id).get('sdk-child-does-not-inherit-private-handles-with-positive-control').detail = {
      sdkDllSha256: supplemental.fixtures[1].binarySha256, sdkChildSha256: supplemental.fixtures[2].binarySha256 }
    const results = [...rows.get(id).values()], summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, results.filter(row => row.status === status).length]))
    const binding = id === 'admission' ? supplemental.fixtures[0] : primary
    return { exitCode: summary.blocked ? 2 : 0, signal: null, timedOut: false, rawReport: JSON.stringify({ schemaVersion: 1,
      nativeExecution: true, platform: 'win32', architecture: 'x64', sourceSha: input.sourceSha, entrySha256: hash(input.entry),
      oracleSha256: binding.binarySha256, oracleSourceSha256: binding.sourceSha256,
      inheritanceSourceSha256: hash(join(input.fixtures, 'boundary-inheritance.c')), results, summary }) }
  }
  return { input, calls, invoke }
}

test('hypothetically complete source-bound preflights and all matrices compose only after every invocation', async t => {
  const f = fixture(t), report = await runPackedNativeSuite(f.input, f.invoke)
  assert.equal(report.complete, true); assert.equal(report.acceptance, 'complete')
  assert.deepEqual(f.calls, ['loader-negative.mjs', 'private-storage-native.ps1', 'private-storage-sdk-matrices.ps1', 'abi-acceptance.mjs',
    'acceptance.mjs', 'admission-matrix.mjs', 'boundary-matrix.mjs', 'directory-boundary-matrix.mjs'])
})

test('a failing loader still runs SDK, ABI and every independent native matrix, then fails the suite', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const run = await f.invoke(...args)
    if (basename(args[1][0]) === 'loader-negative.mjs') run.exitCode = 1
    return run
  })
  assert.equal(report.complete, false); assert.equal(report.matrices.complete, true)
  assert.equal(f.calls.length, 8); assert.equal(report.errors[0].stage, 'loader')
})

test('a missing primary compiler leaves admission independent and all other gaps explicit', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    if (args[0] === 'pwsh' && args[1].includes(join(f.input.toolkit, 'workbench/private-storage-native.ps1'))) throw new Error('SDK unavailable')
    return f.invoke(...args)
  })
  assert.equal(report.complete, false)
  assert.ok(f.calls.includes('private-storage-sdk-matrices.ps1')); assert.ok(f.calls.includes('admission-matrix.mjs'))
  assert.equal(report.matrices.runs.length, 4); assert.equal(report.preflights.find(run => run.name === 'abi').exitCode, null)
})

test('changed candidate inputs prevent later native execution rather than rebinding to new bytes', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const result = await f.invoke(...args)
    writeFileSync(f.input.entry, 'changed candidate entry')
    return result
  })
  assert.equal(report.complete, false)
  assert.deepEqual(f.calls, ['loader-negative.mjs'])
  assert.match(report.matrices.error, /Changed immutable inputs/)
  assert.notEqual(report.entrySha256, hash(f.input.entry))
})

test('ABI evidence cannot be combined with a coherently rebound later SDK binary', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const run = await f.invoke(...args)
    if (basename(args[1][0]) === 'abi-acceptance.mjs') {
      const binary = join(f.input.oracleDirectory, 'private-storage-oracle.exe'), recordPath = join(f.input.oracleDirectory, 'oracle-build.json')
      writeFileSync(binary, 'different native binary')
      const record = JSON.parse(readFileSync(recordPath, 'utf8')); record.binarySha256 = hash(binary)
      writeFileSync(recordPath, JSON.stringify(record))
    }
    return run
  })
  assert.equal(report.complete, false)
  assert.equal(f.calls.includes('acceptance.mjs'), false)
  assert.match(report.matrices.error, /Changed immutable inputs/)
})

test('supplemental compilation cannot replace a primary compiler log or its build record', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const run = await f.invoke(...args)
    if (args[0] === 'pwsh' && basename(args[1][args[1].indexOf('-File') + 1]) === 'private-storage-sdk-matrices.ps1') {
      const log = join(f.input.oracleDirectory, 'compiler.log'), recordPath = join(f.input.oracleDirectory, 'oracle-build.json')
      writeFileSync(log, 'changed primary compiler log')
      const record = JSON.parse(readFileSync(recordPath, 'utf8')); record.compilerLogSha256 = hash(log)
      writeFileSync(recordPath, JSON.stringify(record))
    }
    return run
  })
  assert.equal(report.complete, false)
  assert.equal(f.calls.includes('abi-acceptance.mjs'), false); assert.equal(f.calls.includes('acceptance.mjs'), false)
})

test('compiler output is bound to the exact report returned by its own execution', async t => {
  const f = fixture(t)
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const run = await f.invoke(...args)
    if (args[0] === 'pwsh') writeFileSync(args[2].reportPath, `${run.rawReport}\n`)
    return run
  })
  assert.equal(report.complete, false)
  assert.deepEqual(f.calls, ['loader-negative.mjs', 'private-storage-native.ps1'])
  assert.ok(report.errors.some(row => row.stage === 'primary-compiler-output-binding'))
})

for (const name of ['abi', 'candidateArchive', 'manifest']) {
  test(`a changed ${name} after the primary matrix prevents later native invocation`, async t => {
    const f = fixture(t)
    const report = await runPackedNativeSuite(f.input, async (...args) => {
      const run = await f.invoke(...args)
      if (basename(args[1][0]) === 'acceptance.mjs') writeFileSync(f.input[name], 'changed after first native matrix')
      return run
    })
    assert.equal(report.complete, false)
    assert.equal(f.calls.includes('acceptance.mjs'), true); assert.equal(f.calls.includes('admission-matrix.mjs'), false)
    assert.equal(f.calls.includes('boundary-matrix.mjs'), false); assert.equal(f.calls.includes('directory-boundary-matrix.mjs'), false)
    assert.equal(report.matrices.runs.length, 4)
  })
}

test('a compiler-time rejected log cannot become eligible after a later compiler restores it', async t => {
  const f = fixture(t)
  let originalLog
  const report = await runPackedNativeSuite(f.input, async (...args) => {
    const run = await f.invoke(...args)
    if (args[0] === 'pwsh') {
      const file = basename(args[1][args[1].indexOf('-File') + 1]), log = join(f.input.oracleDirectory, 'compiler.log')
      if (file === 'private-storage-native.ps1') { originalLog = readFileSync(log); writeFileSync(log, 'mismatched at compiler completion') }
      else writeFileSync(log, originalLog)
    }
    return run
  })
  assert.equal(report.complete, false)
  assert.ok(report.errors.some(row => row.stage === 'primary-sdk-binding'))
  assert.equal(f.calls.includes('abi-acceptance.mjs'), false); assert.equal(f.calls.includes('acceptance.mjs'), false)
  assert.ok(f.calls.includes('admission-matrix.mjs'))
  assert.equal(report.matrices.sdkBindings.primary, undefined)
})
