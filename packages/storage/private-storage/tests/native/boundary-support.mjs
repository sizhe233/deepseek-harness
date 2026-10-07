/** Synthetic fixture paths and bounded subprocess protocol for packed native artifacts. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Resolve only a newly allocated fixture root; product paths retain literal-name checks. */
export function createFixtureRoot(prefix, requestedParent = tmpdir()) {
  const requestedPath = mkdtempSync(join(requestedParent, prefix))
  try { return { requestedParent, requestedPath, path: realpathSync.native(requestedPath) } }
  catch (error) {
    try { rmdirSync(requestedPath) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture path resolution and cleanup failed') }
    throw error
  }
}

/** Read-only prefix diagnostics retain the first literal-name refusal without changing acceptance. */
export function diagnoseFixtureAncestors(storage, path) {
  const root = win32.parse(path).root, components = path.slice(root.length).split('\\').filter(Boolean)
  const observations = []
  let cleanupUncertain = false
  for (let index = 0; index < components.length; index++) {
    const prefix = win32.join(root, ...components.slice(0, index + 1))
    let directory
    try {
      directory = storage.openPrivateDirectory(prefix, { create: false })
      directory.close()
      observations.push({ path: prefix, component: components[index], outcome: 'opened-and-closed' })
    } catch (error) {
      observations.push({ path: prefix, component: components[index], outcome: 'refused', code: error.code ?? null, reason: error.message })
      cleanupUncertain = directory !== undefined || error.cleanupFailed === true
      if (cleanupUncertain || error.code === 'name') break
    }
  }
  return { diagnosticOnly: true, create: false, cleanupUncertain, observations }
}

export function options(argv) {
  assert.equal(argv.length % 2, 0, 'Expected option/value pairs')
  const result = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--entry', '--oracle', '--output'].includes(argv[i]), 'Unknown boundary option')
    assert.ok(!result.has(argv[i]), 'Duplicate boundary option')
    assert.ok(isAbsolute(argv[i + 1]), 'Boundary paths must be absolute')
    result.set(argv[i], argv[i + 1])
  }
  for (const name of ['--entry', '--oracle', '--output']) assert.ok(result.has(name), `Missing ${name}`)
  return result
}

export const digest = value => createHash('sha256').update(value).digest('hex')
export const fileDigest = path => digest(readFileSync(path))
export const summary = results => Object.fromEntries(['passed', 'failed', 'blocked'].map(status =>
  [status, results.filter(result => result.status === status).length]))

export function fixtureEnvironment(home, temporary) {
  const names = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'COMSPEC', 'ComSpec', 'PATHEXT']
  return { ...Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
    HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary, DSH_TELEMETRY_DISABLED: '1' }
}

export class Blocked extends Error {}

/** These original rows require C-internal fault injection; a JavaScript result wrapper cannot discharge them. */
export const nativeFaultMapping = Object.freeze([
  ...['read', 'publish'].flatMap(mode => [
    { name: `native-${mode}-allocation-baseline`, reason: 'C-owned allocation/query inventory is not observable through the opaque owner' },
    { name: `native-${mode}-allocation-fault-inventory`, reason: 'C-owned allocation/query inventory was not established; zero required ordinals must not be inferred',
      requiredPatterns: [`native-one-shot-${mode === 'publish' ? 'publish-' : ''}alloc:{ordinal}`, `native-one-shot-${mode === 'publish' ? 'publish-' : ''}view:{ordinal}`] },
  ]),
  ...['open-token', 'token-size', 'token-read', 'security', 'security-length', 'file-type', 'file-id',
    'volume', 'native-query', 'native-volume', 'open-file', 'query-short', 'query-oversize',
    'read-failure', 'read-zero', 'read-overrun', 'read-extra-tail', 'read-short',
    'pending-settled', 'pending-unsettled', 'pending-wait-error', 'lock-failure', 'unlock-failure'].map(kind => ({
    name: `native-call-boundary-${kind}`,
    reason: `Original ${kind} requires C-internal Win32/NT return, buffer or completion injection; coarse owner result injection is distinct evidence`,
  })),
].map(row => Object.freeze({ ...row, status: 'blocked', mappedEvidence: 'source-pinned synthetic C owner model only; actual Windows fault obligation remains unmet' })))

/** Full identity encoding shared by the opaque owner and test-only SDK snapshot. */
export function decodeFileIdentity(bytes) {
  assert.equal(bytes.byteLength, 24)
  const value = Buffer.from(bytes)
  return { volumeSerial: value.readBigUInt64LE().toString(16).padStart(16, '0'), fileId: value.subarray(8).toString('hex') }
}

const identityKey = identity => `${identity.volumeSerial}/${identity.fileId}`
const recordKey = record => `${record.handle}/${identityKey(record)}`

/** Baseline runtime handles are excluded; every retained opaque file needs one SDK record. */
export function selectOwnedSnapshot(records, baseline, identities) {
  const previous = new Set(baseline.map(recordKey))
  const selected = records.filter(record => !previous.has(recordKey(record)))
  const counts = values => [...values.reduce((map, value) => {
    const key = identityKey(value); map.set(key, (map.get(key) ?? 0) + 1); return map
  }, new Map())].sort(([a], [b]) => a.localeCompare(b))
  assert.deepEqual(counts(selected), counts(identities), 'Every live opaque capability needs an independently matched SDK handle')
  for (const record of selected) assert.equal(record.flags & 1, 0, 'Storage handles must not be inheritable')
  return selected
}

/** A reused numeric HANDLE is released only when its full identity also differs. */
export function assertSnapshotReleased(previous, current) {
  const live = new Set(current.map(recordKey))
  for (const record of previous) assert.ok(!live.has(recordKey(record)), 'Observed storage HANDLE/full identity survived release')
}

/** Validate bounded SDK records before they can become inheritance or stale-HANDLE evidence. */
export function decodeHandleSnapshot(bytes, count, visited, expected) {
  assert.ok(Number.isInteger(count) && count >= 0 && count <= 4096)
  assert.ok(Number.isInteger(visited) && visited >= count && visited <= 16384)
  assert.equal(bytes.length, 4096 * 40)
  const allowed = new Set(expected.map(identityKey)), seen = new Set(), result = []
  for (let index = 0; index < count; index++) {
    const offset = index * 40
    const handle = bytes.readBigUInt64LE(offset).toString(16).padStart(16, '0')
    assert.notEqual(handle, '0000000000000000')
    assert.notEqual(handle, 'ffffffffffffffff')
    const identity = decodeFileIdentity(bytes.subarray(offset + 8, offset + 32))
    assert.ok(allowed.has(identityKey(identity)), 'SDK must only return requested full identities')
    assert.ok(!seen.has(handle), 'SDK snapshot must not repeat a handle')
    seen.add(handle)
    const flags = bytes.readUInt32LE(offset + 32)
    assert.equal(flags & ~3, 0)
    assert.equal(bytes.readUInt32LE(offset + 36), 0)
    result.push({ handle, ...identity, flags })
  }
  return result
}

/** Bind a compiled SDK helper to this source and its successful, retained compiler record before loading or launching it. */
export function sdkInheritanceBinding(sdkDirectory, kind = 'inheritance-library') {
  assert.ok(['inheritance-library', 'inheritance-child'].includes(kind))
  const checkedDigest = path => {
    const facts = lstatSync(path)
    assert.ok(facts.isFile() && !facts.isSymbolicLink(), 'SDK input must be a regular file')
    return fileDigest(path)
  }
  const buildPath = join(sdkDirectory, 'sdk-matrices-build.json')
  const buildSha256 = checkedDigest(buildPath), build = JSON.parse(readFileSync(buildPath, 'utf8'))
  assert.equal(build.schemaVersion, 1); assert.equal(build.architecture, 'x64')
  assert.ok(Array.isArray(build.fixtures))
  assert.deepEqual(build.fixtures.map(record => record.name).sort(), ['admission', 'inheritance-child', 'inheritance-library'])
  assert.equal(build.complete, build.fixtures.every(record => record.complete === true))
  const record = build.fixtures.find(value => value.name === kind)
  assert.equal(record.complete, true); assert.equal(record.sourceUnchanged, true); assert.equal(record.exitCode, 0)
  assert.equal(record.source, 'boundary-inheritance.c')
  assert.equal(record.binary, kind === 'inheritance-library' ? 'boundary-inheritance.dll' : 'boundary-inheritance-child.exe')
  assert.equal(record.compilerLog, `${kind}-compiler.log`)
  const sourceSha256 = checkedDigest(fileURLToPath(new URL('boundary-inheritance.c', import.meta.url)))
  const binaryPath = join(sdkDirectory, record.binary), binarySha256 = checkedDigest(binaryPath)
  const compilerLogSha256 = checkedDigest(join(sdkDirectory, record.compilerLog))
  assert.equal(record.sourceSha256, sourceSha256)
  assert.equal(record.binarySha256, binarySha256)
  assert.equal(record.producedBinarySha256, binarySha256)
  assert.equal(record.compilerLogSha256, compilerLogSha256)
  assert.equal(checkedDigest(buildPath), buildSha256, 'SDK build record changed during admission')
  return Object.freeze({ binaryPath, binarySha256, sourceSha256, compilerLogSha256, buildSha256 })
}

/** Current-process SDK observation limited to this synthetic root, its retained ancestors and supplied full identities. */
export function sdkHandleObserver(entry, sdkDirectory, rootPath) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
  const binding = sdkInheritanceBinding(sdkDirectory)
  const k = createRequire(entry)('koffi')
  assert.equal(k.version, '3.1.1')
  const helper = k.load(binding.binaryPath)
  assert.deepEqual(sdkInheritanceBinding(sdkDirectory), binding, 'SDK helper changed during loading')
  const snapshot = helper.func('__stdcall', 'dsh_snapshot_matching_files', 'uint32',
    ['void *', 'uint32', 'void *', 'uint32', 'void *', 'void *'])
  const kernel = k.load('kernel32.dll')
  const open = kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
  const identify = kernel.func('__stdcall', 'GetFileInformationByHandleEx', 'int', ['void *', 'int', 'void *', 'uint32'])
  const capture = identities => {
    assert.ok(Array.isArray(identities) && identities.length > 0 && identities.length <= 1024)
    const input = Buffer.alloc(identities.length * 24)
    identities.forEach((identity, index) => {
      assert.match(identity.volumeSerial, /^[0-9a-f]{16}$/); assert.match(identity.fileId, /^[0-9a-f]{32}$/)
      input.writeBigUInt64LE(BigInt(`0x${identity.volumeSerial}`), index * 24)
      Buffer.from(identity.fileId, 'hex').copy(input, index * 24 + 8)
    })
    const output = Buffer.alloc(4096 * 40), count = Buffer.alloc(4), visited = Buffer.alloc(4)
    const error = snapshot(input, identities.length, output, 4096, count, visited)
    assert.equal(error, 0, `Current-process SDK snapshot failed: ${error}`)
    return decodeHandleSnapshot(output, count.readUInt32LE(), visited.readUInt32LE(), identities)
  }
  const scope = []
  for (let path = rootPath;; path = dirname(path)) {
    assert.ok(scope.length < 1024)
    const handle = open(path, 0x80, 7, null, 3, 0x02200000, null)
    assert.ok(handle !== null && handle !== 0n && handle !== 0xffffffffffffffffn)
    try {
      const bytes = Buffer.alloc(24)
      assert.notEqual(identify(handle, 18, bytes, bytes.length), 0)
      scope.push(decodeFileIdentity(bytes))
    } finally { assert.notEqual(close(handle), 0) }
    if (dirname(path) === path) break
  }
  // Existing runtime handles to an ancestor must never be attributed to storage.
  const baseline = capture(scope)
  return Object.freeze({ helper, binding, dllSha256: binding.binarySha256, capture,
    owned(identities) {
      return selectOwnedSnapshot(capture(identities), baseline, identities)
    },
    assertReleased(records) {
      assertSnapshotReleased(records, capture(records))
    },
  })
}

export function oracle(program, env, ...args) {
  const child = spawnSync(program, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  assert.ifError(child.error)
  assert.equal(child.signal, null, 'SDK oracle must complete without interruption')
  const result = JSON.parse(child.stdout)
  if (child.status === 3 && result.status === 'blocked') throw new Blocked(`SDK fixture unavailable: ${result.operation}/${result.win32Error}`)
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.equal(result.complete, true)
  return result
}

/** Every close either observes normal completion or reports a forced teardown. */
export function startChild(program, args, env, { closeTimeoutMs = 30_000 } = {}) {
  assert.ok(Number.isInteger(closeTimeoutMs) && closeTimeoutMs > 0)
  const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  const queued = []
  const waiters = []
  let ended = false
  let processEnded = false
  let teardown
  let failure
  let stderr = ''
  let bytes = 0
  let messageCount = 0
  let lineBytes = 0
  const fail = error => {
    failure ??= error
    for (const waiter of waiters.splice(0)) waiter.reject(error)
    // Stop buffering even if the owned process refuses termination or a
    // descendant still holds an inherited output pipe.
    lines.close()
    child.stdout.destroy()
    child.stderr.destroy()
    child.stdin.destroy()
    if (!processEnded && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) fail(new Error('Boundary child exceeded output limit'))
  })
  child.stderr.on('data', chunk => {
    if (failure) return
    stderr = (stderr + chunk.toString()).slice(0, 16_385)
    if (stderr.length > 16_384) fail(new Error('Boundary child exceeded stderr limit'))
  })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error) })
  lines.on('line', line => {
    if (failure) return
    try {
      lineBytes += Buffer.byteLength(line) + 1
      assert.ok(lineBytes <= 2 * 1024 * 1024, 'Boundary child exceeded line byte limit')
      assert.ok(++messageCount <= 32, 'Boundary child exceeded protocol message limit')
      const message = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(message)
      else {
        assert.ok(queued.length < 8, 'Boundary child exceeded queued message limit')
        queued.push(message)
      }
    } catch (error) { fail(error) }
  })
  const processExit = new Promise(resolveExit => {
    child.once('exit', (code, signal) => { processEnded = true; resolveExit({ code, signal }) })
    child.once('error', () => { processEnded = true; resolveExit({ code: null, signal: null }) })
  })
  const exited = new Promise(resolveExit => {
    child.once('error', fail)
    child.once('close', (code, signal) => {
      ended = true
      lines.close()
      for (const waiter of waiters.splice(0)) waiter.reject(failure ?? new Error(`Boundary child ended before a message: ${code}/${signal}: ${stderr}`))
      resolveExit({ code, signal })
    })
  })
  const closeStreams = () => {
    lines.close()
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
  async function closedWithinBudget() {
    let timer
    try {
      return await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => {
          closeStreams()
          // A failed kill must not keep this controller alive indefinitely.
          // The caller still receives a failure and must retain its temp tree.
          if (!processEnded) child.unref()
          reject(new Error('Boundary child output did not close within teardown budget'))
        }, closeTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  return {
    child, exited, processExit,
    get settled() { return processEnded && ended },
    async next(timeoutMs = 30_000) {
      if (failure) throw failure
      if (queued.length) return queued.shift()
      if (ended) throw new Error(`Boundary child already exited: ${stderr}`)
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) { clearTimeout(timer); resolve(value) },
          reject(error) { clearTimeout(timer); reject(error) },
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Boundary child handshake timed out'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    resume() { assert.ok(!ended); child.stdin.write('\n') },
    async complete() {
      if (!ended) child.stdin.end()
      let forced = false
      const timer = setTimeout(() => {
        forced = true
        if (!processEnded && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, closeTimeoutMs)
      let result
      try { result = await closedWithinBudget() } finally { clearTimeout(timer) }
      assert.equal(forced, false, 'Normal completion must not need forced termination')
      if (failure) throw failure
      assert.equal(result.signal, null)
      assert.equal(result.code, 0, stderr)
      return result
    },
    kill() {
      return teardown ??= (async () => {
        if (!processEnded && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closedWithinBudget()
      })()
    },
  }
}
