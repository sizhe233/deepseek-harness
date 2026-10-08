/** Profile-local compatibility permissions: exact identities, informed grants, and malformed data. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { getDshRuntimeVersion } from '../src/index.ts'
import { documentProviderFixture } from './document-provider-fixture.ts'
import {
  PROFILE_COMPATIBILITY_FILENAME, isExactPluginVersion,
  readProfileCompatibility, readProfileVersionExemptions, setProfileVersionExemption, validatePluginVersionExemption,
} from '../src/profile-compatibility.ts'

const runtime = getDshRuntimeVersion()

function profileFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compatibility-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function write(dir: string, value: unknown): void {
  writeFileSync(join(dir, PROFILE_COMPATIBILITY_FILENAME), JSON.stringify(value))
}

function managedFixture(initial = '{}\n') {
  const dir = profileFixture()
  const path = join(dir, PROFILE_COMPATIBILITY_FILENAME)
  const original = 'original compatibility bytes stay untouched\n'
  writeFileSync(path, original)
  const native = documentProviderFixture({ name: 'test', dir, home: dir, cwd: dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(dir, 'package.json'),
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }, [], { [path]: initial })
  return { dir, path, original, ...native }
}

it('publishes managed grants and revocations without replacing original compatibility bytes', async () => {
  const f = managedFixture('{"other@2.0.0":["0.0.1"]}')
  await setProfileVersionExemption(f.dir, 'plugin@1.0.0', runtime, true, true, f.documents)
  expect(readProfileVersionExemptions(f.dir, f.documents.current())).toEqual({
    'other@2.0.0': ['0.0.1'], 'plugin@1.0.0': [runtime],
  })
  await setProfileVersionExemption(f.dir, 'plugin@1.0.0', runtime, false, false, f.documents)
  expect(readProfileVersionExemptions(f.dir, f.documents.current())).toEqual({ 'other@2.0.0': ['0.0.1'] })
  expect(f.receipts.size).toBe(2)
  expect(readFileSync(f.path, 'utf8')).toBe(f.original)
})

it('rejects managed grants before publication without consent or for another Profile', async () => {
  const f = managedFixture()
  await expect(setProfileVersionExemption(f.dir, 'plugin@1.0.0', runtime, true, false, f.documents)).rejects.toThrow('crashes or data loss')
  await expect(setProfileVersionExemption(join(f.dir, 'other'), 'plugin@1.0.0', runtime, true, true, f.documents)).rejects.toThrow('admitted Profile')
  expect(f.receipts.size).toBe(0)
  expect(readFileSync(f.path, 'utf8')).toBe(f.original)
})

it('preserves newer managed permissions when the source view changes during validation', async () => {
  const f = managedFixture()
  f.beforePublish(() => { f.external({ [f.path]: '{"other@2.0.0":["0.0.1"]}' }) })
  await expect(setProfileVersionExemption(f.dir, 'plugin@1.0.0', runtime, true, true, f.documents)).rejects.toThrow('changed during validation')
  expect(f.receipts.size).toBe(0)
  expect(readProfileVersionExemptions(f.dir, f.documents.current())).toEqual({ 'other@2.0.0': ['0.0.1'] })
  expect(readFileSync(f.path, 'utf8')).toBe(f.original)
})

it.each(['unconfirmed', 'lost-ack'] as const)('retains managed publication facts without fallback or retry after %s', async (failure) => {
  const f = managedFixture()
  if (failure === 'unconfirmed') f.unconfirmed()
  else f.lateFailure(new Error('acknowledgement lost'))
  await expect(setProfileVersionExemption(f.dir, 'plugin@1.0.0', runtime, true, true, f.documents)).rejects.toMatchObject({
    receipt: { publication: 'published', durability: failure === 'unconfirmed' ? 'unconfirmed' : 'confirmed' },
  })
  expect(f.receipts.size).toBe(1)
  expect(readFileSync(f.path, 'utf8')).toBe(f.original)
})

it('reads no permissions from a profile without a compatibility file', () => {
  expect(readProfileVersionExemptions(profileFixture())).toEqual({})
})

it('reports an unreadable permission file instead of failing the profile', () => {
  const dir = profileFixture()
  mkdirSync(join(dir, PROFILE_COMPATIBILITY_FILENAME))
  const read = readProfileCompatibility(dir)
  expect(read.exemptions).toEqual({})
  expect(read.rewritable).toBe(false)
  expect(read.warnings.join('\n')).toMatch(/cannot be read/)
})

it('reads exact plugin and runtime identities, including build metadata', () => {
  const dir = profileFixture()
  write(dir, { '@scope/plugin@1.2.3+build.7': [runtime, '2.0.0-alpha+runtime'] })
  expect(readProfileVersionExemptions(dir)).toEqual({ '@scope/plugin@1.2.3+build.7': [runtime, '2.0.0-alpha+runtime'] })
})

it.each([
  ['an array', []], ['a string', 'all'], ['null', null],
  ['a non-list value', { 'plugin@1.2.3': '1.2.3' }],
  ['a non-string version', { 'plugin@1.2.3': [1] }],
  ['a range version', { 'plugin@1.2.3': ['^1.2.3'] }],
  ['a range key', { 'plugin@^1.2.3': [runtime] }],
  ['an unversioned key', { plugin: [runtime] }],
])('authorizes nothing for malformed permissions and reports them: %s', (_label, value) => {
  const dir = profileFixture()
  write(dir, value)
  const read = readProfileCompatibility(dir)
  // A bad file must never make the profile unusable: it grants nothing, so incompatible plugins stay denied.
  expect(read.exemptions).toEqual({})
  expect(read.rewritable).toBe(false)
  expect(read.warnings).toHaveLength(1)
  expect(read.warnings[0]).toContain(PROFILE_COMPATIBILITY_FILENAME)
})

it('keeps the records it accepted and reports only the rejected ones', () => {
  const dir = profileFixture()
  write(dir, { 'good@1.2.3': [runtime], 'bad@^1.0.0': [runtime], 'also-good@2.0.0': [] })
  const read = readProfileCompatibility(dir)
  expect(read.exemptions).toEqual({ 'good@1.2.3': [runtime], 'also-good@2.0.0': [] })
  expect(read.warnings).toHaveLength(1)
  expect(read.warnings[0]).toContain('bad@^1.0.0')
  expect(read.rewritable).toBe(false)
})

it('accepts an empty permission list as authorizing nothing', () => {
  const dir = profileFixture()
  write(dir, { 'plugin@1.2.3': [] })
  expect(readProfileVersionExemptions(dir)).toEqual({ 'plugin@1.2.3': [] })
  expect(readProfileCompatibility(dir)).toEqual({ exemptions: { 'plugin@1.2.3': [] }, warnings: [], rewritable: true })
})

it.each(['1.2.3', '1.2.3-alpha.1', '1.2.3+build.7', '1.2.3-alpha+build'])('accepts exact version %s', (version) => {
  expect(isExactPluginVersion(version)).toBe(true)
  expect(() => { validatePluginVersionExemption(`@scope/plugin@${version}`, version) }).not.toThrow()
})

it.each([
  ['plugin', '1.2.3'], ['plugin@^1.2.3', '1.2.3'], ['plugin@v1.2.3', '1.2.3'],
  ['plugin@1.2.3', '*'], ['plugin@1.2.3', ' 1.2.3'], ['../plugin@1.2.3', '1.2.3'],
])('rejects noncanonical identity %s / %s', (plugin, version) => {
  expect(() => { validatePluginVersionExemption(plugin, version) }).toThrow('exact')
})

it('requires explicit risk acknowledgement and the running runtime for a grant', async () => {
  const dir = profileFixture()
  await expect(setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, true, false)).rejects.toThrow('crashes or data loss')
  await expect(setProfileVersionExemption(dir, 'plugin@1.0.0', '9.9.9', true, true)).rejects.toThrow(`runs DSH ${runtime}`)
  expect(readProfileVersionExemptions(dir)).toEqual({})
})

it('persists grants with owner-only permissions and revokes one runtime without losing the others', async () => {
  const dir = profileFixture()
  await setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, true, true)
  await setProfileVersionExemption(dir, 'other@2.0.0', runtime, true, true)
  const filename = join(dir, PROFILE_COMPATIBILITY_FILENAME)
  expect(readProfileVersionExemptions(dir)).toEqual({ 'plugin@1.0.0': [runtime], 'other@2.0.0': [runtime] })
  expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual({ 'plugin@1.0.0': [runtime], 'other@2.0.0': [runtime] })
  if (process.platform !== 'win32') expect(statSync(filename).mode & 0o777).toBe(0o600)

  // A repeated grant never duplicates, and a grant left by an older runtime can still be revoked.
  await setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, true, true)
  expect(readProfileVersionExemptions(dir)['plugin@1.0.0']).toEqual([runtime])
  write(dir, { 'plugin@1.0.0': [runtime, '0.0.1'], 'other@2.0.0': [runtime] })
  await setProfileVersionExemption(dir, 'plugin@1.0.0', '0.0.1', false, false)
  expect(readProfileVersionExemptions(dir)).toEqual({ 'plugin@1.0.0': [runtime], 'other@2.0.0': [runtime] })
  await setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, false, false)
  expect(readProfileVersionExemptions(dir)).toEqual({ 'other@2.0.0': [runtime] })
})

it('creates the profile directory for a first grant and refuses to widen malformed permissions', async () => {
  const dir = profileFixture()
  const nested = join(dir, 'profiles', 'test')
  await setProfileVersionExemption(nested, 'plugin@1.0.0', runtime, true, true)
  expect(readProfileVersionExemptions(nested)).toEqual({ 'plugin@1.0.0': [runtime] })
  write(nested, { 'plugin@*': [runtime] })
  // Rewriting a file the reader rejected would discard the user's content, so a write refuses.
  await expect(setProfileVersionExemption(nested, 'other@1.0.0', runtime, true, true)).rejects.toThrow(/must be repaired/)
  expect(readFileSync(join(nested, PROFILE_COMPATIBILITY_FILENAME), 'utf8')).toContain('plugin@*')
})

it('still revokes an accepted grant while another record is rejected', async () => {
  const dir = profileFixture()
  await setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, true, true)
  write(dir, { 'plugin@1.0.0': [runtime], 'bad@1.0.0': 'not-a-list' })
  await expect(setProfileVersionExemption(dir, 'plugin@1.0.0', runtime, false, false)).rejects.toThrow(/must be repaired/)
})
