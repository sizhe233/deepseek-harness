/** Immutable document reads and native patch semantics without filesystem fallback. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  acquireProfileDocumentView, createProfileDocumentView,
  type ProfileDocumentReadCapability, type ProfileDocumentSelection,
  type ProfileDocumentSnapshot, type ProfileDocumentViewInput,
  type ProfileCodeBindingReference, type ProfilePackageDocumentsReference,
  type ProfileDocumentReference, type ProfileDocumentViewReference,
} from '../src/profile-document-view.ts'
import { readProfilePatches, readProfilePatchesFromView, type ProfileContext, type ProfileDocumentLayers } from '../src/profile-context.ts'
import { composeEntries } from '../src/profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-documents-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  const context: ProfileContext = {
    name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'installation', 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const selection: ProfileDocumentSelection = {
    profileDir: dir, home, codeBinding: brandString<ProfileCodeBindingReference>('code-a'), packageDocuments: brandString<ProfilePackageDocumentsReference>('packages-a'),
  }
  const document = (logicalPath: string, text?: string): ProfileDocumentSnapshot => ({
    logicalPath, reference: brandString<ProfileDocumentReference>(`version:${logicalPath}`),
    ...text === undefined ? { state: 'absent' as const } : { state: 'present' as const, text },
  })
  const input = (profile?: string, homePatch?: string): ProfileDocumentViewInput => ({
    reference: brandString<ProfileDocumentViewReference>('view-a'), selection,
    documents: [document(context.patchPath, profile), document(join(home, 'cordis.patch.yml'), homePatch)],
  })
  const bundles: ProfileDocumentLayers = {
    codeBinding: selection.codeBinding, packageDocuments: selection.packageDocuments,
    layers: [{ packageName: 'fixture-bundle', packageDir: home, patchPaths: [], patches: [
      { insert: [{ id: 'example', name: 'fixture-plugin', config: { source: 'bundle' } }] },
    ] }],
  }
  return { context, selection, document, input, bundles }
}

describe('document view ownership', () => {
  it('detaches provider arrays, records and selection while retaining held views', () => {
    const { input, context } = fixture()
    const provider = input('- id: example\n  disabled: true\n')
    const view = createProfileDocumentView(provider)
    Object.assign(provider.selection, { home: 'changed' })
    Object.assign(provider.documents[0]!, { text: 'changed' })
    Object.assign(provider, { reference: 'changed', documents: [] })
    expect(view.reference).toBe('view-a')
    expect(view.selection.home).toBe(context.home)
    expect(view.read(context.patchPath)).toMatchObject({ state: 'present', text: '- id: example\n  disabled: true\n' })
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.selection)).toBe(true)
    expect(Object.isFrozen(view.read(context.patchPath))).toBe(true)
  })

  it('distinguishes absent documents from paths outside the read set', () => {
    const { input, context } = fixture()
    const view = createProfileDocumentView(input())
    expect(view.read(context.patchPath).state).toBe('absent')
    expect(() => view.read(join(context.dir, 'unlisted.yml'))).toThrow('outside the admitted view')
  })

  it('rejects duplicate, relative and noncanonical logical filenames', () => {
    const { input, document, context } = fixture()
    const base = input()
    expect(() => createProfileDocumentView({ ...base, documents: [...base.documents, base.documents[0]!] })).toThrow('Duplicate')
    for (const path of ['relative.yml', `${context.dir}/../cordis.patch.yml`]) {
      expect(() => createProfileDocumentView({ ...base, documents: [document(path)] })).toThrow('not canonical')
    }
  })

  it('requires an explicit capability and propagates native admission failures', async () => {
    const { selection } = fixture()
    await expect(acquireProfileDocumentView(undefined, selection)).rejects.toThrow('admitted native read capability')
    const failure = new Error('unfinalized native operation')
    await expect(acquireProfileDocumentView({ readCurrent: async () => { throw failure } }, selection)).rejects.toBe(failure)
  })

  it('captures the request before awaiting its native read', async () => {
    const { selection, input } = fixture()
    let finish: ((input: ProfileDocumentViewInput) => void) | undefined
    let request: ProfileDocumentSelection | undefined
    const capability: ProfileDocumentReadCapability = {
      readCurrent: (value) => { request = value; return new Promise((resolve) => { finish = resolve }) },
    }
    const original = { ...selection }
    const result = acquireProfileDocumentView(capability, selection)
    Object.assign(selection, { home: 'changed' })
    expect(request).toEqual(original)
    expect(Object.isFrozen(request)).toBe(true)
    finish!({ ...input(), selection: original })
    expect((await result).selection).toEqual(original)
  })

  it.each(['profileDir', 'home', 'codeBinding', 'packageDocuments'] as const)('refuses a native read for another %s', async (field) => {
    const { selection, input } = fixture()
    const wrong = { ...selection, [field]: `${selection[field]}-other` }
    await expect(acquireProfileDocumentView({ readCurrent: async () => ({ ...input(), selection: wrong }) }, selection))
      .rejects.toThrow('does not match')
  })
})

describe('Profile composition from admitted snapshots', () => {
  it('preserves legacy absent-file and initial-Profile behavior', () => {
    const { context } = fixture()
    writeFileSync(join(context.dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    expect(readProfilePatches('test', context)).toEqual([])
    writeFileSync(context.patchPath, 'broken: [')
    const patches = [{ id: 'example', disabled: true }]
    expect(readProfilePatches('test', context, {
      name: context.name, dir: context.dir, layers: [], patchPath: context.patchPath, patches, skippedBundles: [],
    })).toEqual(patches)
  })

  it('uses bundle, profile, Home and invocation order without reading original files', () => {
    const { context, input, bundles } = fixture()
    writeFileSync(context.patchPath, 'broken: [original')
    writeFileSync(join(context.home, 'cordis.patch.yml'), 'also broken: [')
    const before = readFileSync(context.patchPath)
    const view = createProfileDocumentView(input('- id: example\n  config: { source: profile }', '- id: example\n  config: { source: home }'))
    const fromHome = composeEntries([readProfilePatchesFromView('test', context, view, bundles)])
    expect(fromHome[0]?.config).toEqual({ source: 'home' })
    const fromOverlay = composeEntries([readProfilePatchesFromView('test', {
      ...context, overlays: [{ id: 'example', config: { source: 'invocation' } }],
    }, view, bundles)])
    expect(fromOverlay[0]?.config).toEqual({ source: 'invocation' })
    expect(readFileSync(context.patchPath)).toEqual(before)
    expect(bundles.layers[0]?.patches[0]?.insert?.[0]?.config).toEqual({ source: 'bundle' })
  })

  it('requires recorded absence even when an omitted source file exists', () => {
    const { context, input, bundles } = fixture()
    writeFileSync(context.patchPath, '- id: example\n  disabled: true')
    expect(composeEntries([readProfilePatchesFromView('test', context, createProfileDocumentView(input()), bundles)])[0]?.disabled)
      .not.toBe(true)
    expect(() => readProfilePatchesFromView('test', context, createProfileDocumentView({ ...input(), documents: [] }), bundles))
      .toThrow('outside the admitted view')
  })

  it('rejects a missing Home snapshot instead of reopening that source', () => {
    const { context, input, bundles } = fixture()
    const base = input('[]')
    expect(() => readProfilePatchesFromView('test', context,
      createProfileDocumentView({ ...base, documents: [base.documents[0]!] }), bundles)).toThrow('outside the admitted view')
  })

  it('resolves inserted relative plugin paths beside their logical document', () => {
    const { context, input, bundles } = fixture()
    const view = createProfileDocumentView(input('- insert:\n  - id: relative\n    name: ./plugin.js\n    config: { value: !!js process.env.EXAMPLE }'))
    const rows = composeEntries([readProfilePatchesFromView('test', context, view, bundles)])
    expect(rows.find(row => row.id === 'relative')?.name).toBe(pathToFileURL(resolve(context.dir, 'plugin.js')).href)
    expect(rows.find(row => row.id === 'relative')?.config).toEqual({ value: { __jsExpr: 'process.env.EXAMPLE' } })
  })

  it.each(['broken: [', '{}', '[null]', '[[]]'])('refuses malformed present text %s with its logical filename', (text) => {
    const { context, input, bundles } = fixture()
    expect(() => readProfilePatchesFromView('test', context, createProfileDocumentView(input(text)), bundles))
      .toThrow(context.patchPath)
  })

  it('refuses an alternate admitted document as the logical Profile patch', () => {
    const { context, input, bundles } = fixture()
    expect(() => readProfilePatchesFromView('test', { ...context, patchPath: join(context.home, 'cordis.patch.yml') },
      createProfileDocumentView(input()), bundles)).toThrow('does not match its logical Profile directory')
  })

  it('returns detached patches without mutating bundle or invocation inputs', () => {
    const { context, input, bundles } = fixture()
    const overlays = [{ id: 'example', config: { source: 'invocation' } }]
    const result = readProfilePatchesFromView('test', { ...context, overlays }, createProfileDocumentView(input()), bundles)
    Object.assign(result[0]!.insert![0]!.config, { source: 'changed' })
    Object.assign(result.at(-1)!.config, { source: 'changed' })
    expect(bundles.layers[0]!.patches[0]!.insert![0]!.config).toEqual({ source: 'bundle' })
    expect(overlays[0]!.config).toEqual({ source: 'invocation' })
  })

  it('retains native legacy MCP projection without changing captured text', () => {
    const { context, input, bundles } = fixture()
    const text = '- insert:\n  - id: control\n    name: "@deepseek-ai/dsh-mcp-client"\n    config: { mode: configuration, retained: yes }'
    const view = createProfileDocumentView(input(text))
    const rows = composeEntries([readProfilePatchesFromView('test', context, view, bundles)])
    expect(rows.find(row => row.id === 'control')).toMatchObject({
      name: '@deepseek-ai/dsh-mcp-client/configuration', config: { retained: 'yes' },
    })
    expect(view.read(context.patchPath)).toMatchObject({ text })
  })

  it('retains telemetry privacy projection after all ordinary patches', () => {
    const { context, input, bundles } = fixture()
    const view = createProfileDocumentView(input('- insert:\n  - id: session-telemetry-otel\n    name: fixture-telemetry'))
    const rows = composeEntries([readProfilePatchesFromView('test', {
      ...context, telemetryDisabledEnv: '0', overlays: [{ id: 'session-telemetry-otel', disabled: false }],
    }, view, bundles)])
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBe(true)
  })

  it.each(['profileDir', 'home', 'codeBinding', 'packageDocuments'] as const)('rejects composition with mismatched %s', (field) => {
    const { context, input, bundles, selection } = fixture()
    const view = createProfileDocumentView({ ...input(), selection: { ...selection, [field]: `${selection[field]}-other` } })
    expect(() => readProfilePatchesFromView('test', context, view, bundles)).toThrow('does not match')
  })
})
