/** Native, synthetic, built-artifact acceptance. Blocked rows are evidence gaps, never passes. */
import assert from 'node:assert/strict'
import { createFixtureRoot, sdkInheritanceBinding } from './boundary-support.mjs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startPrimaryProcess } from './primary-process.mjs'
import { validatePrimaryTokenPair } from './primary-token-evidence.mjs'
import { ownerBinding } from './owner-observer.mjs'

const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i]?.startsWith('--') && process.argv[i + 1], 'Expected --option value pairs')
  assert.ok(!options.has(process.argv[i]), `Duplicate option ${process.argv[i]}`)
  options.set(process.argv[i], process.argv[i + 1])
}
for (const required of ['--oracle', '--entry', '--output']) assert.ok(options.has(required), `Missing ${required}`)
const oraclePath = resolve(options.get('--oracle'))
const entry = resolve(options.get('--entry'))
const output = resolve(options.get('--output'))
const fixture = fileURLToPath(new URL('process-fixture.mjs', import.meta.url))
const faultFixture = fileURLToPath(new URL('fault-worker.mjs', import.meta.url))
const gcFixture = fileURLToPath(new URL('gc-worker.mjs', import.meta.url))
const tokenFixture = fileURLToPath(new URL('token-worker.mjs', import.meta.url))
const descriptorFixture = fileURLToPath(new URL('descriptor-buffer-worker.mjs', import.meta.url))
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const report = {
  schemaVersion: 1,
  evidence: 'native-synthetic-acceptance-harness',
  nativeExecution: process.platform === 'win32' && process.arch === 'x64',
  acceptance: 'incomplete',
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  osRelease: release(),
  sourceSha: options.get('--source-sha') ?? null,
  entrySha256: sha256(entry),
  oracleSha256: sha256(oraclePath),
  oracleSourceSha256: sha256(fileURLToPath(new URL('windows-oracle.c', import.meta.url))),
  candidateArchiveSha256: options.has('--candidate-archive') ? sha256(resolve(options.get('--candidate-archive'))) : null,
  dependencyManifestSha256: options.has('--manifest') ? sha256(resolve(options.get('--manifest'))) : null,
  results: [],
}
report.results.push(
    { name: 'private-plugin-composition', status: 'separate-requirement', reason: 'Private consumer composition remains a separate merge-level requirement; no private checkout or artifact is allowed in this public suite' },
    { name: 'windows-arm64', status: 'out-of-scope', reason: 'This job tests Windows x64 only; arm64 is untested and no arm64 support is claimed' },
    { name: 'abrupt-power-loss', status: 'out-of-scope', reason: 'Empirical power-cut testing is unperformed and outside this documented OS-contract conformance gate' },
  )
let sandbox
let storage
let root
let rootPath
let token
const directories = []
const children = new Set()
let processCleanupUncertain = false
const links = new Set()
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(name)))

class Blocked extends Error {}

function blocked(name, reason) {
  report.results.push({ name, status: 'blocked', reason })
}

async function check(name, operation) {
  try {
    const detail = await operation()
    report.results.push({ name, status: 'passed', ...(detail === undefined ? {} : { detail }) })
  } catch (error) {
    report.results.push({ name, status: error instanceof Blocked ? 'blocked' : 'failed', reason: String(error.message),
      ...(error.code === undefined ? {} : { code: error.code }), ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
      ...(error.observation === undefined ? {} : { observation: error.observation }) })
  }
}

function oracle(...args) {
  const child = spawnSync(oraclePath, args, { encoding: 'utf8', env: childEnv, timeout: 30_000, windowsHide: true })
  if (args[0] === 'primary-process' && (child.error || child.signal)) processCleanupUncertain = true
  assert.ifError(child.error)
  assert.equal(child.signal, null, `Oracle ${args[0]} was interrupted`)
  let result
  try { result = JSON.parse(child.stdout) }
  catch (error) { if (args[0] === 'primary-process') processCleanupUncertain = true; throw error }
  if (args[0] === 'primary-process' && result.operation === 'primary child cleanup unconfirmed') processCleanupUncertain = true
  if (child.status === 3 && result.status === 'blocked') throw new Blocked(`Native fixture ${result.operation} unavailable, Win32 ${result.win32Error ?? 'n/a'}, NTSTATUS ${result.nativeStatus ?? 'n/a'}`)
  assert.equal(child.status, 0, `Oracle ${args[0]} failed: ${child.stdout || child.stderr}`)
  assert.equal(result.complete, true)
  return result
}

function snapshot(path) {
  const facts = oracle('inspect', path)
  return { identity: facts.identity, ownerSid: facts.ownerSid, control: facts.descriptorControl, aces: facts.aces,
    directory: facts.directory, links: facts.links, sizeBytes: facts.sizeBytes, reparseTag: facts.reparseTag }
}

function privateFacts(facts, directory) {
  assert.equal(facts.complete, true)
  assert.equal(facts.ownerSid, token.userSid)
  assert.equal(facts.daclPresent, true)
  assert.equal(facts.daclNull, false)
  assert.equal(facts.daclProtected, true)
  assert.equal(facts.directory, directory)
  assert.equal(facts.fileType, 1)
  assert.equal(facts.reparseTag, 0)
  assert.equal(facts.filesystem, 'NTFS')
  assert.equal(facts.remote, false)
  assert.equal(facts.filesystemFlags & 8, 8, 'Volume must support persistent ACLs')
  assert.deepEqual(facts.aces.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid })), [
    { type: 0, flags: directory ? 3 : 0, mask: 0x001f01ff, sid: token.userSid },
  ])
  assert.match(facts.identity.volumeSerial, /^[0-9a-f]{16}$/)
  assert.match(facts.identity.fileId, /^[0-9a-f]{32}$/)
  if (!directory) assert.equal(facts.links, 1)
}

function published(receipt, parent) {
  assert.equal(receipt.publication, 'published')
  assert.equal(receipt.durability, 'synced', 'Fresh namespace durability must be acknowledged, not silently weakened')
  assert.deepEqual(receipt.parentIdentity, parent.identity)
  assert.equal(receipt.cleanup, 'not-needed')
  assert.ok(receipt.identity)
}

function reject(operation, codes) {
  assert.throws(operation, error => {
    assert.equal(error.name, 'PrivateStorageError')
    assert.ok(codes.includes(error.code), `Expected ${codes.join('/')} rejection, received ${error.code}`)
    return true
  })
}

function remember(directory) { directories.push(directory); return directory }
function requireRoot() { if (!root) throw new Blocked('Private root admission prerequisite failed') }

/** Keep all owned controllers until final quiescence inspection. */
function startChild(command, args) {
  const child = startPrimaryProcess(command, args, childEnv, { onUncertain: () => { processCleanupUncertain = true } })
  children.add(child)
  return child
}

try {
  await check('native-runtime', () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Requires real Windows x64; no mocked or Wine substitute is accepted')
    assert.match(entry, /\.js$/i, 'Behavior acceptance requires the built JavaScript artifact')
  })
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Blocked('Native environment unavailable')
  report.temporaryRoot = createFixtureRoot('dsh-private-storage-native-')
  sandbox = report.temporaryRoot.path
  const home = join(sandbox, 'home')
  mkdirSync(home)
  for (const key of ['HOME', 'USERPROFILE']) { childEnv[key] = home; process.env[key] = home }
  process.env.APPDATA = childEnv.APPDATA = join(home, 'AppData', 'Roaming')
  process.env.LOCALAPPDATA = childEnv.LOCALAPPDATA = join(home, 'AppData', 'Local')
  mkdirSync(childEnv.APPDATA, { recursive: true })
  mkdirSync(childEnv.LOCALAPPDATA, { recursive: true })
  await check('sdk-abi-observation', () => {
    report.sdkAbi = oracle('abi')
    assert.equal(report.sdkAbi.pointerBytes, 8)
    assert.equal(report.sdkAbi.ntstatusSigned, true)
    assert.equal(report.sdkAbi.constants.statusPending, 259)
  })
  await check('token-classification', () => {
    report.token = token = oracle('token')
    assert.equal(token.threadTokenPresent, false)
    assert.equal(token.threadTokenError, 1008)
    assert.equal(token.tokenType, 1)
    if (token.restricted) throw new Blocked('Runner process token is restricted; normal-token acceptance cannot run')
  })
  await check('built-backend-load', async () => {
    storage = await import(pathToFileURL(entry).href)
    report.capabilities = storage.capabilities()
    assert.equal(report.capabilities.available, true, report.capabilities.reason)
    assert.equal(report.capabilities.backend, 'windows-ntfs')
    assert.equal(report.capabilities.nativeArtifact.koffiVersion, '3.1.1')
    assert.match(report.capabilities.nativeArtifact.nativeBinarySha256, /^[0-9a-f]{64}$/)
  })
  if (!storage || !token) throw new Blocked('Backend or token prerequisites failed')
  if (!report.candidateArchiveSha256 || !report.dependencyManifestSha256 || !report.sourceSha) {
    blocked('immutable-candidate-manifest', 'Supply --candidate-archive, --manifest, and --source-sha; built-entry hash alone is not packed consumer acceptance')
  } else {
    report.results.push({ name: 'candidate-identities-recorded', status: 'passed' })
  }
  rootPath = join(sandbox, 'private-root')
  await check('independent-private-root-admission', () => {
    oracle('create', rootPath, 'directory', 'private')
    const facts = oracle('inspect', rootPath)
    privateFacts(facts, true)
    report.filesystem = { name: facts.filesystem, flags: facts.filesystemFlags, deviceType: facts.deviceType, deviceCharacteristics: facts.deviceCharacteristics }
    root = remember(storage.openPrivateDirectory(rootPath, { create: false }))
    assert.deepEqual(root.identity, facts.identity)
  })
  await check('fresh-root-under-broad-parent', () => {
    const parent = join(sandbox, 'broad-parent')
    oracle('create', parent, 'directory', 'public')
    const path = join(parent, 'fresh', 'nested')
    const directory = remember(storage.openPrivateDirectory(path, { create: true }))
    assert.equal(directory.publications.length, 2)
    for (const receipt of directory.publications) {
      assert.equal(receipt.publication, 'published')
      assert.equal(receipt.durability, 'synced')
    }
    privateFacts(oracle('inspect', join(parent, 'fresh')), true)
    privateFacts(oracle('inspect', path), true)
    return { publications: directory.publications }
  })
  await check('exclusive-whole-file-and-independent-facts', () => {
    requireRoot()
    const bytes = Buffer.from('synthetic old complete record\n')
    const receipt = storage.createPrivateFileExclusive(root, 'record.bin', bytes)
    published(receipt, root)
    const independent = oracle('inspect', join(rootPath, 'record.bin'))
    privateFacts(independent, false)
    const facts = storage.inspectPrivate(root, 'record.bin')
    assert.deepEqual(facts.identity, independent.identity)
    assert.deepEqual(receipt.identity, independent.identity)
    assert.equal(facts.ownerSid, independent.ownerSid)
    assert.equal(facts.sizeBytes, BigInt(independent.sizeBytes))
    assert.equal(facts.links, independent.links)
    assert.equal(facts.kind, 'file')
    assert.equal(facts.complete, true)
    assert.deepEqual(Buffer.from(storage.readPrivateFile(root, 'record.bin', bytes.length)), bytes)
    assert.deepEqual(readFileSync(join(rootPath, 'record.bin')), bytes)
  })
  const tokenControlName = 'token-readable-control.bin'
  await check('token-denial-readable-control', () => {
    requireRoot()
    const path = join(rootPath, tokenControlName)
    oracle('create', path, 'file', 'anonymous-public')
    writeFileSync(path, 'synthetic readable token control\n')
    const descriptor = oracle('descriptor', path)
    assert.equal(descriptor.ownerSid, token.userSid)
    assert.equal(descriptor.daclProtected, true)
    assert.ok(descriptor.aces.some(ace => ace.type === 0 && ace.flags === 0 && ace.mask === 0x00120089 && ace.sid === '010100000000000507000000'))
    assert.equal(report.sdkAbi.structures.SID_AND_ATTRIBUTES.size, 16)
    assert.equal(report.sdkAbi.structures.SID_AND_ATTRIBUTES.Attributes, 8)
    assert.equal(report.sdkAbi.structures.TOKEN_USER.size, 16)
  })
  for (const [mode, name] of [['ordinary', 'ordinary-token-private-read'], ['anonymous', 'foreign-user-denial'], ['restricted', 'same-user-restricted-token-denial']]) {
    await check(name, () => {
      requireRoot()
      const before = snapshot(join(rootPath, 'record.bin'))
      const parentBefore = snapshot(rootPath)
      const result = oracle('token-access', rootPath, 'record.bin', tokenControlName, mode)
      assert.equal(result.ownerSid, token.userSid)
      assert.equal(result.ordinaryPrivateReadable, true)
      assert.equal(result.controlStatus, 0)
      assert.equal(result.controlReadBytes, 1)
      assert.equal(result.threadRestored, true)
      assert.equal(result.privilegesEnabled, false)
      assert.equal(result.parentTraversalAdjusted, mode === 'anonymous')
      assert.equal(result.parentTraversalMask, mode === 'anonymous' ? 0x20 : 0)
      assert.equal(result.parentDescriptorRestored, true)
      assert.equal(result.parentTraversalMechanism, mode === 'anonymous' ? 'NtSetSecurityObject' : 'not-needed')
      assert.equal(result.parentMutationStatus, 0)
      assert.equal(result.parentRestoreStatus, 0)
      if (mode === 'ordinary') {
        assert.equal(result.privateStatus, 0)
        assert.equal(result.privateReadError, 0)
        assert.equal(result.privateReadBytes, 1)
      } else {
        assert.equal(result.privateStatus >>> 0, 0xc0000022, 'Private-data access must be denied while the matched control is readable')
        assert.equal(result.privateReadBytes, 0)
      }
      if (mode === 'anonymous') {
        assert.equal(result.subject, 'anonymous')
        assert.equal(result.sameUser, false)
        assert.equal(result.subjectSid, '010100000000000507000000')
        assert.notEqual(result.subjectSid, token.userSid)
      } else {
        assert.equal(result.sameUser, true)
        assert.equal(result.subjectSid, token.userSid)
        assert.equal(result.restricted, mode === 'restricted')
      }
      assert.deepEqual(snapshot(join(rootPath, 'record.bin')), before)
      assert.deepEqual(snapshot(rootPath), parentBefore)
      return { ...result, distinctInteractiveAccountCreated: false }
    })
  }
  for (const scenario of ['same-user', 'anonymous', 'restricted']) {
    await check(`reject-${scenario}-thread-impersonation`, async () => {
      requireRoot()
      const before = snapshot(join(rootPath, 'record.bin'))
      const worker = startChild(process.execPath, [tokenFixture, entry, rootPath, scenario])
      try {
        const result = await worker.next()
        if (result.status === 'blocked') throw new Blocked(result.reason)
        assert.equal(result.complete, true, result.reason)
        assert.equal(result.ownerSid, token.userSid)
        assert.equal(result.threadRestored, true)
        assert.equal(result.privilegesEnabled, false)
        assert.equal(result.filesystemOpensUnderImpersonation, 0)
        assert.equal(result.observations.length, 4)
        assert.ok(result.observations.every(observation => observation.rejected))
        await worker.close()
        assert.deepEqual(snapshot(join(rootPath, 'record.bin')), before)
        return result
      } finally { await worker.kill() }
    })
  }
  await check('restricted-primary-process-token-rejection', () => {
    requireRoot()
    const before = snapshot(join(rootPath, 'record.bin')), parentBefore = snapshot(rootPath)
    const entriesBefore = readdirSync(rootPath).sort(), recordSha256 = sha256(join(rootPath, 'record.bin'))
    const worker = fileURLToPath(new URL('primary-token-worker.mjs', import.meta.url))
    const pair = {}
    try {
      for (const mode of ['ordinary', 'restricted']) {
        const observation = join(sandbox, `primary-token-${mode}.json`)
        const launch = oracle('primary-process', mode, process.execPath, worker, entry, rootPath, observation, mode)
        pair[mode] = { launch }
        pair[mode].child = JSON.parse(readFileSync(observation, 'utf8'))
      }
      validatePrimaryTokenPair(pair, { userSid: token.userSid, entrySha256: report.entrySha256,
        nativeBinarySha256: ownerBinding(entry).sha256, recordSha256 })
      assert.deepEqual(snapshot(join(rootPath, 'record.bin')), before)
      assert.deepEqual(snapshot(rootPath), parentBefore); assert.deepEqual(readdirSync(rootPath).sort(), entriesBefore)
      assert.equal(sha256(join(rootPath, 'record.bin')), recordSha256)
      return { ...pair, originalIdentitiesDescriptorsAndBytesRetained: true }
    } catch (error) { error.observation = pair; throw error }
  })
  await check('collision-preserves-first-publication', () => {
    requireRoot()
    const before = snapshot(join(rootPath, 'record.bin'))
    const bytes = readFileSync(join(rootPath, 'record.bin'))
    reject(() => storage.createPrivateFileExclusive(root, 'record.bin', Buffer.from('synthetic loser')), ['collision'])
    assert.deepEqual(snapshot(join(rootPath, 'record.bin')), before)
    assert.deepEqual(readFileSync(join(rootPath, 'record.bin')), bytes)
  })
  await check('full-identity-and-owner-survive-restart', async () => {
    requireRoot()
    const child = startChild(process.execPath, [fixture, entry, 'read', rootPath, 'record.bin'])
    try {
      const result = await child.next()
      assert.equal(result.complete, true)
      const independent = oracle('inspect', join(rootPath, 'record.bin'))
      assert.equal(result.ownerSid, token.userSid)
      assert.deepEqual(result.identity, independent.identity)
      assert.equal(result.bytesHex, readFileSync(join(rootPath, 'record.bin')).toString('hex'))
      await child.close()
    } finally { await child.kill() }
  })
  await check('replace-retains-old-reader-and-publishes-new-bytes', async () => {
    requireRoot()
    const path = join(rootPath, 'record.bin')
    const before = readFileSync(path)
    const reader = startChild(oraclePath, ['hold-reader', path, 'share-delete'])
    try {
      assert.equal((await reader.next()).bytesHex, before.toString('hex'))
      const next = Buffer.from('synthetic new complete record\n')
      const receipt = storage.replacePrivateFile(root, 'record.bin', next)
      published(receipt, root)
      reader.child.stdin.write('read\n')
      assert.equal((await reader.next()).bytesHex, before.toString('hex'))
      assert.deepEqual(readFileSync(path), next)
      assert.deepEqual(oracle('inspect', path).identity, receipt.identity)
      await reader.close()
    } finally { await reader.kill() }
  })
  await check('reader-without-delete-sharing-fails-closed', async () => {
    requireRoot()
    const path = join(rootPath, 'record.bin')
    const before = snapshot(path)
    const bytes = readFileSync(path)
    const reader = startChild(oraclePath, ['hold-reader', path, 'deny-delete'])
    try {
      assert.equal((await reader.next()).complete, true)
      reject(() => storage.replacePrivateFile(root, 'record.bin', Buffer.from('synthetic blocked')), ['sharing'])
      assert.deepEqual(snapshot(path), before)
      assert.deepEqual(readFileSync(path), bytes)
      await reader.close()
    } finally { await reader.kill() }
  })
  await check('read-byte-ceilings-empty-exact-over-limit', () => {
    requireRoot()
    published(storage.createPrivateFileExclusive(root, 'empty.bin', new Uint8Array()), root)
    assert.equal(storage.readPrivateFile(root, 'empty.bin', 0).length, 0)
    const bytes = Buffer.alloc(65536, 0x62)
    published(storage.createPrivateFileExclusive(root, 'bounded.bin', bytes), root)
    assert.deepEqual(Buffer.from(storage.readPrivateFile(root, 'bounded.bin', bytes.length)), bytes)
    reject(() => storage.readPrivateFile(root, 'bounded.bin', bytes.length - 1), ['limit'])
    for (const limit of [-1, NaN, Infinity, 64 * 1024 * 1024 + 1]) reject(() => storage.readPrivateFile(root, 'bounded.bin', limit), ['limit'])
  })
  await check('full-64-mib-read-allocation-ceiling', () => {
    requireRoot()
    const maximum = 64 * 1024 * 1024
    const bytes = Buffer.alloc(maximum, 0x63)
    const expectedHash = createHash('sha256').update(bytes).digest('hex')
    published(storage.createPrivateFileExclusive(root, 'maximum.bin', bytes), root)
    assert.equal(oracle('inspect', join(rootPath, 'maximum.bin')).sizeBytes, String(maximum))
    reject(() => storage.readPrivateFile(root, 'maximum.bin', maximum - 1), ['limit'])
    const read = storage.readPrivateFile(root, 'maximum.bin', maximum)
    assert.equal(read.length, maximum)
    assert.equal(createHash('sha256').update(read).digest('hex'), expectedHash)
  })
  await check('literal-names-and-malformed-utf16', () => {
    requireRoot()
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'C:relative', 'C:\\absolute', '\\\\host\\share', 'stream:alternate', 'CON', 'nul.txt', 'COM¹.log', 'LPT²', 'tail.', 'tail ', 'a*', 'a?', 'a\0b', '\u0085', '\u009f', 'CON .txt', 'LPT1 .log', '\ud800', '\udc00', 'x'.repeat(256)]) {
      reject(() => storage.createPrivateFileExclusive(root, name, new Uint8Array()), ['name'])
    }
    for (const name of ['spaces allowed.bin', 'Unicode-é-世界-😀.bin']) {
      published(storage.createPrivateFileExclusive(root, name, Buffer.from('synthetic unicode')), root)
      privateFacts(oracle('inspect', join(rootPath, name)), false)
    }
  })
  await check('case-alias-rejection', () => {
    requireRoot()
    published(storage.createPrivateFileExclusive(root, 'ExactCase.bin', new Uint8Array()), root)
    reject(() => storage.readPrivateFile(root, 'exactcase.bin', 1), ['name', 'identity'])
    reject(() => storage.createPrivateFileExclusive(root, 'exactcase.bin', new Uint8Array()), ['name', 'identity', 'collision'])
  })
  for (const policy of ['public', 'null', 'empty', 'absent', 'inherited', 'deny-first', 'object', 'callback']) {
    await check(`reject-${policy}-dacl-without-repair`, async () => {
      requireRoot()
      const name = `descriptor-${policy}.bin`
      const path = join(rootPath, name)
      if (policy === 'absent') {
        published(storage.createPrivateFileExclusive(root, name, Buffer.from('synthetic immutable descriptor sample')), root)
        const observe = () => ({ bytesHex: readFileSync(path).toString('hex'), descriptor: oracle('descriptor', path),
          identity: snapshot(path).identity, parentEntries: readdirSync(rootPath).sort() })
        const original = observe()
        const worker = startChild(process.execPath, [descriptorFixture, entry, rootPath, name])
        try {
          const result = await worker.next()
          assert.equal(result.complete, true, result.reason)
          assert.equal(result.closeFailure, undefined)
          assert.equal(result.evidence, 'instrumented-descriptor-buffer')
          assert.equal(result.actualDiskAbsentDacl, false)
          assert.equal(result.filesystemSecurityModified, false)
          assert.equal(result.nativeSecurityCallsForwarded, true)
          assert.equal(result.nativeOwnerBinding.sha256, report.capabilities.ownershipArtifact.platformPackage.sha256)
          assert.deepEqual(result.refusals, ['read', 'replace'].map(operation => ({ operation, name: 'PrivateStorageError', code: 'privacy' })))
          assert.deepEqual(result.injections.map(event => event.operation), ['read', 'replace'])
          for (const event of result.injections) {
            assert.equal(event.forwarded, true)
            assert.equal(event.originalControl & 4, 4); assert.equal(event.modifiedControl & 4, 0)
            assert.ok(event.originalDaclOffset >= 20); assert.equal(event.modifiedDaclOffset, 0)
            assert.notEqual(event.originalSha256, event.modifiedSha256)
            assert.deepEqual(event.identity, original.identity)
          }
          await worker.close()
          const after = observe()
          assert.deepEqual(after, original, 'Injected descriptor refusal must preserve actual file bytes, security, identity and parent entries')
          return { ...result, original, after, unperformed: 'A disk object with SE_DACL_PRESENT cleared cannot be created on Windows',
            basis: 'https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/security-descriptor-control' }
        } finally { await worker.kill() }
      }
      const worker = startChild(oraclePath, ['hold-descriptor', path, policy])
      try {
        const before = await worker.next()
        assert.equal(before.complete, true)
        assert.equal(before.ownerSid, token.userSid)
        assert.equal(before.sizeBytes, '0')
        assert.equal(before.links, 1)
        const names = readdirSync(rootPath).sort()
        const materialized = {
          public: before.aces.some(ace => ace.sid === '010100000000000100000000'),
          null: before.daclPresent && before.daclNull,
          empty: before.daclPresent && !before.daclNull && before.aces.length === 0,
          absent: !before.daclPresent,
          inherited: !before.daclProtected && before.aces.some(ace => (ace.flags & 16) !== 0),
          'deny-first': before.aces[0]?.type === 1 && before.aces.some(ace => ace.type === 0),
          object: before.aces.some(ace => ace.type === 5),
          callback: before.aces.some(ace => ace.type === 9),
        }
        if (!materialized[policy]) throw new Blocked(`Windows did not preserve the requested ${policy} descriptor fixture; a normalized descriptor is not this test`)
        const expectDenied = operation => assert.throws(operation, error => {
          assert.equal(error.name, 'PrivateStorageError')
          assert.ok(error.code === 'privacy' || (error.code === 'native' && ((error.nativeStatus >>> 0) === 0xc0000022 || error.win32Code === 5)), 'Must reject privacy or report native access denial')
          return true
        })
        expectDenied(() => storage.readPrivateFile(root, name, 1024))
        expectDenied(() => storage.replacePrivateFile(root, name, Buffer.from('synthetic rejected')))
        worker.child.stdin.write('inspect\n')
        assert.deepEqual(await worker.next(), before)
        assert.deepEqual(readdirSync(rootPath).sort(), names)
        return { evidence: 'retained-native-descriptor', retainedAccessIncludesDelete: false, identity: before.identity }
      } finally {
        try { await worker.close() }
        finally { await worker.kill() }
      }
    })
  }
  await check('private-child-directory-and-file-policy', () => {
    requireRoot()
    const created = storage.createPrivateChild(root, 'child')
    remember(created.directory)
    published(created.receipt, root)
    privateFacts(oracle('inspect', join(rootPath, 'child')), true)
    const bytes = Buffer.from('synthetic child')
    published(storage.createPrivateFileExclusive(created.directory, 'child.bin', bytes), created.directory)
    privateFacts(oracle('inspect', join(rootPath, 'child', 'child.bin')), false)
    const reopened = remember(storage.openPrivateChild(root, 'child'))
    assert.deepEqual(reopened.identity, created.directory.identity)
  })
  await check('hardlink-inside-and-outside-root-rejected', () => {
    requireRoot()
    published(storage.createPrivateFileExclusive(root, 'linked.bin', Buffer.from('synthetic sentinel')), root)
    const path = join(rootPath, 'linked.bin')
    const outside = join(sandbox, 'outside-hardlink.bin')
    oracle('hardlink', join(rootPath, 'inside-hardlink.bin'), path)
    oracle('hardlink', outside, path)
    const before = snapshot(outside)
    assert.equal(before.links, 3)
    reject(() => storage.readPrivateFile(root, 'linked.bin', 1024), ['identity', 'privacy', 'unsupported'])
    reject(() => storage.replacePrivateFile(root, 'linked.bin', Buffer.from('synthetic rejected')), ['identity', 'privacy', 'unsupported'])
    assert.deepEqual(snapshot(outside), before)
    assert.equal(readFileSync(outside, 'utf8'), 'synthetic sentinel')
  })
  await check('final-symlink-and-dangling-symlink-rejected', () => {
    requireRoot()
    const target = join(sandbox, 'outside-sentinel.bin')
    writeFileSync(target, 'synthetic external sentinel', { flag: 'wx' })
    const before = snapshot(target)
    for (const [name, destination] of [['final-link.bin', target], ['dangling-link.bin', join(sandbox, 'missing.bin')]]) {
      const link = join(rootPath, name)
      oracle('symlink', link, destination, 'file')
      links.add(link)
      reject(() => storage.readPrivateFile(root, name, 1024), ['unsupported', 'identity', 'native'])
      reject(() => storage.replacePrivateFile(root, name, Buffer.from('synthetic rejected')), ['unsupported', 'identity', 'native'])
    }
    assert.deepEqual(snapshot(target), before)
    assert.equal(readFileSync(target, 'utf8'), 'synthetic external sentinel')
  })
  await check('intermediate-directory-symlink-rejected', () => {
    const target = join(sandbox, 'outside-directory')
    oracle('create', target, 'directory', 'private')
    const before = snapshot(target)
    const link = join(sandbox, 'intermediate-link')
    oracle('symlink', link, target, 'directory')
    links.add(link)
    reject(() => storage.openPrivateDirectory(join(link, 'must-not-create'), { create: true }), ['unsupported', 'identity', 'native'])
    assert.deepEqual(snapshot(target), before)
  })
  await check('identity-safe-removal-refuses-stale-entry', () => {
    requireRoot()
    const first = storage.createPrivateFileExclusive(root, 'delete.bin', Buffer.from('synthetic first'))
    const second = storage.replacePrivateFile(root, 'delete.bin', Buffer.from('synthetic second'))
    reject(() => storage.removeOwnedEntry(root, 'delete.bin', first.identity), ['identity', 'changed'])
    assert.deepEqual(oracle('inspect', join(rootPath, 'delete.bin')).identity, second.identity)
    const removed = storage.removeOwnedEntry(root, 'delete.bin', second.identity)
    assert.equal(removed.deletion, 'pending')
    reject(() => storage.readPrivateFile(root, 'delete.bin', 1024), ['not-found'])
  })
  await check('kernel-lease-contention-monitor-death-and-writer-exit', async () => {
    requireRoot()
    const writer = startChild(process.execPath, [fixture, entry, 'lease', rootPath, 'writer.lock'])
    const monitor = startChild(process.execPath, [fixture, entry, 'monitor', rootPath, 'writer.lock'])
    try {
      const ready = await writer.next()
      assert.equal(ready.leaseReady, true)
      assert.equal((await monitor.next()).monitorReady, true)
      reject(() => storage.acquirePrivateWriterLease(root, 'writer.lock'), ['busy', 'sharing'])
      await monitor.kill()
      reject(() => storage.acquirePrivateWriterLease(root, 'writer.lock'), ['busy', 'sharing'])
      assert.deepEqual(oracle('inspect', join(rootPath, 'writer.lock')).identity, ready.identity)
      await writer.kill()
      const lease = storage.acquirePrivateWriterLease(root, 'writer.lock')
      try { assert.deepEqual(lease.identity, ready.identity) } finally { lease.release(); lease.close() }
      assert.deepEqual(oracle('inspect', join(rootPath, 'writer.lock')).identity, ready.identity)
      return { monitorOwnsNoWriterHandle: true, writerRetainsLeaseUntilExit: true, lockObjectNeverDeleted: true }
    } finally { await monitor.kill(); await writer.kill() }
  })
  await check('bounded-audit-under-owned-lease', () => {
    requireRoot()
    const child = remember(storage.createPrivateChild(root, 'audit').directory)
    published(storage.createPrivateFileExclusive(child, 'record.bin', Buffer.from('synthetic audited')), child)
    const nested = remember(storage.createPrivateChild(child, 'nested').directory)
    published(storage.createPrivateFileExclusive(nested, 'nested-record.bin', Buffer.from('synthetic nested audit')), nested)
    const lease = storage.acquirePrivateWriterLease(child, 'audit.lock')
    try {
      const result = storage.auditPrivateTree(child, { maxEntries: 10, maxDepth: 2 }, lease)
      assert.equal(result.complete, true)
      assert.equal(result.entries, 4, 'Audit must visit root record, lease, nested directory and nested record')
      reject(() => storage.auditPrivateTree(child, { maxEntries: 1, maxDepth: 2 }, lease), ['limit'])
      reject(() => storage.auditPrivateTree(child, { maxEntries: 10, maxDepth: 0 }, lease), ['limit'])
      const complete = storage.auditPrivateTree(child, { maxEntries: 4, maxDepth: 1 }, lease)
      assert.deepEqual(complete, { complete: true, entries: 4 })
    } finally { lease.close() }
  })
  await check('idempotent-close-and-forged-capability-rejection', () => {
    requireRoot()
    const directory = storage.openPrivateDirectory(rootPath, { create: false })
    directory.close(); directory.close()
    reject(() => storage.readPrivateFile(directory, 'record.bin', 1024), ['closed'])
    reject(() => storage.readPrivateFile({ identity: root.identity, close() {} }, 'record.bin', 1024), ['closed', 'identity'])
  })
  for (const scenario of ['creation-barrier', 'short-write', 'write-failure', 'pre-flush-failure', 'rename-failure', 'rename-return-lost', 'rename-return-lost-unqueryable', 'post-flush-failure', 'verification-failure', 'close-failure']) {
    await check(`real-native-instrumented-${scenario}`, async () => {
      requireRoot()
      const target = `fault-${scenario}.bin`
      const path = join(rootPath, target)
      const oldBytes = Buffer.from('synthetic fault-worker old record\n')
      published(storage.createPrivateFileExclusive(root, target, oldBytes), root)
      const before = oracle('inspect', path)
      const worker = startChild(process.execPath, [faultFixture, entry, rootPath, scenario, target])
      let atCreation
      let liveAccess
      try {
        if (scenario === 'creation-barrier') {
          const barrier = await worker.next()
          assert.equal(barrier.event, 'created-before-write')
          assert.equal(dirname(barrier.path), rootPath)
          atCreation = oracle('inspect', barrier.path)
          privateFacts(atCreation, false)
          assert.equal(atCreation.sizeBytes, '0', 'Privacy must hold before the first write')
          const probe = startChild(process.execPath, [fileURLToPath(new URL('owner-access-probe.mjs', import.meta.url)), entry, rootPath, basename(barrier.path)])
          try {
            liveAccess = await probe.next()
            assert.equal(liveAccess.event, 'access'); assert.equal(liveAccess.independentProcess, true)
            assert.deepEqual(liveAccess.observations.map(({ role, opened, win32Error }) => ({ role, opened, win32Error })),
              [{ role: 'delete', opened: false, win32Error: 32 }, { role: 'write', opened: false, win32Error: 32 },
                { role: 'read', opened: true, win32Error: null }])
            await probe.close()
          } finally { await probe.kill() }
          for (const mode of ['anonymous', 'restricted']) {
            await check(`prewrite-${mode}-private-denial`, () => {
              const access = oracle('token-access', rootPath, basename(barrier.path), tokenControlName, mode)
              assert.equal(access.ordinaryPrivateReadable, true)
              assert.equal(access.controlStatus, 0)
              assert.equal(access.controlReadBytes, 1)
              assert.equal(access.privateStatus >>> 0, 0xc0000022)
              assert.equal(access.privateReadBytes, 0)
              assert.equal(access.threadRestored, true)
              assert.equal(access.privilegesEnabled, false)
              return access
            })
          }
          worker.child.stdin.write('\n')
        }
        const observation = await worker.next()
        assert.equal(observation.event, 'result')
        assert.equal(observation.nativeCallsForwarded, true)
        assert.equal(observation.observationLayer, 'opaque-native-owner-methods')
        assert.equal(observation.result.closeFailure, undefined)
        assert.equal(observation.faultInjected, scenario !== 'creation-barrier')
        const sourceEvents = observation.events.filter(event => event.capability === observation.sourceCapability)
        const created = observation.events.find(event => event.sourceCapability === observation.sourceCapability)
        assert.ok(created)
        assert.equal(created.requestedKind, 'file'); assert.equal(created.requestedMode, 'create')
        assert.equal(created.actualMode & 2, 2, 'Actual retained publishing-source mode must be write-through')
        assert.equal(created.actualModeScope, 'retained-source-handle')
        assert.ok(sourceEvents.some(event => event.name === 'query' && event.informationClass === 16 && (event.mode & 2) === 2),
          'Repeat the actual publishing-source mode observation during admission')
        const result = observation.result
        const after = oracle('inspect', path)
        privateFacts(after, false)
        if (['creation-barrier', 'short-write'].includes(scenario)) {
          assert.equal(result.ok, true)
          published(result.receipt, root)
          const renameIndex = sourceEvents.findIndex(event => event.name === 'rename' && event.targetName === target)
          assert.ok(renameIndex >= 0)
          const rename = sourceEvents[renameIndex]
          assert.equal(rename.replace, true)
          assert.equal(rename.relativeToAdmittedParent, true)
          const flushIndexes = sourceEvents.flatMap((event, index) => event.name === 'flush' && event.completed ? [index] : [])
          assert.equal(flushIndexes.length, 2)
          assert.ok(flushIndexes[0] < renameIndex && flushIndexes[1] > renameIndex)
          assert.deepEqual(after.identity, observation.sourceIdentity)
          assert.deepEqual(after.identity, result.receipt.identity)
          if (atCreation) assert.deepEqual(atCreation.identity, after.identity)
          if (scenario === 'short-write') assert.ok(sourceEvents.filter(event => event.name === 'write').length >= 2)
        } else {
          assert.equal(result.ok, false)
          assert.equal(result.name, 'PrivateStorageError')
          assert.ok(result.receipt, 'Every publication failure must retain its state')
          if (['write-failure', 'pre-flush-failure', 'rename-failure'].includes(scenario)) {
            assert.equal(result.receipt.publication, 'not-published')
            assert.equal(result.receipt.durability, 'unconfirmed')
            assert.equal(result.receipt.cleanup, 'delete-pending')
            assert.ok(sourceEvents.some(event => event.name === 'remove' && event.forwarded && event.completed))
            assert.deepEqual(after.identity, before.identity)
            assert.deepEqual(readFileSync(path), oldBytes)
          } else {
            assert.equal(result.receipt.publication, scenario === 'rename-return-lost-unqueryable' ? 'indeterminate' : 'published')
            assert.equal(result.receipt.durability, scenario === 'close-failure' ? 'synced' : 'unconfirmed')
            assert.equal(result.receipt.cleanup, scenario === 'close-failure' ? 'failed' : 'withheld')
            if (scenario === 'close-failure') {
              assert.equal(result.cleanupFailed, true)
              const closes = sourceEvents.filter(event => event.name === 'close')
              assert.equal(closes.length, 1, 'An unconfirmed source close must not be retried')
              assert.equal(closes[0].forwarded, true)
              assert.equal(closes[0].completed, true)
              assert.equal(closes[0].actuallyReleased, true, 'This labelled case released the real handle before injecting failure')
              assert.equal(closes[0].injected, true)
            }
            assert.equal(sourceEvents.some(event => event.name === 'remove'), false, 'A possibly live source must never receive deletion disposition')
            assert.deepEqual(after.identity, result.receipt.identity)
            assert.equal(readFileSync(path, 'utf8'), 'synthetic fault-worker new record\n')
          }
        }
        await worker.close()
        return { testOwnedInterception: true, ...observation,
          ...(atCreation ? { independentPrewriteIdentity: atCreation.identity, independentLiveAccess: liveAccess } : {}) }
      } finally { await worker.kill() }
    })
  }
  await check('deterministic-parent-rename-refused-by-worker-guard', async () => {
    const guardedPath = join(sandbox, 'independent-guard-root')
    oracle('create', guardedPath, 'directory', 'private')
    const before = oracle('inspect', guardedPath)
    const worker = startChild(process.execPath, [faultFixture, entry, guardedPath, 'root-guard-barrier', 'guarded.bin'])
    try {
      const barrier = await worker.next()
      assert.equal(barrier.event, 'root-guard-retained')
      assert.deepEqual(readdirSync(guardedPath), [], 'No open descendant may explain the rename refusal')
      // No directory capability for guardedPath exists in this controller process.
      assert.throws(() => renameSync(guardedPath, `${guardedPath}-moved`), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
      assert.deepEqual(oracle('inspect', guardedPath).identity, before.identity)
      privateFacts(oracle('inspect', barrier.path), true)
      worker.child.stdin.write('\n')
      const observation = await worker.next()
      assert.equal(observation.result.ok, true)
      assert.equal(observation.result.receipt.publication, 'published')
      assert.deepEqual(oracle('inspect', join(guardedPath, 'guarded.bin')).identity, observation.result.receipt.identity)
      await worker.close()
      return { controllerHeldNoDirectoryCapability: true, workerRetainedAncestorGuard: true }
    } finally { await worker.kill() }
  })
  for (const kind of ['directories', 'leases']) {
    await check(`real-native-gc-${kind}`, async () => {
      const gcRoot = join(sandbox, `gc-${kind}-root`)
      oracle('create', gcRoot, 'directory', 'private')
      const before = oracle('inspect', gcRoot)
      const worker = startChild(process.execPath, ['--expose-gc', gcFixture, entry, gcRoot, kind, dirname(oraclePath)])
      try {
        // Lease setup performs 100 real durable publications, including both regular-file flushes.
        const result = await worker.next(120_000)
        assert.equal(result.complete, true, result.reason)
        assert.equal(result.closeFailure, undefined)
        assert.equal(result.sampleCount, 100)
        assert.equal(result.realNativeCalls, true)
        assert.equal(result.nativeOwnerBinding.sha256, report.capabilities.ownershipArtifact.platformPackage.sha256)
        assert.equal(result.sdkDllSha256, sdkInheritanceBinding(dirname(oraclePath)).binarySha256)
        assert.ok(result.independentlyMatchedHandles.explicit >= result.sampleCount)
        assert.ok(result.independentlyMatchedHandles.gc >= result.sampleCount)
        assert.equal(result.namespaceMutations, 0)
        assert.equal(result.remainingStorageHandles, 0)
        assert.equal(result.remainingBackingAllocations, 0)
        await worker.close()
        const after = oracle('inspect', gcRoot)
        assert.deepEqual(after.identity, before.identity)
        privateFacts(after, true)
        assert.deepEqual(readdirSync(gcRoot).sort(), result.names)
        if (kind === 'leases') {
          assert.equal(result.allLeasesReacquired, true)
          for (let index = 0; index < result.names.length; index++) {
            const independent = oracle('inspect', join(gcRoot, result.names[index]))
            privateFacts(independent, false)
            assert.deepEqual(independent.identity, result.identities[index])
          }
        } else assert.deepEqual(result.names, [])
        return result
      } finally { await worker.kill() }
    })
  }
  for (const [name, reason] of [
    ['conditional-malformed-acl-native-fixtures', 'Malformed serialized decoder fixtures belong to separate parser tests; conditional native ACLs have not run'],
    ['junction-mount-cloud-unknown-reparse-fixtures', 'Symlink fixtures are real; additional reparse-tag fixtures have not run'],
    ['deterministic-race-and-crash-boundary-matrix', 'No mock or timing-only stress is counted as deterministic native fault-boundary evidence'],
    ['growing-truncated-same-size-read-races', 'Read bounds are tested; deterministic concurrent file mutation barriers remain unavailable'],
    ['device-pipe-short-name-case-sensitive-matrix', 'These native fixture types are not exercised by this harness'],
    ['remaining-native-fault-boundaries', 'Test-owned real-call wrappers cover write, both flushes, rename failure/lost return, verification and close; not every allocation/query/read boundary is injected'],
    ['remaining-worker-and-handle-lifetime-matrix', 'Real GC and explicit-close handle/allocation accounting are exercised; cross-worker capabilities, child inheritance and stale-handle reuse remain untested'],
    ['remote-non-ntfs-disk-full-matrix', 'No unsupported volume or forced storage-failure infrastructure is provisioned'],
  ]) blocked(name, reason)
} catch (error) {
  if (!(error instanceof Blocked)) report.results.push({ name: 'harness', status: 'failed', reason: String(error.message) })
  else if (!report.results.some(result => result.status === 'blocked')) blocked('prerequisites', error.message)
} finally {
  let cleanupOrdinal = 0
  for (const child of children) {
    try { await child.kill() } catch (error) { report.results.push({ name: `child-cleanup-${++cleanupOrdinal}`, status: 'failed', reason: String(error.message) }) }
    if (!child.settled) processCleanupUncertain = true
  }
  for (const directory of directories.reverse()) {
    try { directory.close() } catch (error) { report.results.push({ name: 'close-cleanup', status: 'failed', reason: String(error.message) }) }
  }
  if (processCleanupUncertain) {
    report.results.push({ name: 'fixture-cleanup', status: 'failed', reason: 'Recursive cleanup withheld after uncertain owned-process teardown', retainedSyntheticRoot: sandbox })
  } else {
    for (const link of links) {
      try { unlinkSync(link) } catch (error) { report.results.push({ name: `link-cleanup-${++cleanupOrdinal}`, status: 'failed', reason: String(error.message) }) }
    }
    if (sandbox) {
      try { rmSync(sandbox, { recursive: true, force: true }) } catch (error) { report.results.push({ name: 'fixture-cleanup', status: 'failed', reason: String(error.message) }) }
    }
  }
  report.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, report.results.filter(result => result.status === status).length]))
  report.acceptance = report.summary.failed ? 'failed' : report.summary.blocked ? 'partial' : 'complete'
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ acceptance: report.acceptance, summary: report.summary, report: output }))
  process.exitCode = report.summary.failed ? 1 : options.get('--require-complete') === 'true' && report.summary.blocked ? 2 : 0
}
