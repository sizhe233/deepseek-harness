import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as tar from 'tar'
import yaml from 'js-yaml'
import { PRIVATE_STORAGE_CLAIM } from './private-storage-applicability.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sri = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const nativePath = 'packages/storage/private-storage/tests/native'

// Native bundler diagnostics must not share node:test's serialized IPC output channel.
async function preparePrivateStorageAcceptance(root, stage, packages, options) {
  const invocation = mkdtempSync(join(dirname(root), 'prepare-invocation-'))
  const input = join(invocation, 'input.json')
  const resultFile = join(invocation, 'result.json')
  const childScript = join(invocation, 'prepare.mjs')
  writeFileSync(input, JSON.stringify({ root, stage, packages, options }))
  writeFileSync(childScript, `import {readFileSync,writeFileSync} from 'node:fs';
import {preparePrivateStorageAcceptance} from ${JSON.stringify(new URL('./private-storage-artifact.mjs', import.meta.url).href)};
const p=JSON.parse(readFileSync(process.argv[2],'utf8'));
try {const descriptor=await preparePrivateStorageAcceptance(p.root,p.stage,p.packages,p.options);writeFileSync(process.argv[3],JSON.stringify({ok:true,descriptor}));}
catch(error){writeFileSync(process.argv[3],JSON.stringify({ok:false,message:error.message}));process.exitCode=1;}
`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)
    && !['NODE_PATH', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(name.toUpperCase())))
  const child = spawnSync(process.execPath, [childScript, input, resultFile], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  assert.ifError(child.error)
  assert.equal(child.signal, null, child.stderr)
  assert.ok(existsSync(resultFile), child.stderr || child.stdout)
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  if (!result.ok) throw new Error(result.message)
  assert.equal(child.status, 0, child.stderr)
  return result.descriptor
}

function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
function packageArchive(scratch, target, name, version, manifest = {}, files = {}) {
  const source = mkdtempSync(join(scratch, 'archive-source-'))
  write(join(source, 'package/package.json'), JSON.stringify({ name, version, ...manifest }))
  for (const [path, value] of Object.entries(files)) write(join(source, 'package', path), value)
  mkdirSync(dirname(target), { recursive: true })
  tar.c({ file: target, cwd: source, sync: true, gzip: true, portable: true }, ['package'])
  const bytes = readFileSync(target)
  return { name, version, file: target.split(/[\\/]/).at(-1), sha256: hash(bytes), integrity: sri(bytes), bytes: bytes.length }
}

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'private-storage-toolkit-test-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'source')
  const stage = join(scratch, 'candidate')
  const cache = join(scratch, 'verified-cache')
  mkdirSync(root); mkdirSync(stage); mkdirSync(cache)
  write(join(root, 'package.json'), '{"type":"module"}\n')
  // A build-time dependency link is not copied into the artifact-only toolkit.
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  copyFileSync(join(repository, 'workbench/private-storage-closure.mjs'), (() => { const p = join(root, 'workbench/private-storage-closure.mjs'); mkdirSync(dirname(p), { recursive: true }); return p })())
  write(join(root, 'workbench/private-storage-packed.mjs'), "import { verifyConsumerDependencies, inspectArchiveEntries } from './private-storage-closure.mjs'\nverifyConsumerDependencies([{name:'synthetic',version:'1.0.0',dependencies:{library:'1.0.0'}},{name:'library',version:'1.0.0'}])\nconst entries=inspectArchiveEntries(process.argv[2]); if(entries.length<1) throw new Error('missing archive entries');\nconsole.log(JSON.stringify({complete:true,bundledDependencies:true}))\n")
  for (const name of ['private-storage-native.ps1', 'private-storage-sdk-matrices.ps1', 'private-storage-owner-fault.ps1']) write(join(root, 'workbench', name), '# Synthetic compiler-script fixture; never invoked by this test\n')
  for (const path of ['workbench/private-storage-owner-fault-evidence.mjs', 'native/system/scripts/prepare-windows-node-sdk.mjs', 'native/system/scripts/download-node-sdk.mjs']) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repository, path), target)
  }
  for (const name of readdirSync(join(repository, nativePath))) copyFileSync(join(repository, nativePath, name), (() => { const p = join(root, nativePath, name); mkdirSync(dirname(p), { recursive: true }); return p })())
  write(join(root, 'packages/storage/private-storage/lib/types/abi.js'), 'export const ABI = Object.freeze({pointer:8,objectAttributes:48})\n')
  const slices = [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']]
  const pins = [packageArchive(scratch, join(cache, 'private-storage-native/koffi-3.1.1.tgz'), 'koffi', '3.1.1',
    { optionalDependencies: Object.fromEntries(slices.map(([platform, arch]) => [`@koromix/koffi-${platform}-${arch}`, '3.1.1'])) })]
  for (const [platform, arch] of slices) pins.push(packageArchive(scratch, join(cache, `private-storage-native/koromix-koffi-${platform}-${arch}-3.1.1.tgz`),
    `@koromix/koffi-${platform}-${arch}`, '3.1.1', { os: [platform], cpu: [arch] }, { [`${platform}_${arch}/koffi.node`]: 'synthetic non-executable fixture' }))
  pins.push(packageArchive(scratch, join(cache, 'standard-schema-spec-1.1.0.tgz'), '@standard-schema/spec', '1.1.0'))
  write(join(root, 'pnpm-lock.yaml'), yaml.dump({ packages: Object.fromEntries(pins.map(pin => [`${pin.name}@${pin.version}`, { resolution: { integrity: pin.integrity } }])) }))
  const packages = [
    packageArchive(scratch, join(stage, 'storage.tgz'), '@deepseek-ai/dsh-private-storage', '0.2.1-alpha.1'),
    packageArchive(scratch, join(stage, 'cordis.tgz'), '@deepseek-ai/cordis', '4.0.5-alpha.1'),
    packageArchive(scratch, join(stage, 'cosmokit.tgz'), '@deepseek-ai/cosmokit', '1.8.6-alpha.1'),
    packageArchive(scratch, join(stage, 'brand.tgz'), '@deepseek-ai/dsh-brand', '0.2.1-alpha.1'),
  ]
  return { root, stage, cache, packages }
}

function listFiles(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(root, path) : [path]
  })
}

test('artifact preparer hashes only generic toolkit files and bundles an import-safe standalone runner', async t => {
  const { root, stage, cache, packages } = fixture(t)
  const descriptor = await preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache })
  assert.deepEqual(descriptor.claim, PRIVATE_STORAGE_CLAIM)
  assert.equal(descriptor.toolkit.entry, 'private-storage-tests/workbench/private-storage-packed.mjs')
  assert.equal(descriptor.toolkit.abi, 'private-storage-tests/abi.json')
  assert.equal(descriptor.nativeClosure.packages.length, 5)
  assert.equal(descriptor.ordinaryDependencies[0].name, '@standard-schema/spec')
  assert.equal(descriptor.lifecycleScriptsExecuted, false)
  assert.equal(descriptor.nativeCompilationPerformed, false)
  const pairing = descriptor.toolkit.files.find(file => file.path === `private-storage-tests/${nativePath}/README.i18n.yaml`)
  assert.ok(pairing, 'Native documentation pairing metadata must be hashed with the toolkit')
  assert.equal(pairing.sha256, hash(readFileSync(join(root, nativePath, 'README.i18n.yaml'))))
  assert.deepEqual(JSON.parse(readFileSync(join(stage, descriptor.toolkit.abi), 'utf8')), { pointer: 8, objectAttributes: 48 })
  for (const file of descriptor.toolkit.files) {
    const bytes = readFileSync(join(stage, file.path))
    assert.equal(hash(bytes), file.sha256)
    assert.equal(bytes.length, file.bytes)
    assert.ok(file.path === descriptor.toolkit.entry || file.path === descriptor.toolkit.abi
      || file.path.startsWith(`private-storage-tests/${nativePath}/`) || ['workbench/private-storage-native.ps1', 'workbench/private-storage-sdk-matrices.ps1', 'workbench/private-storage-owner-fault.ps1', 'workbench/private-storage-owner-fault-evidence.mjs', 'native/system/scripts/prepare-windows-node-sdk.mjs', 'native/system/scripts/download-node-sdk.mjs'].some(path => file.path === `private-storage-tests/${path}`))
  }
  assert.deepEqual(listFiles(join(stage, 'private-storage-tests')).map(path => `private-storage-tests/${path}`).sort(), descriptor.toolkit.files.map(file => file.path).sort())
  assert.equal(existsSync(join(stage, 'private-storage-tests/node_modules')), false)
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
  const child = spawnSync(process.execPath, [join(stage, descriptor.toolkit.entry), join(stage, packages[0].file)], { cwd: stage, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { complete: true, bundledDependencies: true })
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /already prepared/)
})

test('artifact preparer refuses absent or changed source package archives before copying toolkit code', async t => {
  const { root, stage, cache, packages } = fixture(t)
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages.slice(1), { archiveDirectory: cache }), /Exactly one candidate archive/)
  writeFileSync(join(stage, packages[0].file), 'changed')
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /archive changed/)
  assert.equal(existsSync(join(stage, 'private-storage-tests')), false)
})

test('artifact preparer rejects bundled Host source even when a runner imports it', async t => {
  const { root, stage, cache, packages } = fixture(t)
  write(join(root, 'packages/storage/private-storage/src/forbidden.mjs'), 'export const value = 7\n')
  write(join(root, 'workbench/private-storage-packed.mjs'), "import { value } from '../packages/storage/private-storage/src/forbidden.mjs'\nconsole.log(value)\n")
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /non-toolkit repository code/)
})

test('the actual composite runner bundles into one import-safe artifact without repository module imports', async t => {
  const { root, stage, cache, packages } = fixture(t)
  for (const name of ['private-storage-packed.mjs', 'private-storage-native-suite.mjs', 'private-storage-native-matrices.mjs',
    'private-storage-native-contract.mjs', 'private-storage-posix-native.mjs', 'private-storage-applicability.mjs', 'private-storage-composite.mjs', 'private-storage-matrix-process.mjs']) {
    copyFileSync(join(repository, 'workbench', name), join(root, 'workbench', name))
  }
  const descriptor = await preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache })
  const script = `import assert from 'node:assert/strict';const module=await import(${JSON.stringify(pathToFileURL(join(stage, descriptor.toolkit.entry)).href)});assert.equal(typeof module.runPackedPrivateStorage,'function');assert.equal(typeof module.verifyPackedCandidate,'function');console.log('import-safe')`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: stage,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'import-safe')
})


test('artifact preparer rejects other YAML even beside the exact allowed README pairing record', async t => {
  const { root, stage, cache, packages } = fixture(t)
  write(join(root, nativePath, 'unapproved.yaml'), 'synthetic: true\n')
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /Unexpected file/)
})

test('an allowed pairing filename never admits a symbolic link', async t => {
  const { root, stage, cache, packages } = fixture(t)
  const record = join(root, nativePath, 'README.i18n.yaml')
  rmSync(record)
  symlinkSync(process.platform === 'win32' ? root : join(root, 'pnpm-lock.yaml'), record, process.platform === 'win32' ? 'junction' : 'file')
  assert.equal(lstatSync(record).isSymbolicLink(), true)
  await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /cannot be symlinks/)
})

test('extracted artifact resolves source-owner and SDK imports without the source checkout', async t => {
  const { root, stage, cache, packages } = fixture(t)
  // This archive carries the exact production source used by the test-only instrumentation include.
  const production = readFileSync(join(repository, 'native/system/packages/entry/src/windows-private-owner.c'))
  const native = packageArchive(stage, join(stage, 'native-entry.tgz'), '@deepseek-ai/node-addon-system', '0.1.3', {}, { 'src/windows-private-owner.c': production })
  native.verifiedCandidateFiles = [{ path: 'src/windows-private-owner.c', sha256: hash(production), bytes: production.length }]
  const candidateNative = { package: native, platformPackages: [] }
  // These separate platform files are copied by the preparer but not executed by this Windows wiring test.
  for (const path of ['native/system/scripts/build-test-oracle.mjs', 'native/system/test/private-storage.test.js',
    'native/system/test/private-storage-worker.js', 'native/system/test/private-storage-fd-observer.js',
    'native/system/test/private-storage-process-birth-child.js', 'native/system/test/private-storage-source-link.test.js',
    'native/system/test/private-storage-syscall-oracle.c', 'native/system/test/private-storage-read-fault.c',
    'native/system/test/private-storage-directory-fault.c', 'native/system/test/fixtures/flock-oracle.c', 'workbench/private-storage-posix-contract.json']) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repository, path), target)
  }
  const descriptor = await preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache, candidateNative })
  for (const path of ['workbench/private-storage-owner-fault-evidence.mjs', 'native/system/scripts/prepare-windows-node-sdk.mjs', 'native/system/scripts/download-node-sdk.mjs', 'native/system/packages/entry/src/windows-private-owner.c']) {
    const record = descriptor.toolkit.files.find(file => file.path === `private-storage-tests/${path}`)
    assert.ok(record); assert.equal(record.sha256, hash(readFileSync(join(stage, record.path))))
  }
  rmSync(root, { recursive: true, force: true })
  const toolkit = join(stage, descriptor.toolkit.directory), reportPath = join(stage, 'source-owner-import-smoke.json')
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
  const child = spawnSync(process.execPath, [join(toolkit, nativePath, 'owner-fault-matrix.mjs'), '--report', reportPath],
    { cwd: stage, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 2, child.stderr)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.nativeExecution, false); assert.equal(report.packedProductionBinaryExecution, false)
  assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 53 })
  const script = `import assert from 'node:assert/strict';const m=await import(${JSON.stringify(pathToFileURL(join(toolkit, 'native/system/scripts/download-node-sdk.mjs')).href)});assert.equal(typeof m.downloadNodeSdk,'function')`
  const sdk = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: stage, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(sdk.error); assert.equal(sdk.signal, null); assert.equal(sdk.status, 0, sdk.stderr)
  for (const file of descriptor.toolkit.files) assert.equal(hash(readFileSync(join(stage, file.path))), file.sha256)
})

for (const name of ['primary-token-worker.mjs', 'primary-token-evidence.mjs']) {
  test(`artifact preparer requires ${name} for actual primary-token evidence`, async t => {
    const { root, stage, cache, packages } = fixture(t)
    rmSync(join(root, nativePath, name))
    await assert.rejects(preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory: cache }), /primary-token/u)
  })
}
