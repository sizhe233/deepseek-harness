/** Bind native prebuild bytes to the exact source tree before cross-platform candidate assembly. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const digest = value => assert.match(value, /^[a-f0-9]{40}$/u, 'Exact Git object identity required')
function literal(value) {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9._/-]+$/u.test(value) && !isAbsolute(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe native artifact path')
  return value
}
function regular(root, name) {
  const path = join(root, literal(name))
  for (let current = path; current !== root; current = dirname(current)) {
    const info = lstatSync(current)
    assert.equal(info.isSymbolicLink(), false, 'Native artifact path is linked')
    assert.ok(current === path ? info.isFile() : info.isDirectory(), 'Unexpected native artifact object')
  }
  assert.ok(realpathSync(path).startsWith(realpathSync(root) + sep), 'Native artifact escapes its root')
  const info = lstatSync(path)
  assert.ok(info.size > 0 && info.size <= 32 * 1024 * 1024, 'Native artifact byte bound')
  const bytes = readFileSync(path)
  assert.equal(bytes.length, info.size, 'Native artifact changed while reading')
  return bytes
}
function identity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}')
  digest(commit); digest(tree)
  if (process.env.CANDIDATE_SHA) assert.equal(commit, process.env.CANDIDATE_SHA, 'Native build belongs to another workflow source')
  assert.equal(git('status', '--porcelain', '--', 'native/system'), '', 'Native source must match the recorded commit')
  return { repository: 'sizhe233/deepseek-harness', commit, tree }
}
function directories(root) {
  return readdirSync(join(root, 'native/system/packages')).filter(name => existsSync(join(root, 'native/system/packages', name, 'prebuilds.json'))).sort()
}
function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false, 'Native artifact inventory contains a link')
    if (entry.isDirectory()) return inventory(root, name)
    assert.ok(entry.isFile(), 'Native artifact inventory contains a special object')
    return [name]
  }).sort()
}
/** Build jobs emit this only after the repository's binary-format verification succeeds. */
export async function prepareNativeBuildArtifact(root, output) {
  root = resolve(root); output = resolve(output)
  const source = identity(root), platform = `${process.platform}-${process.arch}`
  const matches = directories(root).filter(name => json(join(root, 'native/system/packages', name, 'prebuilds.json')).platform === platform)
  assert.equal(matches.length, 1, 'Native runner must match exactly one declared package')
  const name = matches[0], packageRoot = join(root, 'native/system/packages', name)
  const { verifyPlatformBinaries } = await import(pathToFileURL(join(root, 'native/system/scripts/repo.mjs')).href)
  verifyPlatformBinaries(packageRoot)
  assert.equal(existsSync(output), false, 'Native artifact destination already exists')
  mkdirSync(output, { recursive: true })
  const prebuildsBytes = regular(packageRoot, 'prebuilds.json'), prebuilds = JSON.parse(prebuildsBytes)
  const binaries = prebuilds.binaries.map(binary => {
    const bytes = regular(packageRoot, binary.path), target = join(output, literal(binary.path))
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx', mode: binary.kind === 'static-musl' ? 0o755 : 0o644 })
    return { path: binary.path, bytes: bytes.length, sha256: hash(bytes), executable: binary.kind === 'static-musl' }
  })
  const descriptor = { schemaVersion: 1, source, platform, package: json(join(packageRoot, 'package.json')).name,
    version: json(join(packageRoot, 'package.json')).version, prebuildsSha256: hash(prebuildsBytes), node: process.version, binaries }
  writeFileSync(join(output, 'native-build.json'), JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx' })
  return descriptor
}
/** Verify the complete downloaded set before copying any prebuild into disposable build outputs. */
export async function assembleNativeBuildArtifacts(root, artifactRoot) {
  root = resolve(root); artifactRoot = resolve(artifactRoot)
  const source = identity(root), packages = directories(root), expected = packages.map(name => `candidate-native-${name}`).sort()
  assert.deepEqual(readdirSync(artifactRoot).sort(), expected, 'Complete native platform artifact set required')
  const all = [], builds = []
  for (const name of packages) {
    const input = join(artifactRoot, `candidate-native-${name}`), packageRoot = join(root, 'native/system/packages', name)
    assert.ok(lstatSync(input).isDirectory() && !lstatSync(input).isSymbolicLink(), 'Native artifact root must be a direct directory')
    const descriptor = JSON.parse(regular(input, 'native-build.json'))
    builds.push(descriptor)
    assert.equal(descriptor.schemaVersion, 1); assert.deepEqual(descriptor.source, source, 'Native prebuild source differs')
    const specBytes = regular(packageRoot, 'prebuilds.json'), spec = JSON.parse(specBytes), manifest = json(join(packageRoot, 'package.json'))
    assert.equal(descriptor.prebuildsSha256, hash(specBytes)); assert.equal(descriptor.platform, spec.platform)
    assert.equal(descriptor.package, manifest.name); assert.equal(descriptor.version, manifest.version)
    assert.deepEqual(descriptor.binaries.map(row => row.path).sort(), spec.binaries.map(row => row.path).sort(), 'Native payload declaration differs')
    assert.deepEqual(inventory(input), ['native-build.json', ...descriptor.binaries.map(row => row.path)].sort(), 'Native artifact contains undeclared files')
    for (const row of descriptor.binaries) {
      const binary = spec.binaries.find(item => item.path === row.path), bytes = regular(input, row.path)
      assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, hash(bytes)); assert.equal(row.executable, binary.kind === 'static-musl')
      all.push({ name, row, bytes, packageRoot })
    }
  }
  for (const { row, bytes, packageRoot } of all) {
    const target = join(packageRoot, literal(row.path)); mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) assert.ok(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(), 'Refuse a linked native build output')
    writeFileSync(target, bytes, { mode: row.executable ? 0o755 : 0o644 })
  }
  const { verifyPlatformBinaries } = await import(pathToFileURL(join(root, 'native/system/scripts/repo.mjs')).href)
  for (const name of packages) verifyPlatformBinaries(join(root, 'native/system/packages', name))
  return { source, platforms: packages, binaries: all.length, builds }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, root, output] = process.argv.slice(2)
  assert.ok(root && output, 'Usage: native-build-artifact.mjs prepare|assemble ROOT DIRECTORY')
  const result = action === 'prepare' ? await prepareNativeBuildArtifact(root, output) : action === 'assemble' ? await assembleNativeBuildArtifacts(root, output) : assert.fail('Unknown native artifact action')
  console.log(JSON.stringify(result))
}
