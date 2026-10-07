/** Portable orchestration checks; these never claim Windows storage acceptance. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { fixtureEnvironment, options, startChild, summary, nativeFaultMapping, decodeFileIdentity,
  decodeHandleSnapshot, selectOwnedSnapshot, assertSnapshotReleased, sdkInheritanceBinding, digest } from './boundary-support.mjs'

function sdkBindingFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sdk-binding-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const sourceSha256 = digest(readFileSync(new URL('boundary-inheritance.c', import.meta.url)))
  const fixtures = ['admission', 'inheritance-library', 'inheritance-child'].map(name => {
    const binary = name === 'inheritance-library' ? 'boundary-inheritance.dll' : 'boundary-inheritance-child.exe'
    const bytes = `synthetic binary ${binary}`, log = `synthetic compiler log ${name}`
    writeFileSync(join(directory, binary), bytes)
    writeFileSync(join(directory, `${name}-compiler.log`), log)
    return { name, binary, source: 'boundary-inheritance.c', sourceSha256, sourceUnchanged: true,
      complete: true, exitCode: 0, binarySha256: digest(bytes), producedBinarySha256: digest(bytes),
      compilerLog: `${name}-compiler.log`, compilerLogSha256: digest(log) }
  })
  const build = { schemaVersion: 1, architecture: 'x64', complete: true, fixtures }
  const save = () => writeFileSync(join(directory, 'sdk-matrices-build.json'), JSON.stringify(build))
  save()
  return { directory, build, save }
}

test('SDK helper binding validates source, binary, produced bytes and compiler log before loading', t => {
  const f = sdkBindingFixture(t)
  for (const kind of ['inheritance-library', 'inheritance-child']) {
    const binding = sdkInheritanceBinding(f.directory, kind)
    assert.equal(binding.binarySha256, f.build.fixtures.find(record => record.name === kind).binarySha256)
  }
  writeFileSync(join(f.directory, 'boundary-inheritance.dll'), 'changed synthetic bytes')
  assert.throws(() => sdkInheritanceBinding(f.directory))
})

for (const mutation of ['source', 'produced', 'log', 'duplicate', 'failed', 'path']) {
  test(`SDK helper admission refuses ${mutation} evidence`, t => {
    const f = sdkBindingFixture(t), record = f.build.fixtures[1]
    if (mutation === 'source') record.sourceSha256 = '0'.repeat(64)
    if (mutation === 'produced') record.producedBinarySha256 = '0'.repeat(64)
    if (mutation === 'log') writeFileSync(join(f.directory, record.compilerLog), 'changed log')
    if (mutation === 'duplicate') f.build.fixtures.push(record)
    if (mutation === 'failed') record.exitCode = 1
    if (mutation === 'path') record.binary = '../boundary-inheritance.dll'
    f.save()
    assert.throws(() => sdkInheritanceBinding(f.directory))
  })
}

test('opaque owner migration preserves every internal fault row as blocked and retains dynamic ordinal obligations', () => {
  const kinds = ['open-token', 'token-size', 'token-read', 'security', 'security-length', 'file-type', 'file-id',
    'volume', 'native-query', 'native-volume', 'open-file', 'query-short', 'query-oversize',
    'read-failure', 'read-zero', 'read-overrun', 'read-extra-tail', 'read-short',
    'pending-settled', 'pending-unsettled', 'pending-wait-error', 'lock-failure', 'unlock-failure']
  assert.deepEqual(nativeFaultMapping.map(row => row.name), [
    'native-read-allocation-baseline', 'native-read-allocation-fault-inventory',
    'native-publish-allocation-baseline', 'native-publish-allocation-fault-inventory',
    ...kinds.map(kind => `native-call-boundary-${kind}`),
  ])
  assert.deepEqual(summary(nativeFaultMapping), { passed: 0, failed: 0, blocked: 27 })
  assert.deepEqual(nativeFaultMapping.flatMap(row => row.requiredPatterns ?? []), [
    'native-one-shot-alloc:{ordinal}', 'native-one-shot-view:{ordinal}',
    'native-one-shot-publish-alloc:{ordinal}', 'native-one-shot-publish-view:{ordinal}',
  ])
  for (const row of nativeFaultMapping) {
    assert.match(row.reason, /C-internal|C-owned/)
    assert.match(row.mappedEvidence, /actual Windows fault obligation remains unmet/)
  }
})

test('a non-Windows matrix preserves blocked fault obligations without claiming native acceptance', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-boundary-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('boundary-matrix.mjs', import.meta.url)), output = join(directory, 'result.json')
  const child = spawnSync(process.execPath, [source, '--entry', source, '--oracle', source, '--output', output], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 2, child.stderr)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.nativeExecution, false); assert.equal(report.acceptance, 'partial')
  assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: nativeFaultMapping.length + 1 })
  assert.deepEqual(report.results.slice(0, -1), nativeFaultMapping)
  assert.equal(report.results.at(-1).name, 'prerequisites')
})

function snapshotFixture() {
  const bytes = Buffer.alloc(4096 * 40)
  bytes.writeBigUInt64LE(0x48n)
  bytes.writeBigUInt64LE(0x0123456789abcdefn, 8)
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(bytes, 16)
  return { bytes, identity: decodeFileIdentity(bytes.subarray(8, 32)) }
}

test('SDK snapshot decoding retains all volume and file identity bits and only matching handles', () => {
  const { bytes, identity } = snapshotFixture()
  assert.deepEqual(identity, { volumeSerial: '0123456789abcdef', fileId: '00112233445566778899aabbccddeeff' })
  assert.deepEqual(decodeHandleSnapshot(bytes, 1, 14, [identity]), [{ handle: '0000000000000048', ...identity, flags: 0 }])
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 14, [{ ...identity, volumeSerial: '1123456789abcdef' }]), /requested full identities/)
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 14, [{ ...identity, fileId: '10112233445566778899aabbccddeeff' }]), /requested full identities/)
})

test('malformed or oversized SDK snapshots cannot support lifetime acceptance', () => {
  const { bytes, identity } = snapshotFixture()
  assert.throws(() => decodeHandleSnapshot(bytes, 4097, 4097, [identity]))
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 16385, [identity]))
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 0, [identity]))
  assert.throws(() => decodeHandleSnapshot(bytes.subarray(1), 1, 1, [identity]))
  bytes.copy(bytes, 40, 0, 40)
  assert.throws(() => decodeHandleSnapshot(bytes, 2, 2, [identity]), /repeat a handle/)
  bytes.writeUInt32LE(4, 32)
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 1, [identity]))
  bytes.writeUInt32LE(0, 32); bytes.writeUInt32LE(1, 36)
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 1, [identity]))
  bytes.writeUInt32LE(0, 36); bytes.writeBigUInt64LE(0n)
  assert.throws(() => decodeHandleSnapshot(bytes, 1, 1, [identity]))
})

test('runtime ancestor handles do not mask missing owner handles or inheritability', () => {
  const { bytes, identity } = snapshotFixture()
  const [baseline] = decodeHandleSnapshot(bytes, 1, 1, [identity])
  const owned = { ...baseline, handle: '0000000000000050' }
  assert.deepEqual(selectOwnedSnapshot([baseline, owned], [baseline], [identity]), [owned])
  assert.throws(() => selectOwnedSnapshot([baseline], [baseline], [identity]), /Every live opaque capability/)
  assert.throws(() => selectOwnedSnapshot([owned], [], [identity, identity]), /Every live opaque capability/)
  assert.throws(() => selectOwnedSnapshot([owned, { ...owned, handle: '0000000000000058' }], [], [identity]), /Every live opaque capability/)
  assert.throws(() => selectOwnedSnapshot([{ ...owned, flags: 1 }], [], [identity]), /must not be inheritable/)
})

test('closed handle reuse only passes when the full identity changed', () => {
  const { bytes, identity } = snapshotFixture()
  const [observed] = decodeHandleSnapshot(bytes, 1, 1, [identity])
  assert.throws(() => assertSnapshotReleased([observed], [observed]), /survived release/)
  assertSnapshotReleased([observed], [])
  assertSnapshotReleased([observed], [{ ...observed, fileId: '10112233445566778899aabbccddeeff' }])
  assertSnapshotReleased([observed], [{ ...observed, volumeSerial: '1123456789abcdef' }])
  assertSnapshotReleased([observed], [{ ...observed, handle: '0000000000000050' }])
})

test('boundary workers observe opaque owners and the SDK snapshot never accepts another process', () => {
  for (const name of ['boundary-worker.mjs', 'boundary-live-worker.mjs']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8')
    assert.match(source, /installOwnerObserver\(/)
    assert.doesNotMatch(source, /k\.(?:load|alloc|free|view)\s*=/)
    assert.doesNotMatch(source, /NtCreateFile|NtSetInformationFile/)
  }
  const source = readFileSync(new URL('boundary-inheritance.c', import.meta.url), 'utf8')
  assert.match(source, /PssCaptureSnapshot\(GetCurrentProcess\(\), PSS_CAPTURE_HANDLES, 0, &snapshot\)/)
  assert.match(source, /PssWalkSnapshot\(snapshot, PSS_WALK_HANDLES, marker/)
  assert.match(source, /PssWalkMarkerFree\(marker\)/)
  assert.match(source, /PssFreeSnapshot\(GetCurrentProcess\(\), snapshot\)/)
  assert.doesNotMatch(source, /OpenProcess\(|PSS_CAPTURE_VA_CLONE|PSS_CAPTURE_THREADS/)
})

async function ownedFixtureStopped(pid) {
  const deadline = Date.now() + 5000
  for (;;) {
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return; throw error }
    if (process.platform === 'linux') {
      try {
        // A reparented zombie has exited and owns no pipes; some containers reap later.
        if (/\) Z /u.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return
      } catch (error) { if (error.code === 'ENOENT') return; throw error }
    }
    assert.ok(Date.now() < deadline, 'The synthetic inherited-pipe holder must actually stop')
    await wait(10)
  }
}

test('boundary options require unique known absolute paths', () => {
  const values = ['--entry', resolve('entry.js'), '--oracle', resolve('oracle.exe'), '--output', resolve('result.json')]
  assert.equal(options(values).size, 3)
  assert.throws(() => options(values.slice(0, -1)), /pairs/)
  assert.throws(() => options([...values, '--entry', resolve('other.js')]), /Duplicate/)
  assert.throws(() => options(['--entry', 'relative.js']), /absolute/)
  assert.throws(() => options(['--unexpected', resolve('entry.js')]), /Unknown/)
  assert.throws(() => options(values.slice(0, 4)), /Missing --output/)
})

test('blocked native rows never contribute to passed counts', () => {
  assert.deepEqual(summary([{ status: 'passed' }, { status: 'blocked' }, { status: 'failed' }]),
    { passed: 1, failed: 1, blocked: 1 })
})

test('child environment has isolated homes and no arbitrary inherited credentials or preload', () => {
  const env = fixtureEnvironment(resolve('home'), resolve('temporary'))
  assert.equal(env.HOME, resolve('home'))
  assert.equal(env.USERPROFILE, resolve('home'))
  assert.equal(env.TEMP, resolve('temporary'))
  assert.equal(env.TMP, resolve('temporary'))
  assert.equal(env.NODE_OPTIONS, undefined)
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i)
})

test('independent protocol children resume on their own explicit barriers and exit quiescently', async () => {
  await Promise.all([1, 2].map(async identity => {
    const script = `console.log(JSON.stringify({event:'ready',identity:${identity}}));process.stdin.once('data',()=>{console.log(JSON.stringify({event:'done',identity:${identity}}));process.stdin.pause()})`
    const child = startChild(process.execPath, ['-e', script], process.env)
    try {
      assert.deepEqual(await child.next(), { event: 'ready', identity })
      child.resume()
      assert.deepEqual(await child.next(), { event: 'done', identity })
      assert.deepEqual(await child.complete(), { code: 0, signal: null })
    } finally { await child.kill() }
  }))
})

test('malformed protocol output rejects and terminates only its owned child', async () => {
  const child = startChild(process.execPath, ['-e', "console.log('not-json');setInterval(()=>{},1000)"], process.env)
  try { await assert.rejects(child.next(), SyntaxError) }
  finally { await child.kill() }
})

test('missing second handshake times out after observed readiness and still reaps the child', async () => {
  const child = startChild(process.execPath, ['-e', "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)"], process.env)
  try {
    assert.deepEqual(await child.next(), { ready: true })
    await assert.rejects(child.next(20), /handshake timed out/)
  } finally { await child.kill() }
})

test('stderr bounds fail the protocol rather than retaining unlimited child output', async () => {
  const child = startChild(process.execPath, ['-e', "process.stderr.write('x'.repeat(20000));setInterval(()=>{},1000)"], process.env)
  try { await assert.rejects(child.next(), /stderr limit/) }
  finally { await child.kill() }
})

test('queued protocol floods stop ingestion and destroy streams even when initial kill fails', async () => {
  const script = "process.stdout.on('error',()=>{});console.log(JSON.stringify({ready:true}));process.stdin.once('data',()=>{process.stdout.write(Array.from({length:100},()=>JSON.stringify({data:'x'.repeat(1024)})).join('\\n')+'\\n');setInterval(()=>{},1000)})"
  const child = startChild(process.execPath, ['-e', script], process.env)
  const original = child.child.kill.bind(child.child)
  child.child.kill = () => false
  try {
    assert.deepEqual(await child.next(), { ready: true })
    const stoppedReading = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Flood ingestion was not stopped')), 5000)
      child.child.stdout.once('close', () => { clearTimeout(timer); resolve() })
    })
    child.resume()
    await stoppedReading
    await assert.rejects(child.next(), /queued message limit/)
    assert.equal(child.child.stdout.destroyed, true)
    assert.equal(child.child.stderr.destroyed, true)
    assert.equal(child.child.stdin.destroyed, true)
  } finally {
    child.child.kill = original
    await child.kill()
  }
})

test('an oversized unterminated stdout line stops buffering before a failed kill can extend it', async () => {
  const script = "setTimeout(()=>{process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000)},30)"
  const child = startChild(process.execPath, ['-e', script], process.env)
  const original = child.child.kill.bind(child.child)
  child.child.kill = () => false
  try {
    await assert.rejects(child.next(), /output limit/)
    assert.equal(child.child.stdout.destroyed, true)
    assert.equal(child.child.stderr.destroyed, true)
  } finally {
    child.child.kill = original
    await child.kill()
  }
})

test('kill after process exit waits for delayed inherited pipe closure without signaling again', async () => {
  const script = "const {spawn}=require('node:child_process');const holder=spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{stdio:['ignore',1,2]});console.log(JSON.stringify({ready:true,pid:holder.pid}));process.exit(0)"
  const child = startChild(process.execPath, ['-e', script], process.env)
  const ready = await child.next()
  assert.equal(ready.ready, true)
  assert.ok(Number.isSafeInteger(ready.pid))
  assert.deepEqual(await child.processExit, { code: 0, signal: null })
  let signals = 0
  const original = child.child.kill.bind(child.child)
  child.child.kill = (...args) => { signals++; return original(...args) }
  await Promise.all([child.kill(), child.kill()])
  assert.equal(signals, 0)
  assert.deepEqual(await child.exited, { code: 0, signal: null })
  await ownedFixtureStopped(ready.pid)
})

test('inherited pipes cannot defeat the bounded close wait', async () => {
  const script = "const {spawn}=require('node:child_process');const holder=spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{stdio:['ignore',1,2]});console.log(JSON.stringify({ready:true,pid:holder.pid}));process.exit(0)"
  const child = startChild(process.execPath, ['-e', script], process.env, { closeTimeoutMs: 30 })
  const ready = await child.next()
  assert.equal(ready.ready, true)
  assert.ok(Number.isSafeInteger(ready.pid))
  assert.deepEqual(await child.processExit, { code: 0, signal: null })
  await assert.rejects(child.kill(), /output did not close within teardown budget/)
  assert.equal(child.child.stdout.destroyed, true)
  assert.equal(child.child.stderr.destroyed, true)
  await child.exited
  await ownedFixtureStopped(ready.pid)
})

test('failed forced termination reports an unsettled child and unreferences its process handle', async () => {
  const child = startChild(process.execPath, ['-e', "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)"], process.env, { closeTimeoutMs: 30 })
  const kill = child.child.kill.bind(child.child)
  const unref = child.child.unref.bind(child.child)
  let unreferences = 0
  try {
    assert.deepEqual(await child.next(), { ready: true })
    child.child.kill = () => false
    child.child.unref = () => { unreferences++; return unref() }
    await assert.rejects(child.kill(), /output did not close within teardown budget/)
    assert.equal(child.settled, false)
    assert.equal(unreferences, 1)
  } finally {
    child.child.kill = kill
    child.child.unref = unref
    kill('SIGKILL')
    let timer
    try {
      await Promise.race([child.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned negative-control child did not exit')), 5000)
      })])
    } finally { clearTimeout(timer) }
  }
  assert.equal(child.settled, true)
})
