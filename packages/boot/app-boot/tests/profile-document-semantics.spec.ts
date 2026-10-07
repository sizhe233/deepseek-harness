/** Post-gate semantic validation imports native Configs without mounting plugins or reopening logical sources. */
import { join } from 'node:path'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createProfileDocumentSemantics, bindProfileDocuments, boot, type ProfileContext, type ProfileDocumentParticipant } from '../src/index.ts'
import { documentProviderFixture } from './document-provider-fixture.ts'

function fixture(include = false, dynamic = false) {
  const profile: ProfileContext = { name: 'web', home: '/native/home', dir: '/native/home/profiles/web', patchPath: '/native/home/profiles/web/cordis.patch.yml',
    installAnchor: '/native/g/profile/package.json', cwd: '/native/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const nested = join(profile.dir, 'nested.yml')
  const provider = documentProviderFixture(profile, [], { [join(profile.dir, 'package.json')]: '{"dsh":{"profile":{"bundles":["bundle"]}}}',
    [nested]: '- id: child\n  name: probe\n  config: { count: 2 }\n' })
  const apply = vi.fn(), plugin = { Config: Schema.object({ count: Schema.number().min(1) }), apply }
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('Test requires the supported native module-loader seam')
  vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue({ ...loader, import: vi.fn(async () => plugin) })
  const packages = { resolution: { profilesDir: '/native/home/profiles', profileDir: profile.dir, localPackageNames: [], entries: [], linkedRoots: [] },
    packageOf: (name: string) => name === 'probe' ? { name: 'probe', version: '1.0.0', dir: '/native/g/probe', manifestPath: '/native/g/probe/package.json', manifest: {} } : undefined }
  const bundleSources = [{ packageName: 'bundle', packageDir: '/native/g/bundle', manifest: { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    patches: [{ logicalPath: '/native/g/bundle/cordis.patch.yml', text: include
      ? '- insert:\n    - id: nested\n      name: cordis:include\n      config: { path: ./nested.yml }\n'
      : '- insert:\n    - id: probe\n      name: probe\n      config: { count: ' + (dynamic ? '!!js 2' : '2') + ' }\n' }] }]
  const options = { profile, packages, bundleSources }
  return { ...provider, profile, nested, apply, plugin, options, semantics: createProfileDocumentSemantics(options) }
}
afterEach(() => vi.restoreAllMocks())
it('validates native Config literals and explicit absence without mounting any plugin', async () => {
  const f = fixture(), view = f.documents.current(), path = f.profile.patchPath
  await f.semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, text: '- id: probe\n  config: { count: 3 }\n' }], [])
  await expect(f.semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, text: '- id: probe\n  config: { count: 0 }\n' }], [])).rejects.toThrow()
  await f.semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, state: 'absent' }], [])
  expect(f.apply).not.toHaveBeenCalled()
})
it('walks native Include snapshots and refuses unlisted or removed required documents', async () => {
  const f = fixture(true), view = f.documents.current()
  await expect(f.semantics.validatePublication(view, [{ logicalPath: f.nested, expected: view.read(f.nested).reference, state: 'absent' }], [])).rejects.toThrow()
  await f.semantics.validatePublication(view, [{ logicalPath: f.nested, expected: view.read(f.nested).reference, text: '- id: child\n  name: probe\n  config: { count: 4 }\n' }], [])
  expect(f.apply).not.toHaveBeenCalled()
})
it('retains unchanged expressions and refuses changed dynamic config without a real Host context', async () => {
  const f = fixture(false, true), view = f.documents.current(), path = f.profile.patchPath
  await f.semantics.validatePublication(view, [], [])
  await expect(f.semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, text: '- id: probe\n  config: { count: !!js 3 }\n' }], [])).rejects.toThrow('real native Host context')
})
it('requires each shared Home participant validator and forwards its detached native inputs', async () => {
  const f = fixture(), view = f.documents.current(), path = join(f.profile.home, 'cordis.patch.yml')
  const participant: ProfileDocumentParticipant = { domainId: 'other', state: new Uint8Array([1]), homeDomainId: 'home',
    homeState: new Uint8Array([1]), runtimeEpochs: [], documents: [], homeDocuments: [], packageOverlays: [] }
  const writes = [{ logicalPath: path, expected: view.read(path).reference, text: '[]' }]
  await expect(f.semantics.validatePublication(view, writes, [participant])).rejects.toThrow('each participant')
  const validateParticipant = vi.fn(async () => {})
  await createProfileDocumentSemantics({ ...f.options, validateParticipant }).validatePublication(view, writes, [participant])
  expect(validateParticipant).toHaveBeenCalledWith(participant, writes)
})

it('validates changed expressions through their actual live fiber without mounting another plugin', async () => {
  const f = fixture(false, true)
  f.options.bundleSources[0]!.patches[0]!.text = f.options.bundleSources[0]!.patches[0]!.text.replace('name: probe', 'name: cordis:probe')
  let live: Context | undefined
  const semantics = createProfileDocumentSemantics({ ...f.options, context: () => live })
  const documents = { ...f.documents, bundleLayers: (view: ReturnType<typeof f.documents.current>) => semantics.bundleLayers(view) }
  const ctx = await boot('fixture', join(f.profile.dir, 'cordis.yml'), [], (context) => {
    live = context; context.provide('profileContext', f.profile); context.loader.builtins.probe = f.plugin
    bindProfileDocuments(context, documents)
  })
  onTestFinished(() => ctx.fiber.dispose())
  const mounted = f.apply.mock.calls.length, view = documents.current(), path = f.profile.patchPath
  await semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, text: '- id: probe\n  config: { count: !!js 3 }\n' }], [])
  await expect(semantics.validatePublication(view, [{ logicalPath: path, expected: view.read(path).reference, text: '- id: probe\n  config: { count: !!js 0 }\n' }], [])).rejects.toThrow()
  expect(f.apply).toHaveBeenCalledTimes(mounted)
})

it('derives absent nested Include initialization with exact references and native expression serialization', async () => {
  const f = fixture(true)
  f.options.bundleSources[0]!.patches[0]!.text = '- insert:\n    - id: nested\n      name: cordis:include\n      config:\n        path: ./nested.yml\n        initial:\n          - id: child\n            name: probe\n            config: { count: !!js 2 }\n'
  f.external({ [f.nested]: undefined })
  const semantics = createProfileDocumentSemantics(f.options), view = f.documents.current()
  const writes = await semantics.missingIncludeWrites(view)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ logicalPath: f.nested, expected: view.read(f.nested).reference })
  expect(writes[0]?.state !== 'absent' && writes[0]?.text).toContain('!!js')
  expect(view.read(f.nested).state).toBe('absent')
  await semantics.validatePublication(view, writes, [])
  expect(f.apply).not.toHaveBeenCalled()
})

it('refuses conflicting initial declarations for one absent logical Include', async () => {
  const f = fixture(true)
  f.options.bundleSources[0]!.patches[0]!.text = '- insert:\n    - id: first\n      name: cordis:include\n      config: { path: ./nested.yml, initial: [] }\n    - id: second\n      name: cordis:include\n      config: { path: ./nested.yml, initial: [{ id: child, name: probe, config: { count: 2 } }] }\n'
  f.external({ [f.nested]: undefined })
  await expect(createProfileDocumentSemantics(f.options).missingIncludeWrites(f.documents.current())).rejects.toThrow('conflicting initial')
})
