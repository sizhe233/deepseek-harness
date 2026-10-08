/** Exact same-source native package archives, including every declared platform payload. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { inspectArchiveEntries } from './private-storage-closure.mjs'
import { assembleNativeBuildArtifacts } from './native-build-artifact.mjs'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const member = (archive, path) => execFileSync('tar', ['-xOf', archive, `package/${path}`], { maxBuffer: 64 * 1024 * 1024 })
/** Verify packed bytes against the source metadata and the assembled build receipt before returning their identity. */
export function inspectNativeCandidateArchive(archive, packageRoot, build) {
  const entries = inspectArchiveEntries(archive), manifest = JSON.parse(member(archive, 'package.json'))
  const sourceManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, sourceManifest.name); assert.equal(manifest.version, '0.1.3'); assert.equal(manifest.version, sourceManifest.version)
  const bytes = readFileSync(archive)
  const record = { name: manifest.name, version: manifest.version, file: basename(archive), bytes: bytes.length,
    sha256: sha256(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
  if (build) {
    assert.equal(build.package, manifest.name); assert.equal(build.version, manifest.version)
    const prebuilds = member(archive, 'prebuilds.json')
    assert.equal(sha256(prebuilds), build.prebuildsSha256, 'Packed platform metadata changed')
    assert.deepEqual(entries.filter(row => row.type === 'File' && row.path.startsWith('package/bin/')).map(row => row.path.slice(8)).sort(), build.binaries.map(row => row.path).sort(), 'Packed native binary inventory differs')
    for (const binary of build.binaries) {
      const value = member(archive, binary.path)
      assert.equal(value.length, binary.bytes); assert.equal(sha256(value), binary.sha256, 'Packed native binary differs from the same-source build')
    }
    assert.deepEqual(manifest.os, [build.platform.split('-')[0]]); assert.deepEqual(manifest.cpu, [build.platform.split('-')[1]])
    return { ...record, platform: build.platform, prebuildsSha256: build.prebuildsSha256, binaries: build.binaries }
  }
  assert.equal(manifest.name, '@deepseek-ai/node-addon-system')
  for (const name of ['private-storage', 'windows-private-owner', 'flock', 'landlock-run']) assert.ok(manifest.exports[`./${name}`], `Native entry export missing: ${name}`)
  const verifiedCandidateFiles = entries.filter(row => row.type === 'File' && /^(?:package\/src\/.+\.[ch]|package\/lib\/.+\.js)$/u.test(row.path)).map(row => {
    const path = row.path.slice(8), packed = member(archive, path)
    assert.equal(sha256(packed), sha256(readFileSync(join(packageRoot, path))), `Native entry source/runtime changed during pack: ${path}`)
    return { path, sha256: sha256(packed), bytes: packed.length }
  }).sort((a, b) => a.path.localeCompare(b.path))
  for (const path of ['src/main.c', 'src/flock.c', 'src/private-storage.c', 'src/windows-private-owner.c', 'lib/private-storage.js', 'lib/windows-private-owner.js']) assert.ok(verifiedCandidateFiles.some(row => row.path === path), `Required native entry source missing: ${path}`)
  return { ...record, verifiedCandidateFiles }
}
/** Assemble verified same-source native outputs, then pack once for all downstream consumers. */
export async function prepareNativeCandidate(root, stage, artifactRoot) {
  assert.ok(artifactRoot, 'CANDIDATE_NATIVE_ARTIFACTS must name the complete same-source native build outputs')
  root = resolve(root); stage = resolve(stage)
  const assembled = await assembleNativeBuildArtifacts(root, artifactRoot)
  const parent = join(root, 'native/system/.release'); mkdirSync(parent, { recursive: true })
  const output = mkdtempSync(join(parent, 'candidate-pack-'))
  execFileSync(process.execPath, [join(root, 'native/system/scripts/pack-release.mjs'), output], { cwd: root, stdio: 'inherit' })
  const packageDirectories = readdirSync(join(root, 'native/system/packages')).filter(name => existsSync(join(root, 'native/system/packages', name, 'package.json')))
  const specs = packageDirectories.map(name => ({ root: join(root, 'native/system/packages', name), manifest: JSON.parse(readFileSync(join(root, 'native/system/packages', name, 'package.json'), 'utf8')) }))
  const archives = readdirSync(output).filter(name => name.endsWith('.tgz')).sort()
  assert.equal(archives.length, specs.length, 'Complete native archive family required')
  const packages = archives.map(file => {
    const archive = join(output, file), manifest = JSON.parse(member(archive, 'package.json'))
    const selected = specs.find(row => row.manifest.name === manifest.name)
    assert.ok(selected, 'Native archive names an undeclared source package')
    const build = assembled.builds.find(row => row.package === manifest.name)
    const record = inspectNativeCandidateArchive(archive, selected.root, build)
    assert.equal(existsSync(join(stage, record.file)), false, 'Candidate native archive collides with another package')
    copyFileSync(archive, join(stage, record.file)); return record
  })
  assert.equal(new Set(packages.map(row => row.name)).size, specs.length, 'Native archive identities must be unique')
  const entry = packages.find(row => row.name === '@deepseek-ai/node-addon-system')
  assert.ok(entry)
  const platformPackages = packages.filter(row => row !== entry).sort((a, b) => a.platform.localeCompare(b.platform))
  assert.deepEqual(platformPackages.map(row => row.platform), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  const packedEntry = JSON.parse(member(join(output, entry.file), 'package.json'))
  assert.deepEqual(Object.keys(packedEntry.optionalDependencies).sort(), platformPackages.map(row => row.name).sort())
  for (const version of Object.values(packedEntry.optionalDependencies)) assert.equal(version, '~0.1.3')
  return { schemaVersion: 2, kind: 'candidate-native-packages-v1', source: assembled.source,
    package: entry, platformPackages, builds: assembled.builds, nativePackagePrepackChecksExecuted: true, consumerLifecycleScriptsExecuted: false,
    acceptance: 'Exact candidate-built archives; each native runner must execute its selected payload and preserve source/build/archive receipts.' }
}
