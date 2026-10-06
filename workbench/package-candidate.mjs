import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Read package identity and integrity from the archive that a consumer will install. */
export function inspectPackageArchive(path) {
  const bytes = readFileSync(path)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(typeof manifest.name, 'string', 'package name is required')
  assert.equal(typeof manifest.version, 'string', 'package version is required')
  return { name: manifest.name, version: manifest.version, file: basename(path), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** Reject ambiguous package identities before an artifact is accepted as one runtime closure. */
export function assertUniquePackages(packages) {
  const names = new Set()
  const files = new Set()
  for (const item of packages) {
    assert.ok(!names.has(item.name), `duplicate candidate package: ${item.name}`)
    assert.ok(!files.has(item.file), `duplicate candidate archive: ${item.file}`)
    names.add(item.name)
    files.add(item.file)
  }
  assert.ok(packages.length > 0, 'candidate contains no packages')
}

/** Refuse candidate use of a published native dependency if the reviewed source/runtime differs. */
export function verifyNativeDependencyFiles(root, metadata) {
  for (const file of metadata.verifiedCandidateFiles) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, file.path))).digest('hex'), file.sha256, `native dependency source changed: ${file.path}`)
  }
}

/** Package this clean source revision and record exact public artifact bytes; never touch a runtime or Home. */
export function packCandidate() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(git('status', '--porcelain'), '', 'candidate packaging requires a clean source revision')
  const commit = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  const compatibility = JSON.parse(readFileSync(join(root, 'workbench/compatibility.json'), 'utf8'))
  const directory = join(root, 'workbench-artifacts')
  mkdirSync(directory, { recursive: true })
  const destination = join(directory, commit)
  assert.ok(!existsSync(destination), 'candidate revision has already been packaged')
  const stage = mkdtempSync(join(directory, '.pack-'))
  // Package file manifests select public source/artifacts; never archive a checkout or Home.
  execFileSync('pnpm', ['-r', '--filter', './packages/**', '--filter', './apps/**', '--filter', './vendor/**', 'pack', '--pack-destination', stage], { cwd: root, stdio: 'inherit' })
  const packages = readdirSync(stage).filter(file => file.endsWith('.tgz')).sort().map(file => inspectPackageArchive(join(stage, file)))
  assertUniquePackages(packages)
  const seams = JSON.parse(readFileSync(join(root, 'workbench/runtime-seams.json'), 'utf8'))
  const runtimeBundles = seams.files.map(spec => {
    const sha256 = createHash('sha256').update(readFileSync(join(root, spec.path))).digest('hex')
    assert.equal(sha256, spec.afterSha256, `candidate runtime bridge is not applied: ${spec.path}`)
    return { name: '@deepseek-ai/' + spec.name, path: spec.path.slice(spec.path.indexOf('/lib/') + 1), sourcePath: spec.path, sha256 }
  })
  const chatPath = 'packages/client/ui-chat/lib/client.js'
  runtimeBundles.push({ name: '@deepseek-ai/dsh-client-ui-chat', path: 'lib/client.js', sourcePath: chatPath, sha256: createHash('sha256').update(readFileSync(join(root, chatPath))).digest('hex') })
  const nativeDependencies = JSON.parse(readFileSync(join(root, 'workbench/native-dependencies.json'), 'utf8'))
  verifyNativeDependencyFiles(root, nativeDependencies)
  const manifest = {
    schemaVersion: 2,
    commit,
    source: { repository: 'sizhe233/deepseek-harness', commit, tree, upstreamCommit: compatibility.upstreamWorkflowBase ?? compatibility.upstreamBase, acceptedImportBase: compatibility.upstreamBase },
    productionApproved: false,
    build: { platform: process.platform, arch: process.arch, node: process.version },
    packages,
    runtimeBundles,
    externalNativeDependencies: nativeDependencies,
  }
  writeFileSync(join(stage, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n')
  renameSync(stage, destination)
  console.log(`Packaged ${packages.length} candidate archives for ${commit} at ${destination}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packCandidate()
