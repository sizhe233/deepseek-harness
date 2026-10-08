import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPackageArchive, assertUniquePackages, verifyNativeDependencyFiles } from './package-candidate.mjs'

test('candidate identity and hash describe the actual packed archive', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-candidate-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'package'))
  writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: '@example/host', version: '0.2.1-alpha.1' }))
  const archive = join(root, 'host.tgz')
  execFileSync('tar', ['-czf', archive, '-C', root, 'package'])
  const bytes = readFileSync(archive)
  assert.deepEqual(inspectPackageArchive(archive), { name: '@example/host', version: '0.2.1-alpha.1', file: 'host.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
})

test('a candidate rejects empty and ambiguous package sets', () => {
  const first = { name: '@example/host', file: 'host.tgz' }
  assert.throws(() => assertUniquePackages([]), /no packages/)
  assert.throws(() => assertUniquePackages([first, { ...first, file: 'other.tgz' }]), /duplicate candidate package/)
  assert.throws(() => assertUniquePackages([first, { ...first, name: '@example/other' }]), /duplicate candidate archive/)
  assert.doesNotThrow(() => assertUniquePackages([first, { name: '@example/vendor', file: 'vendor.tgz' }]))
})

test('published native dependency acceptance is bound to the candidate source bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'source.c'), 'reviewed native source\n')
  const metadata = { verifiedCandidateFiles: [{ path: 'source.c', sha256: createHash('sha256').update('reviewed native source\n').digest('hex') }] }
  assert.doesNotThrow(() => verifyNativeDependencyFiles(root, metadata))
  writeFileSync(join(root, 'source.c'), 'changed native source\n')
  assert.throws(() => verifyNativeDependencyFiles(root, metadata), /native dependency source changed/)
  assert.throws(() => verifyNativeDependencyFiles(root, { verifiedCandidateFiles: [{ path: 'missing.c', sha256: metadata.verifiedCandidateFiles[0].sha256 }] }), /ENOENT/)
})

test('candidate native source and entry runtime match the audited published package', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const metadata = JSON.parse(readFileSync(new URL('native-dependencies.json', import.meta.url), 'utf8'))
  verifyNativeDependencyFiles(root, metadata)
})
