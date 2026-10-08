/** Native document rejection paths preserve fixed code selection and never mount candidate plugins. */
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup, ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { dump } from 'js-yaml'
import { createProfileDocumentSemantics, type ProfileDocumentSemanticOptions } from '../src/profile-document-semantics.ts'
import { getDshRuntimeVersion, type ProfileContext, type ProfileDocumentParticipant } from '../src/index.ts'
import { documentProviderFixture } from './document-provider-fixture.ts'

function fixture(rows: unknown[] = []) {
  const home = resolve('/native/home'), dir = join(home, 'profiles', 'web'), generation = resolve('/native/g')
  const profile: ProfileContext = { name: 'web', home, dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(generation, 'profile/package.json'), cwd: home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const provider = documentProviderFixture(profile, [], {
    [join(profile.dir, 'package.json')]: '{"dsh":{"profile":{"bundles":["bundle"]}}}',
    [join(profile.dir, 'nested.yml')]: undefined,
    [join(profile.dir, 'nested.json')]: undefined,
  })
  const apply = vi.fn(), plugin = { apply }
  const modules = new Map<string, unknown>([['probe', plugin], ['@deepseek-ai/cordis-plugin-group', Group], ['@deepseek-ai/cordis-plugin-include', Include]])
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('Test requires the supported native module-loader seam')
  const importModule = vi.fn(async (name: string) => modules.get(name))
  vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue({ ...loader, import: importModule })
  const manifests = new Map<string, Record<string, unknown>>()
  const options: ProfileDocumentSemanticOptions = {
    profile,
    packages: { resolution: { profilesDir: join(profile.home, 'profiles'), profileDir: profile.dir, localPackageNames: [], entries: [], linkedRoots: [] },
      packageOf: name => modules.has(name) ? { name, version: '1.0.0', dir: join(generation, name), manifestPath: join(generation, name, 'package.json'), manifest: manifests.get(name) ?? {} } : undefined },
    bundleSources: [{ packageName: 'bundle', packageDir: join(generation, 'bundle'), manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
      patches: [{ logicalPath: join(generation, 'bundle', 'cordis.patch.yml'), text: JSON.stringify([{ insert: rows }]) }] }],
  }
  return { ...provider, profile, apply, plugin, options, modules, manifests, importModule,
    semantics: () => createProfileDocumentSemantics(options),
    write(path: string, text: string) { return { logicalPath: path, expected: provider.documents.current().read(path).reference, text } },
  }
}
const include = (config: unknown, id = 'include') => ({ id, name: 'cordis:include', config })
const group = (config: unknown) => ({ id: 'group', name: 'cordis:group', config })
afterEach(() => vi.restoreAllMocks())

it('rejects duplicate bundle inventory before any document read or candidate import', () => {
  const f = fixture()
  expect(() => createProfileDocumentSemantics({ ...f.options, bundleSources: [...f.options.bundleSources, ...f.options.bundleSources] }))
    .toThrow('duplicate package names')
  expect(f.importModule).not.toHaveBeenCalled()
})

it.each([42, ['bundle', 2], ['bundle', 'bundle']])('rejects an invalid native bundle selection %j', (bundles) => {
  const f = fixture()
  f.external({ [join(f.profile.dir, 'package.json')]: JSON.stringify({ dsh: { profile: { bundles } } }) })
  expect(() => f.semantics().bundleLayers(f.documents.current())).toThrow('Profile bundle list is invalid')
})

it('allows a profile without selected bundles and rejects packages outside the captured inventory', () => {
  const f = fixture()
  f.external({ [join(f.profile.dir, 'package.json')]: '{}' })
  expect(f.semantics().bundleLayers(f.documents.current()).layers).toEqual([])
  f.external({ [join(f.profile.dir, 'package.json')]: '{"dsh":{"profile":{"bundles":["unlisted"]}}}' })
  expect(() => f.semantics().bundleLayers(f.documents.current())).toThrow('outside the admitted code graph')
})

it.each([{}, { dsh: 2 }, { dsh: {} }, { dsh: { bundle: { patch: 2 } } }, { dsh: { bundle: { patch: [2] } } }, { dsh: { bundle: { patch: './other.yml' } } }])
('rejects native bundle metadata that cannot describe its captured patch bytes %j', (manifest) => {
  const f = fixture(), source = f.options.bundleSources[0]!
  const semantics = createProfileDocumentSemantics({ ...f.options, bundleSources: [{ ...source, manifest }] })
  expect(() => semantics.bundleLayers(f.documents.current())).toThrow(/native declaration|patch declaration|patch inventory/)
})

it('skips incompatible bundle bytes until the exact runtime exemption is present', () => {
  const f = fixture(), source = f.options.bundleSources[0]!
  const manifest = { ...source.manifest, name: 'bundle', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-test': '^9.0.0' } }
  const semantics = createProfileDocumentSemantics({ ...f.options, bundleSources: [{ ...source, manifest }] })
  expect(semantics.bundleLayers(f.documents.current()).layers).toEqual([])
  f.external({ [join(f.profile.dir, 'compatibility.json')]: JSON.stringify({ 'bundle@1.0.0': [getDshRuntimeVersion()] }) })
  expect(semantics.bundleLayers(f.documents.current()).layers).toHaveLength(1)
})

it.each(['missingIncludeWrites', 'validatePublication'] as const)('requires the native module loader for %s', async (method) => {
  const f = fixture()
  vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
  await expect(f.semantics()[method](f.documents.current(), [], [])).rejects.toThrow('admitted module loader')
})

it.each([null, {}, 'entry', [null], [{ name: 2 }], [{ name: 'probe', id: 2 }], [{ name: 'probe', group: 'yes' }]])
('rejects malformed nested entry lists %j before importing children', async (config) => {
  const f = fixture([group(config)])
  await expect(f.semantics().missingIncludeWrites(f.documents.current())).rejects.toThrow('literal plugin entry mappings')
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('literal plugin entry mappings')
  expect(f.importModule).not.toHaveBeenCalled()
})

it('traverses disabled groups but does not import disabled ordinary rows', async () => {
  const f = fixture([{ ...group([{ id: 'off', name: 'unlisted', disabled: true }, { name: 'probe', group: null }]), disabled: true, group: true }])
  expect(await f.semantics().missingIncludeWrites(f.documents.current())).toEqual([])
  await f.semantics().validatePublication(f.documents.current(), [], [])
  expect(f.importModule.mock.calls.every(([name]) => name === 'probe')).toBe(true)
  expect(f.apply).not.toHaveBeenCalled()
})

it('rejects an active module outside the admitted graph in initialization and publication', async () => {
  const f = fixture([{ id: 'unlisted', name: 'unlisted' }])
  await expect(f.semantics().missingIncludeWrites(f.documents.current())).rejects.toThrow('outside the admitted code graph')
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('outside the admitted fixed graph')
  expect(f.importModule).not.toHaveBeenCalled()
})

it.each([undefined, {}, { path: 2 }])('rejects an Include without a literal logical path %j', async (config) => {
  const f = fixture([include(config)])
  await expect(f.semantics().missingIncludeWrites(f.documents.current())).rejects.toThrow('literal logical path')
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('literal logical path')
})

it('rejects Include cycles and unsupported initialization formats', async () => {
  const f = fixture([include({ path: './nested.yml' })])
  f.external({ [join(f.profile.dir, 'nested.yml')]: JSON.stringify([include({ path: './nested.yml' })]) })
  await expect(f.semantics().missingIncludeWrites(f.documents.current())).rejects.toThrow('format or cycle')
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('Include cycle')
  const unsupported = fixture([include({ path: './nested.mjs', initial: [] })])
  await expect(unsupported.semantics().missingIncludeWrites(unsupported.documents.current())).rejects.toThrow('format or cycle')
})

it.each(['missingIncludeWrites', 'validatePublication'] as const)('rejects non-list Include patches during %s', async (method) => {
  const f = fixture([include({ path: './nested.yml', initial: [], patches: {} })])
  await expect(f.semantics()[method](f.documents.current(), [], [])).rejects.toThrow('patches must be a literal list')
})

it('deduplicates identical missing JSON Include declarations and tolerates unmatched ordinary patches', async () => {
  const config = { path: './nested.json', initial: [{ id: 'child', name: 'probe' }], patches: [{ id: 'missing', disabled: true }] }
  const f = fixture([include(config, 'first'), include(config, 'second')])
  const writes = await f.semantics().missingIncludeWrites(f.documents.current())
  expect(writes).toEqual([f.write(join(f.profile.dir, 'nested.json'), JSON.stringify(config.initial, null, 2))])
  expect(Object.isFrozen(writes)).toBe(true)
  await f.semantics().validatePublication(f.documents.current(), writes, [])
  expect(f.apply).not.toHaveBeenCalled()
})

it.each(['json', 'yml'])('reads present %s Includes without initializing them or evaluating nested expressions', async (extension) => {
  const f = fixture([include({ path: `./nested.${extension}`, patches: [{ id: 'absent', disabled: true }] })])
  const rows = [{ id: 'probe', name: 'probe', config: [{ count: { __jsExpr: 'throw new Error("not evaluated")' } }] }]
  f.external({ [join(f.profile.dir, `nested.${extension}`)]: extension === 'json' ? JSON.stringify(rows) : dump(rows) })
  expect(await f.semantics().missingIncludeWrites(f.documents.current())).toEqual([])
  await f.semantics().validatePublication(f.documents.current(), [], [])
  expect(f.apply).not.toHaveBeenCalled()
})

it('matches native package carrier aliases without treating an ordinary plugin as a tree', async () => {
  const f = fixture([{ id: 'group', name: '@deepseek-ai/cordis-plugin-group', config: [
    { id: 'include', name: '@deepseek-ai/cordis-plugin-include', config: { path: './nested.json', initial: [] } },
  ] }])
  const writes = await f.semantics().missingIncludeWrites(f.documents.current())
  expect(writes).toEqual([f.write(join(f.profile.dir, 'nested.json'), '[]')])
  await f.semantics().validatePublication(f.documents.current(), writes, [])
})

it('requires an admitted Host registration for extra builtins and uses the real registration when present', async () => {
  const f = fixture([{ id: 'probe', name: 'cordis:probe' }])
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('admitted Host registration')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.probe = f.plugin
  const semantics = createProfileDocumentSemantics({ ...f.options, context: () => ctx })
  expect(await semantics.missingIncludeWrites(f.documents.current())).toEqual([])
  await semantics.validatePublication(f.documents.current(), [], [])
  expect(f.importModule).not.toHaveBeenCalled()
  expect(f.apply).not.toHaveBeenCalled()
})

it('skips incompatible plugin imports and requires explicit admission for a custom native tree carrier', async () => {
  const f = fixture([{ id: 'probe', name: 'probe' }])
  f.manifests.set('probe', { name: 'probe', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-test': '^9.0.0' } })
  await f.semantics().validatePublication(f.documents.current(), [], [])
  expect(f.importModule).not.toHaveBeenCalled()
  f.manifests.clear()
  f.modules.set('probe', { apply: f.apply, [EntryGroup.key]: true })
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow('explicit schema admission')
  f.modules.set('probe', null)
  await expect(f.semantics().validatePublication(f.documents.current(), [], [])).rejects.toThrow()
  f.modules.set('probe', () => {})
  await f.semantics().validatePublication(f.documents.current(), [], [])
})

it('requires a real live Host for a new expression and for enabling an unchanged disabled expression', async () => {
  const f = fixture([{ id: 'probe', name: 'probe', disabled: true, config: { value: { __jsExpr: '1' } } }])
  await expect(f.semantics().validatePublication(f.documents.current(), [f.write(f.profile.patchPath, '- id: probe\n  disabled: false\n')], []))
    .rejects.toThrow('real native Host context')
  const fresh = fixture()
  await expect(fresh.semantics().validatePublication(fresh.documents.current(), [fresh.write(fresh.profile.patchPath,
    '- insert:\n    - id: added\n      name: probe\n      config: { value: !!js 1 }\n')], [])).rejects.toThrow('real native Host context')
})

it.each(['missingIncludeWrites', 'validatePublication'] as const)('bounds nested native configuration depth during %s', async (method) => {
  let rows: unknown[] = []
  for (let depth = 0; depth < 66; depth++) rows = [group(rows)]
  const f = fixture([include({ path: './nested.json' })])
  f.external({ [join(f.profile.dir, 'nested.json')]: JSON.stringify(rows) })
  await expect(f.semantics()[method](f.documents.current(), [], [])).rejects.toThrow('depth exceeds its bound')
})

it.each([['missingIncludeWrites', 100_001], ['validatePublication', 200_001]] as const)
('bounds the total visited native entry count during %s', async (method, count) => {
  const f = fixture([group(Array.from({ length: count }, (_, id) => ({ id: String(id), name: 'unlisted', disabled: true })))])
  await expect(f.semantics()[method](f.documents.current(), [], [])).rejects.toThrow('entry count exceeds its bound')
}, 30_000)

it('validates shared Home Include participants and propagates their rejection', async () => {
  const f = fixture(), path = join(f.profile.home, 'shared.yml')
  f.external({ [path]: '[]' })
  const participant: ProfileDocumentParticipant = { domainId: 'other', state: new Uint8Array([1]), homeDomainId: 'home',
    homeState: new Uint8Array([1]), runtimeEpochs: [], documents: [],
    homeDocuments: [f.documents.current().read(path)], packageOverlays: [] }
  const writes = [f.write(path, '[]')], failure = new Error('participant Config rejected')
  const validateParticipant = vi.fn(async () => { throw failure })
  const semantics = createProfileDocumentSemantics({ ...f.options, validateParticipant })
  await expect(semantics.validatePublication(f.documents.current(), writes, [participant]))
    .rejects.toBe(failure)
  expect(validateParticipant).toHaveBeenCalledExactlyOnceWith(participant, writes)
  await f.semantics().validatePublication(f.documents.current(), [f.write(f.profile.patchPath, '[]')], [participant])
})
