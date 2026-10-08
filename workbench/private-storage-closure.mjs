/** Immutable, lock-bound Koffi archives and checkout-independent, script-free consumer materialization. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import semver from 'semver'
import * as tar from 'tar'

const VERSION = '3.1.1'
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const SLICES = Object.freeze([
  { platform: 'win32', architecture: 'x64' },
  { platform: 'darwin', architecture: 'arm64' },
  { platform: 'darwin', architecture: 'x64' },
  { platform: 'linux', architecture: 'x64' },
])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const packageNames = ['koffi', ...SLICES.map(slice => `@koromix/koffi-${slice.platform}-${slice.architecture}`)]
const packageFile = name => `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`

/** Read only exact reviewed package selections from the frozen public lockfile. */
export function privateStorageClosurePlan(root) {
  const bytes = readFileSync(join(root, 'pnpm-lock.yaml'))
  const lock = yaml.load(bytes.toString('utf8'))
  return {
    lockSha256: sha256(bytes),
    packages: packageNames.map(name => {
      const integrity = lock.packages?.[`${name}@${VERSION}`]?.resolution?.integrity
      assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, `Missing exact lockfile integrity: ${name}@${VERSION}`)
      const leaf = name.slice(name.lastIndexOf('/') + 1)
      return { name, version: VERSION, integrity, file: `private-storage-native/${packageFile(name)}`,
        tarball: `https://registry.npmjs.org/${name}/-/${leaf}-${VERSION}.tgz` }
    }),
  }
}

/** Bound and verify registry archive bytes before parsing or extracting their content. */
export function verifyArchiveIntegrity(bytes, integrity) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_ARCHIVE_BYTES, 'Archive byte limit')
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 'Exact SHA512 integrity is required')
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, integrity, 'Archive differs from frozen lockfile integrity')
}

/** Reject links, traversal, duplicate files and expansion bombs before node-tar extracts an archive. */
export function inspectArchiveEntries(file) {
  const entries = []
  const seen = new Set()
  let expanded = 0
  tar.t({ file, sync: true, strict: true, onReadEntry(entry) {
    const path = entry.path.replace(/\/$/, '')
    assert.ok(path === 'package' || path.startsWith('package/'), 'Archive must have one package root')
    assert.match(path, /^[\x20-\x7e]+$/u, 'Closure archives require portable ASCII entry names')
    // oxlint-disable-next-line no-control-regex -- Control bytes and Windows stream syntax are unsafe archive names.
    assert.ok(!isAbsolute(path) && !/[\\:\x00-\x1f\x7f<>"|?*]/u.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)), 'Unsafe archive entry path')
    assert.ok(entry.type === 'File' || entry.type === 'Directory', 'Only regular files and directories are accepted')
    const collisionKey = path.toLowerCase()
    assert.ok(!seen.has(collisionKey), 'Duplicate or case-colliding archive entry')
    seen.add(collisionKey)
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_EXPANDED_BYTES, 'Archive entry size limit')
    expanded += entry.size
    assert.ok(expanded <= MAX_EXPANDED_BYTES && entries.length < 10000, 'Archive expansion limit')
    entries.push({ path, type: entry.type, bytes: entry.size })
  } })
  assert.ok(entries.some(entry => entry.path === 'package/package.json' && entry.type === 'File'), 'Archive package manifest missing')
  return entries
}

function unpackChecked(file, destination) {
  const entries = inspectArchiveEntries(file)
  mkdirSync(destination, { recursive: true })
  tar.x({ file, cwd: destination, sync: true, strict: true, strip: 1, preserveOwner: false, noMtime: true,
    filter: (_path, entry) => entry.type === 'File' || entry.type === 'Directory' })
  return entries
}

function inspectArchive(file, expected) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-private-archive-'))
  try {
    const entries = unpackChecked(file, scratch)
    const manifest = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))
    assert.equal(manifest.name, expected.name, 'Archive package name differs from candidate')
    assert.equal(manifest.version, expected.version, 'Archive package version differs from candidate')
    const nativeBinaries = entries.filter(entry => entry.type === 'File' && entry.path.endsWith('.node')).map(entry => {
      const path = entry.path.slice('package/'.length)
      return { path, bytes: entry.bytes, sha256: sha256(readFileSync(join(scratch, path))) }
    }).sort((a, b) => a.path.localeCompare(b.path))
    return { manifest, nativeBinaries }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

async function fetchPinnedArchive(pin) {
  const response = await fetch(pin.tarball, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  assert.equal(response.url, pin.tarball, 'Registry redirect or alternate source is forbidden')
  assert.equal(response.status, 200, `Registry archive fetch failed: ${pin.name}`)
  const chunks = []
  let total = 0
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength
      assert.ok(total <= MAX_ARCHIVE_BYTES, 'Archive download byte limit')
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    // oxlint-disable-next-line no-unused-vars -- Cancellation must preserve the original download failure.
    try { await response.body?.cancel() } catch (_cancelError) { /* Preserve the archive validation or network failure. */ }
    throw error
  }
  return Buffer.concat(chunks, total)
}

/** Copy exact upstream archives once; no npm pack, install scripts, native compilation or repacking. */
export async function collectPrivateStorageNativeClosure(root, destination, { archiveDirectory, fetchArchive = fetchPinnedArchive } = {}) {
  const plan = privateStorageClosurePlan(root)
  const packages = []
  for (const pin of plan.packages) {
    const file = join(destination, pin.file)
    assert.equal(existsSync(file), false, 'Closure destination archive already exists')
    const bytes = archiveDirectory ? readFileSync(join(archiveDirectory, packageFile(pin.name))) : await fetchArchive(pin)
    verifyArchiveIntegrity(bytes, pin.integrity)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes, { flag: 'wx' })
    const { manifest, nativeBinaries } = inspectArchive(file, pin)
    assert.deepEqual(manifest.dependencies ?? {}, {}, 'Unexpected Koffi runtime dependency needs a separately pinned archive')
    if (pin.name === 'koffi') {
      assert.equal(nativeBinaries.length, 0, 'Koffi entry archive unexpectedly contains a native binary')
      for (const name of packageNames.slice(1)) assert.equal(manifest.optionalDependencies?.[name], VERSION)
    } else {
      const slice = SLICES.find(item => pin.name === `@koromix/koffi-${item.platform}-${item.architecture}`)
      assert.deepEqual(manifest.os, [slice.platform])
      assert.deepEqual(manifest.cpu, [slice.architecture])
      assert.ok(nativeBinaries.some(binary => binary.path === `${slice.platform}_${slice.architecture}/koffi.node`), 'Expected native payload absent')
    }
    packages.push({ ...pin, sha256: sha256(bytes), bytes: bytes.length, nativeBinaries })
  }
  return {
    schemaVersion: 1,
    owner: '@deepseek-ai/dsh-private-storage',
    lockSha256: plan.lockSha256,
    lifecycleScriptsExecuted: false,
    archivesRepacked: false,
    packages,
    platformSlices: SLICES.map(slice => ({ ...slice, package: `@koromix/koffi-${slice.platform}-${slice.architecture}`, acceptance: 'not-run' })),
    excludedArchitectures: [{ platform: 'win32', architecture: 'arm64', reason: 'Native suite has not run; no support is claimed' }],
  }
}

function checkedArtifact(directory, item) {
  // oxlint-disable-next-line no-control-regex -- Candidate paths must not contain stream syntax or control bytes.
  assert.ok(typeof item.file === 'string' && !isAbsolute(item.file) && !/[\\:\x00-\x1f\x7f]/u.test(item.file)
    && !item.file.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe candidate archive path')
  const root = realpathSync(directory)
  const file = join(root, item.file)
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Candidate archive must be a regular file')
  assert.ok(realpathSync(file).startsWith(root + sep), 'Candidate archive escapes its artifact directory')
  const bytes = readFileSync(file)
  assert.equal(sha256(bytes), item.sha256, `Candidate archive hash mismatch: ${item.name}`)
  if (item.integrity) verifyArchiveIntegrity(bytes, item.integrity)
  else assert.ok(bytes.length <= MAX_ARCHIVE_BYTES, 'Candidate archive byte limit')
  return file
}

/** Require every runtime dependency and nonoptional peer from the same fixed archive inventory. */
export function verifyConsumerDependencies(manifests) {
  const byName = new Map(manifests.map(manifest => [manifest.name, manifest]))
  assert.equal(byName.size, manifests.length, 'Duplicate consumer package name')
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      assert.ok(byName.has(name), `Missing declared dependency ${name} required by ${manifest.name}`)
      assert.ok(semver.satisfies(byName.get(name).version, range), `Dependency version mismatch: ${manifest.name} -> ${name}@${range}`)
    }
    for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
      if (byName.has(name)) assert.ok(semver.satisfies(byName.get(name).version, range), `Optional dependency version mismatch: ${manifest.name} -> ${name}@${range}`)
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!byName.has(name) && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
      assert.ok(byName.has(name), `Missing required peer ${name} required by ${manifest.name}`)
      assert.ok(semver.satisfies(byName.get(name).version, range), `Peer version mismatch: ${manifest.name} -> ${name}@${range}`)
    }
  }
}

/** Materialize a flat, fresh, offline consumer from verified candidate archives without executing scripts. */
export function materializePrivateStorageConsumer({ artifactDirectory, storagePackage, closure, destination, additionalPackages = [], platform = process.platform, architecture = process.arch }) {
  assert.equal(closure.schemaVersion, 1)
  assert.match(closure.lockSha256, /^[0-9a-f]{64}$/u, 'Native closure must identify its source lockfile')
  assert.equal(closure.packages.length, packageNames.length, 'Native closure package inventory is incomplete')
  assert.deepEqual(closure.packages.map(item => item.name).sort(), [...packageNames].sort(), 'Unexpected native closure package')
  for (const item of closure.packages) {
    assert.equal(item.version, VERSION, 'Native closure release substitution')
    assert.match(item.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, 'Native closure integrity missing')
  }
  assert.ok(SLICES.some(item => item.platform === platform && item.architecture === architecture), 'Platform is absent from the reviewed native closure')
  const slice = closure.platformSlices.find(item => item.platform === platform && item.architecture === architecture)
  assert.ok(slice, 'Platform is absent from the fixed native closure')
  assert.equal(slice.package, `@koromix/koffi-${platform}-${architecture}`)
  assert.ok(additionalPackages.every(item => !packageNames.includes(item.name) && !item.name.startsWith('@koromix/koffi-')), 'Additional packages cannot widen the selected native platform')
  assert.equal(storagePackage.name, '@deepseek-ai/dsh-private-storage')
  const selected = [storagePackage, ...closure.packages.filter(item => item.name === 'koffi' || item.name === slice.package), ...additionalPackages]
  assert.equal(selected.filter(item => item.name === 'koffi').length, 1)
  assert.equal(selected.filter(item => item.name === slice.package).length, 1)
  assert.equal(new Set(selected.map(item => item.name)).size, selected.length, 'Duplicate consumer package')
  const target = resolve(destination)
  const checkout = fileURLToPath(new URL('../', import.meta.url))
  assert.ok(target !== resolve(checkout) && !target.startsWith(resolve(checkout) + sep), 'Consumer must be outside the source checkout')
  assert.ok(!existsSync(target) || readdirSync(target).length === 0, 'Consumer destination must be fresh and empty')
  mkdirSync(target, { recursive: true })
  const manifests = []
  for (const item of selected) {
    assert.match(item.name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)
    const file = checkedArtifact(artifactDirectory, item)
    const packageDirectory = join(target, 'node_modules', item.name)
    const { manifest, nativeBinaries } = inspectArchive(file, item)
    if (item.nativeBinaries) assert.deepEqual(nativeBinaries, item.nativeBinaries, 'Native payload inventory differs from manifest')
    unpackChecked(file, packageDirectory)
    manifests.push(manifest)
  }
  verifyConsumerDependencies(manifests)
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: 'private-storage-offline-acceptance', private: true, type: 'module',
    dependencies: Object.fromEntries(manifests.map(manifest => [manifest.name, manifest.version])) }, null, 2)}\n`, { flag: 'wx' })
  const entry = join(target, 'node_modules', storagePackage.name, 'lib', 'index.js')
  assert.ok(lstatSync(entry).isFile(), 'Packed storage JavaScript entry is missing')
  const inventory = { platform, architecture, selectedPlatformPackage: slice.package, entry, packages: selected,
    lifecycleScriptsExecuted: false, networkUsedForMaterialization: false, checkoutDependencyLinks: false,
    sourceFilesystemIsolation: 'not-enforced-by-materializer', root: target }
  writeFileSync(join(target, 'consumer-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' })
  return inventory
}

/** Compare loaded capability identities with independently inspected Koffi and resource-owner payloads. */
export function verifyConsumerRuntimeIdentities(capabilities, koffi, candidateNative, assertions) {
  if (!capabilities.available) return
  assertions.equal(capabilities.nativeArtifact.koffiVersion, '3.1.1')
  assertions.equal(capabilities.nativeArtifact.platformPackage, koffi.package)
  assertions.equal(capabilities.nativeArtifact.nativeBinarySha256, koffi.sha256)
  if (candidateNative !== undefined) assertions.deepEqual(capabilities.ownershipArtifact, candidateNative)
}

/** Import the standalone package and verify the separately selected Koffi and resource-owner payloads. */
export function smokePrivateStorageConsumer(consumer) {
  const probe = join(consumer.root, 'consumer-probe.mjs')
  const script = `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
const require = createRequire(import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('./consumer-inventory.json', import.meta.url), 'utf8'));
const storage = await import('@deepseek-ai/dsh-private-storage');
const capabilities = storage.capabilities();
assert.equal(capabilities.available, process.platform === 'win32' && process.arch === 'x64');
const koffi = require('koffi');
assert.equal(koffi.version, '3.1.1');
const selected = inventory.packages.find(item => item.name === inventory.selectedPlatformPackage);
const directory = realpathSync(join(inventory.root, 'node_modules', selected.name));
const binaries = Object.keys(require.cache).filter(path => path.endsWith('.node') && realpathSync(path).startsWith(directory + sep));
assert.equal(binaries.length, 1, 'Exactly one native binary must be loaded');
const binary = realpathSync(binaries[0]);
assert.ok(binary.startsWith(directory + sep), 'Native loader selected a file outside its pinned platform package');
const relative = binary.slice(directory.length + 1).split(sep).join('/');
const expected = selected.nativeBinaries.find(item => item.path === relative);
assert.ok(expected, 'Loaded binary is absent from the immutable closure');
const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(digest, expected.sha256);
const nativeEntry = inventory.packages.find(item => item.name === '@deepseek-ai/node-addon-system');
let candidateNative;
if (nativeEntry) {
  const native = process.platform === 'win32'
    ? await import('@deepseek-ai/node-addon-system/windows-private-owner')
    : await import('@deepseek-ai/node-addon-system/private-storage');
  candidateNative = process.platform === 'win32' ? native.inspectWindowsPrivateOwnerRuntime() : native.inspectPosixStorageRuntime();
  const selectedNative = inventory.packages.find(item => item.name === candidateNative.platformPackage.name);
  assert.ok(selectedNative, 'Native owner platform is not in the candidate closure');
  const payload = selectedNative.binaries.find(item => item.path === candidateNative.platformPackage.binary);
  assert.ok(payload); assert.equal(payload.sha256, candidateNative.platformPackage.sha256); assert.equal(payload.bytes, candidateNative.platformPackage.bytes);
  const entryFile = nativeEntry.verifiedCandidateFiles.find(item => item.path === candidateNative.entry.file);
  assert.ok(entryFile); assert.equal(entryFile.sha256, candidateNative.entry.sha256);
  assert.equal(storage.streamCapabilities().available, true, 'Candidate streaming backend must load on every supported runner');
}
(${verifyConsumerRuntimeIdentities.toString()})(capabilities, { package: selected.name, sha256: digest }, candidateNative, assert);
console.log(JSON.stringify({ complete: true, capabilities, candidateNative, nativeBinary: { package: selected.name, path: relative, sha256: digest }, lifecycleScriptsExecuted: false, checkoutIndependent: true }));
`
  writeFileSync(probe, script, { flag: 'wx' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())))
  env.npm_config_ignore_scripts = 'true'
  env.npm_config_offline = 'true'
  const child = spawnSync(process.execPath, [probe], { cwd: consumer.root, env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}
