import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import yaml from 'js-yaml'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const PATCH_USAGE = {
  '@earendil-works/pi-ai@0.87.1': 'runtime',
  '@electron/osx-sign@1.3.3': 'build-only',
  '@fortune-sheet/core@1.0.4': 'bundled',
  '@fortune-sheet/react@1.0.4': 'bundled',
  '@yao-pkg/pkg@6.21.0': 'build-only',
  'exceljs@4.4.0': 'bundled',
  'node-pty@1.2.0-beta.15': 'runtime',
}

/** Accept only reviewed regular-file patch targets within a dependency package. */
export function patchTargets(text) {
  const paths = [...text.matchAll(/^\+\+\+ (.+)$/gm)].map(match => {
    assert.ok(match[1].startsWith('b/'), 'dependency patch must retain a regular target file')
    const path = match[1].slice(2)
    assert.ok(path !== '' && !isAbsolute(path) && !path.includes('\\') && !/[\x00-\x20\x7f:]/.test(path) && !path.split('/').some(part => part === '..' || part === '' || part === '.'), 'unsafe dependency patch target')
    return path
  })
  assert.ok(paths.length > 0, 'dependency patch has no target files')
  assert.equal(new Set(paths).size, paths.length, 'duplicate dependency patch target')
  return paths
}

/** Locate one exact patched release payload, rejecting unpatched or ambiguous installations. */
export function installedPatchedPackage(root, name, version) {
  const store = join(root, 'node_modules/.pnpm')
  const prefix = `${name.replace('/', '+')}@${version}_patch_hash=`
  const directories = new Set(readdirSync(store).filter(entry => entry.startsWith(prefix)).map(entry => join(store, entry, 'node_modules', name)).filter(path => existsSync(join(path, 'package.json'))).map(path => realpathSync(path)))
  assert.equal(directories.size, 1, `expected one installed patched dependency: ${name}@${version}`)
  const directory = [...directories][0]
  assert.ok(directory.startsWith(realpathSync(store) + sep), 'patched dependency escapes the package store')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  assert.equal(manifest.name, name, 'patched dependency name mismatch')
  assert.equal(manifest.version, version, 'patched dependency version mismatch')
  return directory
}

/** Verify the installed target bytes really contain the complete reviewed patch. */
export function verifyAppliedPatch(directory, patch, files) {
  const proof = mkdtempSync(join(tmpdir(), 'dsh-dependency-patch-'))
  try {
    for (const file of files) {
      const target = join(proof, file)
      mkdirSync(dirname(target), { recursive: true })
      const source = join(directory, file)
      assert.ok(lstatSync(source).isFile() && realpathSync(source).startsWith(realpathSync(directory) + sep), 'patch target must be a regular package file')
      copyFileSync(source, target)
    }
    execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: proof, stdio: 'pipe' })
  } finally {
    rmSync(proof, { recursive: true, force: true })
  }
}

/** Export lock-bound patch recipes without rebuilding or repacking third-party releases. */
export function collectDependencyPatches(root, destination, usage = PATCH_USAGE) {
  const workspace = yaml.load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const lock = yaml.load(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const configured = workspace.patchedDependencies ?? {}
  assert.deepEqual(Object.keys(configured).sort(), Object.keys(lock.patchedDependencies ?? {}).sort(), 'workspace and lockfile patch inventories differ')
  return Object.entries(configured).sort(([a], [b]) => a.localeCompare(b)).map(([selector, relativePatch]) => {
    assert.ok(['runtime', 'bundled', 'build-only'].includes(usage[selector]), `patch use must be reviewed: ${selector}`)
    const split = selector.lastIndexOf('@')
    assert.ok(split > 0, 'patched dependency must pin an exact package version')
    const name = selector.slice(0, split)
    const version = selector.slice(split + 1)
    assert.match(name, /^(?:@[^/@\s]+\/)?[^/@\s]+$/)
    assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
    assert.equal(typeof relativePatch, 'string', 'dependency patch path is required')
    const patch = resolve(root, relativePatch)
    assert.ok(patch.startsWith(resolve(root, 'patches') + sep), 'dependency patch must belong to source patches')
    assert.ok(lstatSync(patch).isFile() && realpathSync(patch).startsWith(realpathSync(join(root, 'patches')) + sep), 'source patch must be a regular source file')
    const bytes = readFileSync(patch)
    const patchSha256 = sha256(bytes)
    assert.equal(lock.patchedDependencies[selector], patchSha256, `patch differs from the frozen lockfile: ${selector}`)
    const sourceIntegrity = lock.packages?.[selector]?.resolution?.integrity
    assert.match(sourceIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `original registry integrity is required: ${selector}`)
    const directory = installedPatchedPackage(root, name, version)
    const paths = patchTargets(bytes.toString('utf8'))
    verifyAppliedPatch(directory, patch, paths)
    const files = paths.map(path => ({ path, sha256: sha256(readFileSync(join(directory, path))) }))
    const patchFile = `dependency-patches/${basename(relativePatch)}`
    mkdirSync(join(destination, 'dependency-patches'), { recursive: true })
    copyFileSync(patch, join(destination, patchFile))
    return { selector, name, version, sourceIntegrity, patchFile, patchSha256, patchBytes: bytes.length, usage: usage[selector], files }
  })
}
