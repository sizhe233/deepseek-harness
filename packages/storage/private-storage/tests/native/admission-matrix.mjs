/** Real Windows admission fixtures; a blocked setup never satisfies a required case.
 * Build windows-admission-oracle.c with the installed SDK: cl /std:c17 /W4 /WX /link Advapi32.lib
 * Run: node admission-matrix.mjs --entry CONSUMER/package/lib/index.js --oracle ORACLE.exe --output REPORT.json
 * This standalone supplemental matrix does not replace the full packed-candidate acceptance gate.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startAdmissionProcess } from './admission-process.mjs'
import { selectUnsupportedLocalVolumes } from './admission-volumes.mjs'

const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  assert.ok(['--entry', '--oracle', '--output', '--require-complete'].includes(key), `Unknown option ${key}`)
  assert.ok(process.argv[index + 1] && !options.has(key), `Missing or duplicate ${key}`)
  options.set(key, process.argv[index + 1])
}
for (const key of ['--entry', '--oracle', '--output']) assert.ok(options.has(key), `Missing ${key}`)
if (options.has('--require-complete')) assert.ok(['true', 'false'].includes(options.get('--require-complete')))
const entry = resolve(options.get('--entry'))
const oraclePath = resolve(options.get('--oracle'))
const output = resolve(options.get('--output'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const required = [
  'conditional-acl-admission', 'malformed-acl-os-rejection', 'malformed-descriptor-os-rejection',
  'junction-admission', 'unknown-reparse-admission', 'short-name-alias-admission',
  'case-sensitive-directory-admission', 'named-pipe-admission', 'device-namespace-admission',
  'unsupported-volume-admission', 'real-storage-failure',
]
const report = {
  schemaVersion: 1, evidence: 'native-sdk-admission-matrix', platform: process.platform,
  sourceSha: process.env.CANDIDATE_SHA ?? null,
  architecture: process.arch, node: process.version, osRelease: release(), nativeExecution: false,
  complete: false, results: required.map(name => ({ name, status: 'blocked', reason: 'Native case has not executed' })),
  diagnostics: {},
  scope: [
    { name: 'private-plugin-composition', status: 'separate-requirement' },
    { name: 'windows-arm64', status: 'out-of-scope', reason: 'Untested; Windows x64 only' },
    { name: 'abrupt-power-loss', status: 'out-of-scope', reason: 'Empirical power-cut testing is unperformed' },
  ],
}
class Blocked extends Error {
  constructor(message, observation) { super(message); this.observation = observation }
}
function result(name, value) {
  const index = report.results.findIndex(row => row.name === name)
  if (index < 0) report.results.push({ name, ...value })
  else report.results[index] = { name, ...value }
}
async function check(name, operation) {
  try { result(name, { status: 'passed', detail: await operation() }) }
  catch (error) {
    result(name, { status: error instanceof Blocked ? 'blocked' : 'failed', reason: String(error.message),
      ...(error.observation === undefined ? {} : { observation: error.observation }),
      ...(error.code === undefined ? {} : { code: error.code }) })
  }
}
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|NODE_OPTIONS|NODE_PATH)/i.test(name)))
function oracle(...args) {
  const child = spawnSync(oraclePath, args, { encoding: 'utf8', env: childEnv, timeout: 30_000, windowsHide: true })
  assert.ifError(child.error)
  assert.equal(child.signal, null, `Oracle ${args[0]} interrupted`)
  const observation = JSON.parse(child.stdout)
  if (child.status === 3 && observation.status === 'blocked') throw new Blocked(`SDK setup unavailable: ${observation.operation}`, observation)
  assert.equal(child.status, 0, `Oracle ${args[0]} failed: ${child.stdout || child.stderr}`)
  assert.equal(observation.complete, true)
  report.nativeExecution = true
  return observation
}
function snapshot(path) { return oracle('inspect', path).facts }
function rejected(operation, codes) {
  assert.throws(operation, error => {
    assert.equal(error.name, 'PrivateStorageError')
    assert.ok(codes.includes(error.code), `Expected ${codes.join('/')} rejection, received ${error.code}`)
    if (error.code === 'native') assert.ok([0xc000050b, 0xc0000279, 0x8000002d].includes(error.nativeStatus),
      `Reparse rejection must report a reparse-specific native status, received ${error.nativeStatus}`)
    return true
  })
}
let sandbox, storage, root, rootPath
const reparseFixtures = new Map()
const reparseAttempts = new Set()
const ownedChildren = new Map()
let processCleanupUncertain = false
function requireRoot() { if (!root) throw new Blocked('Private root admission prerequisite failed') }
function published(receipt) {
  assert.equal(receipt.publication, 'published')
  assert.equal(receipt.durability, 'synced')
  assert.deepEqual(receipt.parentIdentity, root.identity)
}
function unchanged(path, before, operation) {
  const names = readdirSync(rootPath).sort()
  operation()
  assert.deepEqual(snapshot(path), before, 'Rejected admission changed fixture identity, security or file facts')
  assert.deepEqual(readdirSync(rootPath).sort(), names, 'Rejected admission changed parent entries')
}

/** Keep every started pipe fixture owned until a bounded teardown has settled. */
function startOwned(command, args) {
  const controller = startAdmissionProcess(command, args, {
    env: childEnv,
    onClosed() { ownedChildren.delete(controller) },
    onUncertain(observation) {
      processCleanupUncertain = true
      report.diagnostics.processCleanup = observation
      ownedChildren.delete(controller)
    },
  })
  ownedChildren.set(controller, controller)
  return controller
}

try {
  report.entrySha256 = sha256(entry)
  report.oracleSha256 = sha256(oraclePath)
  report.oracleSourceSha256 = sha256(fileURLToPath(new URL('windows-admission-oracle.c', import.meta.url)))
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Requires actual Windows x64; no native cases ran')
  assert.match(entry, /\.js$/i, 'Pass the packed JavaScript export')
  sandbox = mkdtempSync(join(tmpdir(), 'private-storage-admission-'))
  report.diagnostics.inventory = oracle('inventory')
  report.diagnostics.driveBootstrap = oracle('bootstrap', sandbox)
  const inventory = report.diagnostics.inventory
  assert.equal(inventory.privilegesEnabled, false)
  assert.equal(inventory.threadTokenPresent, false, 'Fixture process must start without impersonation')
  assert.equal(inventory.threadTokenError, 1008)
  assert.equal(inventory.restricted, false, 'Fixture setup requires an ordinary process token')
  const unsupported = selectUnsupportedLocalVolumes(inventory.volumes)
  result('unsupported-volume-admission', { status: 'blocked', reason: unsupported.length
    ? 'Local unsupported volume probe has not executed'
    : 'Read-only inventory found no mounted local drive with readable metadata for an unsupported filesystem, read-only volume or RAM disk; remote and unknown mappings were not queried',
  observation: { candidates: unsupported, unreadable: inventory.volumes.filter(volume => !volume.metadataAvailable) } })
  result('real-storage-failure', { status: 'blocked', reason: 'No real write/flush storage failure was induced; volume free-space observations are diagnostic, not storage-failure evidence',
    observation: { destructiveSetupPerformed: false, volumeInventoryRecorded: true } })
  storage = await import(pathToFileURL(entry).href)
  report.capabilities = storage.capabilities()
  if (!report.capabilities.available) throw new Blocked('Packed backend is unavailable', report.capabilities)
  if (unsupported.length) await check('unsupported-volume-admission', async () => {
    const volume = unsupported[0]
    assert.ok([2, 3, 5, 6].includes(volume.driveType) && volume.metadataAttempted && !volume.remote)
    const worker = startOwned(process.execPath, [fileURLToPath(new URL('admission-volume-worker.mjs', import.meta.url)),
      entry, volume.root, String(volume.driveType)])
    try {
      const observed = await worker.next()
      if (observed.status === 'blocked') throw new Blocked('Local unsupported volume prerequisite unavailable', observed)
      assert.equal(observed.complete, true)
      assert.equal(observed.readOnly, true)
      assert.equal(observed.create, false)
      assert.equal(observed.nameAbsentBefore, true)
      assert.equal(observed.nameAbsentAfter, true)
      assert.equal(observed.rejection.code, 'unsupported')
      await worker.close()
      return { volume, observation: observed, testedScope: 'One observed local unsupported volume; other filesystem classes remain untested' }
    } finally { await worker.kill() }
  })
  rootPath = join(sandbox, 'private')
  await check('private-root-prerequisite', () => {
    root = storage.openPrivateDirectory(rootPath, { create: true })
    assert.deepEqual(root.identity, snapshot(rootPath).identity)
    return { identity: root.identity }
  })

  await check('conditional-acl-admission', () => {
    requireRoot()
    const name = 'conditional.bin', path = join(rootPath, name)
    const created = oracle('conditional', path)
    const callback = created.facts.aces.find(ace => ace.type === 9)
    assert.ok(callback, 'OS must actually store a callback allow ACE')
    const bytes = Buffer.from(callback.rawHex, 'hex')
    assert.ok(bytes.length >= 16 && bytes[8] === 1)
    const conditionOffset = 8 + 8 + 4 * bytes[9]
    assert.ok(conditionOffset + 4 < bytes.length, 'A callback header alone is not a conditional ACE')
    assert.equal(bytes.subarray(conditionOffset, conditionOffset + 4).toString('ascii'), 'artx', 'Stored condition must have Windows conditional-expression signature')
    unchanged(path, created.facts, () => {
      rejected(() => storage.inspectPrivate(root, name), ['privacy'])
      rejected(() => storage.readPrivateFile(root, name, 1), ['privacy'])
      rejected(() => storage.replacePrivateFile(root, name, Uint8Array.of(1)), ['privacy'])
    })
    return { condition: created.condition, callback, identity: created.facts.identity }
  })
  let malformed
  await check('malformed-acl-os-rejection', () => {
    requireRoot()
    malformed = oracle('malformed', join(rootPath, 'malformed-attempt.bin'))
    assert.equal(malformed.submission, 'NtSetSecurityObject')
    assert.ok([0xc0000077, 0xc0000079, 0xc0000058].includes(malformed.aclRevisionStatus >>> 0), 'Kernel must reject invalid ACL revision')
    assert.equal(malformed.unchanged, true)
    assert.deepEqual(malformed.before, malformed.after)
    assert.deepEqual(storage.inspectPrivate(root, 'malformed-attempt.bin').identity, malformed.before.identity)
    return { nativeStatus: malformed.aclRevisionStatus, unchanged: true, identity: malformed.before.identity }
  })
  await check('malformed-descriptor-os-rejection', () => {
    if (!malformed) throw new Blocked('Malformed descriptor fixture did not execute')
    assert.ok([0xc0000079, 0xc0000058].includes(malformed.descriptorRevisionStatus >>> 0), 'Kernel must reject invalid descriptor revision')
    assert.equal(malformed.unchanged, true)
    assert.deepEqual(malformed.before, malformed.after)
    return { nativeStatus: malformed.descriptorRevisionStatus, unchanged: true, testedScope: 'OS rejects invalid submission; no malformed descriptor persisted on disk' }
  })
  for (const kind of ['junction', 'unknown-reparse']) {
    await check(`${kind}-admission`, () => {
      requireRoot()
      const name = `${kind}-entry`, path = join(rootPath, name)
      let target, targetBefore, sentinel
      if (kind === 'junction') {
        target = join(sandbox, 'junction-target')
        mkdirSync(target)
        sentinel = join(target, 'sentinel.bin')
        writeFileSync(sentinel, 'synthetic-target-marker')
        targetBefore = snapshot(sentinel)
      }
      reparseAttempts.add(path)
      const created = oracle(kind, path, ...(target ? [target] : []))
      reparseFixtures.set(path, created.facts.identity)
      reparseAttempts.delete(path)
      assert.equal(created.facts.reparseTag, kind === 'junction' ? 0xa0000003 : 0x42)
      assert.equal(created.facts.attributes & 0x400, 0x400)
      unchanged(path, created.facts, () => {
        rejected(() => storage.openPrivateChild(root, name), ['unsupported', 'native'])
        rejected(() => storage.openPrivateDirectory(path, { create: false }), ['unsupported', 'native'])
        rejected(() => storage.inspectPrivate(root, name), ['unsupported', 'native'])
      })
      if (target) {
        assert.deepEqual(snapshot(sentinel), targetBefore)
        assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic-target-marker')
        assert.deepEqual(readdirSync(target), ['sentinel.bin'])
      }
      return { tag: created.tag, identity: created.facts.identity, privilegesEnabled: created.privilegesEnabled, sentinelUnchanged: Boolean(target) }
    })
  }
  await check('short-name-alias-admission', () => {
    requireRoot()
    const name = 'LongSyntheticAdmissionRecordName.bin', path = join(rootPath, name)
    published(storage.createPrivateFileExclusive(root, name, Uint8Array.of(7, 8, 9)))
    const alias = oracle('short-name', path)
    assert.notEqual(alias.alias, name)
    assert.deepEqual(alias.original.identity, alias.aliased.identity)
    assert.deepEqual(alias.original, alias.aliased)
    unchanged(path, alias.original, () => {
      rejected(() => storage.inspectPrivate(root, alias.alias), ['name'])
      rejected(() => storage.readPrivateFile(root, alias.alias, 3), ['name'])
      rejected(() => storage.replacePrivateFile(root, alias.alias, Uint8Array.of(1)), ['name'])
    })
    assert.deepEqual(storage.readPrivateFile(root, name, 3), Uint8Array.of(7, 8, 9))
    return { alias: alias.alias, identity: alias.original.identity, shortNameConfigurationChanged: false }
  })
  await check('case-sensitive-directory-admission', () => {
    requireRoot()
    const name = 'case-sensitive', path = join(rootPath, name)
    const observed = oracle('case-sensitive', path)
    assert.equal(observed.flags, 1)
    assert.equal(observed.distinctFileIds, true)
    const before = snapshot(path)
    const children = ['case', 'Case'].map(leaf => snapshot(join(path, leaf)))
    unchanged(path, before, () => {
      rejected(() => storage.openPrivateChild(root, name), ['unsupported'])
      rejected(() => storage.openPrivateDirectory(path, { create: false }), ['unsupported'])
    })
    assert.deepEqual(['case', 'Case'].map(leaf => snapshot(join(path, leaf))), children)
    return observed
  })
  await check('device-namespace-admission', () => {
    requireRoot()
    const names = readdirSync(rootPath).sort()
    for (const path of ['\\\\.\\NUL', '\\\\?\\GLOBALROOT\\Device\\Null', '\\Device\\Null'])
      rejected(() => storage.openPrivateDirectory(path, { create: false }), ['name'])
    for (const name of ['NUL', 'CON', 'CONIN$', 'CONOUT$', 'COM1', 'LPT1'])
      rejected(() => storage.inspectPrivate(root, name), ['name'])
    assert.deepEqual(readdirSync(rootPath).sort(), names)
    return { testedScope: 'Public namespace admission; no device opened or configured' }
  })
  await check('named-pipe-admission', async () => {
    requireRoot()
    const name = `\\\\.\\pipe\\private-storage-admission-${randomUUID()}`
    const pipe = startOwned(oraclePath, ['pipe', name])
    try {
      const ready = await pipe.next()
      if (ready.status === 'blocked') throw new Blocked('Native named-pipe setup unavailable', ready)
      assert.equal(ready.complete, true)
      assert.equal(ready.ready, true)
      assert.equal(ready.fileType, 3)
      assert.equal(ready.remoteClientsRejected, true)
      const names = readdirSync(rootPath).sort()
      rejected(() => storage.openPrivateDirectory(name, { create: false }), ['name'])
      assert.deepEqual(readdirSync(rootPath).sort(), names)
      await pipe.close()
      return { actualNamedPipe: true, remoteClientsRejected: true, admission: 'name', serverClosed: true }
    } finally { await pipe.kill() }
  })
} catch (error) {
  result('native-prerequisite', { status: error instanceof Blocked ? 'blocked' : 'failed', reason: String(error.message),
    ...(error.observation === undefined ? {} : { observation: error.observation }) })
} finally {
  for (const controller of ownedChildren.values()) await check('stop-owned-process', () => controller.kill())
  let cleanupSafe = reparseAttempts.size === 0 && !processCleanupUncertain
  if (root) await check('close-private-root', () => {
    try { root.close() } catch (error) { cleanupSafe = false; throw error }
  })
  if (reparseAttempts.size) result('withheld-reparse-cleanup', { status: 'blocked',
    reason: 'Reparse setup did not return a verified full identity; recursive cleanup is withheld',
    observation: { attemptedPaths: [...reparseAttempts] } })
  for (const [path, identity] of reparseFixtures) {
    await check(`clear-owned-reparse-${identity.fileId}`, () => {
      try {
        assert.equal(oracle('clear-reparse', path, identity.volumeSerial, identity.fileId).tagCleared, true)
        const after = snapshot(path)
        assert.deepEqual(after.identity, identity)
        assert.equal(after.reparseTag, 0)
      } catch (error) { cleanupSafe = false; throw error }
    })
  }
  if (sandbox && cleanupSafe) await check('remove-owned-fixtures', () => {
    try { rmSync(sandbox, { recursive: true, force: true }) }
    catch (error) { report.retainedFixtureRoot = sandbox; throw error }
  })
  else if (sandbox) report.retainedFixtureRoot = sandbox
  report.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, report.results.filter(row => row.status === status).length]))
  report.complete = report.summary.failed === 0 && report.summary.blocked === 0
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ complete: report.complete, summary: report.summary, report: output }))
  process.exitCode = report.summary.failed ? 1 : options.get('--require-complete') === 'true' && report.summary.blocked ? 2 : 0
}
