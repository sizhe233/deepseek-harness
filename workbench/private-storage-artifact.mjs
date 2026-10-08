/** Prepare a generic, hashed, artifact-only private-storage acceptance toolkit once per candidate. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import * as tar from 'tar'
import { collectPrivateStorageNativeClosure, inspectArchiveEntries, verifyArchiveIntegrity } from './private-storage-closure.mjs'

import { PRIVATE_STORAGE_CLAIM } from './private-storage-applicability.mjs'

const NATIVE_TESTS = 'packages/storage/private-storage/tests/native'
const TOOLKIT = 'private-storage-tests'
const REQUIRED_FIXTURES = ['acceptance.mjs', 'verify-abi.mjs', 'abi-acceptance.mjs', 'process-fixture.mjs', 'primary-process.mjs', 'fault-worker.mjs', 'gc-worker.mjs', 'loader-negative.mjs', 'token-worker.mjs', 'primary-token-worker.mjs', 'primary-token-evidence.mjs', 'windows-oracle.c', 'README.md', 'admission-matrix.mjs', 'admission-process.mjs', 'admission-volumes.mjs', 'admission-volume-worker.mjs', 'windows-admission-oracle.c', 'boundary-matrix.mjs', 'boundary-support.mjs', 'boundary-worker.mjs', 'boundary-capability-worker.mjs', 'boundary-live-worker.mjs', 'boundary-inheritance.c', 'directory-boundary-matrix.mjs', 'directory-boundary-support.mjs', 'directory-boundary-worker.mjs', 'owner-fault-fixture.c', 'owner-fault-support.mjs', 'owner-fault-worker.mjs', 'owner-fault-matrix.mjs', 'owner-observer.mjs', 'descriptor-buffer-support.mjs', 'descriptor-buffer-worker.mjs']
const SUPPORT = { name: '@standard-schema/spec', version: '1.1.0', file: 'standard-schema-spec-1.1.0.tgz',
  tarball: 'https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz' }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const recordFile = (stage, file) => {
  const bytes = readFileSync(join(stage, file))
  return { path: file, sha256: sha256(bytes), bytes: bytes.length }
}

function selectedPackage(stage, packages, name) {
  const matches = packages.filter(item => item.name === name)
  assert.equal(matches.length, 1, `Exactly one candidate archive is required: ${name}`)
  const item = matches[0]
  assert.ok(typeof item.file === 'string' && !isAbsolute(item.file) && !item.file.includes('\\') && !item.file.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe candidate package archive path')
  const path = join(stage, item.file)
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Candidate package must be a regular archive')
  assert.ok(realpathSync(path).startsWith(realpathSync(stage) + sep), 'Candidate archive escapes staging')
  const observed = recordFile(stage, item.file)
  assert.equal(observed.sha256, item.sha256, `Candidate package archive changed: ${name}`)
  assert.equal(observed.bytes, item.bytes, `Candidate package archive size changed: ${name}`)
  return { ...item }
}

async function ordinaryDependency(root, stage, archiveDirectory) {
  const lockBytes = readFileSync(join(root, 'pnpm-lock.yaml'))
  const lock = yaml.load(lockBytes.toString('utf8'))
  const integrity = lock.packages?.[`${SUPPORT.name}@${SUPPORT.version}`]?.resolution?.integrity
  assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/u, 'Required Cordis support dependency must remain exactly lock-pinned')
  let bytes
  if (archiveDirectory) bytes = readFileSync(join(archiveDirectory, SUPPORT.file))
  else {
    const response = await fetch(SUPPORT.tarball, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
    assert.equal(response.status, 200, 'Ordinary dependency archive fetch failed')
    assert.equal(response.url, SUPPORT.tarball, 'Ordinary dependency archive source changed')
    const chunks = []
    let count = 0
    for await (const chunk of response.body) {
      count += chunk.length
      assert.ok(count <= 1024 * 1024, 'Ordinary dependency archive byte limit')
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks, count)
  }
  assert.ok(bytes.length <= 1024 * 1024, 'Ordinary dependency archive byte limit')
  verifyArchiveIntegrity(bytes, integrity)
  const path = join(stage, SUPPORT.file)
  assert.equal(existsSync(path), false, 'Ordinary dependency archive is already staged')
  writeFileSync(path, bytes, { flag: 'wx' })
  inspectArchiveEntries(path)
  let manifestText = ''
  tar.t({ file: path, sync: true, strict: true, onReadEntry(entry) {
    if (entry.path === 'package/package.json') entry.on('data', chunk => { manifestText += chunk.toString('utf8') })
  } })
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.name, SUPPORT.name)
  assert.equal(manifest.version, SUPPORT.version)
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'Ordinary support dependency unexpectedly expands the closure')
  return { ...SUPPORT, integrity, sha256: sha256(bytes), bytes: bytes.length, sourceLockSha256: sha256(lockBytes), lifecycleScriptsExecuted: false }
}

function copyGenericFixtures(root, stage, subdirectory = NATIVE_TESTS) {
  const files = []
  for (const name of readdirSync(join(root, subdirectory)).sort()) {
    const source = join(root, subdirectory, name)
    const stat = lstatSync(source)
    assert.equal(stat.isSymbolicLink(), false, 'Toolkit sources cannot be symlinks')
    if (stat.isDirectory()) { files.push(...copyGenericFixtures(root, stage, `${subdirectory}/${name}`)); continue }
    assert.ok(stat.isFile() && (name.endsWith('.mjs') || name.endsWith('.c') || name.endsWith('.h') || name.endsWith('.md') || name === 'README.i18n.yaml'), 'Unexpected file in generic native fixture directory')
    const file = `${TOOLKIT}/${subdirectory}/${name}`
    mkdirSync(dirname(join(stage, file)), { recursive: true })
    copyFileSync(source, join(stage, file))
    files.push(recordFile(stage, file))
  }
  return files
}

function toolkitInventory(stage, subdirectory = TOOLKIT) {
  return readdirSync(join(stage, subdirectory)).sort().flatMap(name => {
    const path = `${subdirectory}/${name}`
    const stat = lstatSync(join(stage, path))
    assert.equal(stat.isSymbolicLink(), false, 'Prepared toolkit cannot contain links')
    if (stat.isDirectory()) return toolkitInventory(stage, path)
    assert.ok(stat.isFile(), 'Prepared toolkit contains an unexpected entry type')
    return [recordFile(stage, path)]
  })
}

async function bundleRunner(root, stage) {
  const source = join(root, 'workbench/private-storage-packed.mjs')
  assert.ok(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'Generic packed acceptance runner is missing or linked')
  const { build } = await import('tsdown')
  let checkedOutput = false
  const checkModule = id => {
    const normalized = id.replaceAll('\\', '/')
    if (id.startsWith('\0') || isBuiltin(id) || normalized.includes('/node_modules/')) return
    const local = relative(root, id).replaceAll('\\', '/')
    assert.ok(/^workbench\/private-storage-[^/]+\.mjs$/u.test(local), `Runner includes non-toolkit repository code: ${local}`)
  }
  await build({ config: false, tsconfig: false, entry: { 'private-storage-packed': source }, outDir: join(stage, TOOLKIT, 'workbench'),
    platform: 'node', target: 'es2024', format: ['esm'], deps: { alwaysBundle: [/.*/], onlyBundle: false },
    dts: false, sourcemap: false, clean: false, minify: false, fixedExtension: true,
    outputOptions: { entryFileNames: 'private-storage-packed.mjs', codeSplitting: false },
    plugins: [{ name: 'private-storage-artifact-only-output', moduleParsed(info) { checkModule(info.id) }, generateBundle(_options, bundle) {
      assert.deepEqual(Object.keys(bundle), ['private-storage-packed.mjs'], 'Acceptance runner must produce exactly one self-contained entry')
      const entry = bundle['private-storage-packed.mjs']
      assert.equal(entry.type, 'chunk')
      assert.equal(entry.isEntry, true)
      assert.ok([...entry.imports, ...entry.dynamicImports].every(isBuiltin), 'Runner contains a non-builtin external import')
      for (const id of this.getModuleIds()) checkModule(id)
      checkedOutput = true
    } }],
  })
  assert.equal(checkedOutput, true, 'Runner bundle was not inspected')
  return recordFile(stage, `${TOOLKIT}/workbench/private-storage-packed.mjs`)
}

/** Build one immutable native closure and generic toolkit; never rebuild Host JavaScript per platform. */
export async function preparePrivateStorageAcceptance(root, stage, packages, { archiveDirectory, candidateNative } = {}) {
  root = resolve(root); stage = resolve(stage)
  const sourcePackage = selectedPackage(stage, packages, '@deepseek-ai/dsh-private-storage')
  const peerPackages = ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/dsh-brand'].map(name => selectedPackage(stage, packages, name))
  assert.equal(existsSync(join(stage, TOOLKIT)), false, 'Acceptance toolkit is already prepared')
  const nativeClosure = await collectPrivateStorageNativeClosure(root, stage,
    archiveDirectory ? { archiveDirectory: join(resolve(archiveDirectory), 'private-storage-native') } : {})
  const ordinary = await ordinaryDependency(root, stage, archiveDirectory ? resolve(archiveDirectory) : undefined)
  assert.equal(ordinary.sourceLockSha256, nativeClosure.lockSha256, 'Lockfile changed while preparing the candidate closure')
  for (const name of REQUIRED_FIXTURES) assert.ok(lstatSync(join(root, NATIVE_TESTS, name)).isFile(), `Required generic fixture missing: ${name}`)
  const files = copyGenericFixtures(root, stage)
  for (const path of ['workbench/private-storage-native.ps1', 'workbench/private-storage-sdk-matrices.ps1', 'workbench/private-storage-owner-fault.ps1',
    'workbench/private-storage-owner-fault-evidence.mjs', 'native/system/scripts/prepare-windows-node-sdk.mjs', 'native/system/scripts/download-node-sdk.mjs']) {
    const compilerFile = `${TOOLKIT}/${path}`
    mkdirSync(dirname(join(stage, compilerFile)), { recursive: true })
    const compilerSource = join(root, path)
    assert.ok(lstatSync(compilerSource).isFile() && !lstatSync(compilerSource).isSymbolicLink(), 'Compiler fixture must be a regular file')
    copyFileSync(compilerSource, join(stage, compilerFile))
    files.push(recordFile(stage, compilerFile))
  }
  if (candidateNative !== undefined) {
    const sourcePath = 'src/windows-private-owner.c'
    const expected = candidateNative.package.verifiedCandidateFiles.find(row => row.path === sourcePath)
    assert.ok(expected, 'Candidate native owner C source is absent')
    const bytes = execFileSync('tar', ['-xOf', join(stage, candidateNative.package.file), `package/${sourcePath}`], { maxBuffer: 64 * 1024 * 1024 })
    assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256, 'Native owner fixture source differs from packed production source')
    const file = `${TOOLKIT}/native/system/packages/entry/${sourcePath}`
    mkdirSync(dirname(join(stage, file)), { recursive: true }); writeFileSync(join(stage, file), bytes, { flag: 'wx' })
    files.push(recordFile(stage, file))
  }
  if (candidateNative !== undefined) {
    const sources = ['native/system/scripts/build-test-oracle.mjs', 'native/system/test/private-storage.test.js',
      'native/system/test/private-storage-worker.js', 'native/system/test/private-storage-fd-observer.js',
      'native/system/test/private-storage-process-birth-child.js', 'native/system/test/private-storage-source-link.test.js',
      'native/system/test/private-storage-syscall-oracle.c', 'native/system/test/private-storage-read-fault.c',
      'native/system/test/private-storage-directory-fault.c', 'native/system/test/fixtures/flock-oracle.c',
      'workbench/private-storage-posix-contract.json']
    for (const source of sources) {
      const input = join(root, source), file = `${TOOLKIT}/${source}`
      assert.ok(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink(), 'Native POSIX fixture must be a regular source file')
      mkdirSync(dirname(join(stage, file)), { recursive: true }); copyFileSync(input, join(stage, file)); files.push(recordFile(stage, file))
    }
  }
  const builtAbiPath = join(root, 'packages/storage/private-storage/lib/types/abi.js')
  assert.ok(lstatSync(builtAbiPath).isFile() && !lstatSync(builtAbiPath).isSymbolicLink(), 'Built ABI must be a regular file')
  const builtAbiSha256 = sha256(readFileSync(builtAbiPath))
  const { ABI } = await import(`${pathToFileURL(builtAbiPath).href}?sha256=${builtAbiSha256}`)
  assert.ok(ABI && typeof ABI === 'object' && Object.keys(ABI).length > 0
    && Object.values(ABI).every(value => Number.isSafeInteger(value) && value >= 0) && ABI.pointer > 0, 'Built ABI export must contain bounded integer offsets/sizes')
  const abiFile = `${TOOLKIT}/abi.json`
  writeFileSync(join(stage, abiFile), `${JSON.stringify(ABI, null, 2)}\n`, { flag: 'wx' })
  files.push(recordFile(stage, abiFile))
  const runner = await bundleRunner(root, stage)
  files.push(runner)
  files.sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(toolkitInventory(stage).sort((a, b) => a.path.localeCompare(b.path)), files, 'Toolkit contains an unhashed or changed file')
  return { schemaVersion: 1, claim: PRIVATE_STORAGE_CLAIM, sourcePackage, peerPackages, ordinaryDependencies: [ordinary], nativeClosure,
    ...(candidateNative === undefined ? {} : { candidateNative }),
    toolkit: { directory: TOOLKIT, entry: runner.path, abi: abiFile, files }, lifecycleScriptsExecuted: false, nativeCompilationPerformed: false }
}
