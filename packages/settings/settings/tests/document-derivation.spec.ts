/** Managed candidates use the real Settings and ConfigEditor owners before native publication. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { bindProfileDocuments, boot, createProfileDocumentOperationId, readProfilePatchesFromView,
  type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'
import Settings, { type SettingsDocumentChange } from '../src/index.ts'
import { documentProviderFixture } from '../../../boot/app-boot/tests/document-provider-fixture.ts'
import { configurationFixture } from './configuration-fixture.ts'

async function fixture(options: { source?: string; extra?: PatchOptions[]; schema?: z } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'settings-derive-')), dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const profile: ProfileContext = { name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const root = join(dir, 'cordis.yml')
  for (const path of [root, profile.patchPath]) writeFileSync(path, 'original poison: [')
  const provider = documentProviderFixture(profile, [{ insert: [
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'probe', name: 'cordis:probe', config: { ordinary: 'fixed', count: 2, token: 'secret' } },
    { id: 'other', name: 'cordis:probe', config: { ordinary: 'other', count: 4 } },
  ] }, ...options.extra ?? []], { [profile.patchPath]: options.source ?? '[]\n' })
  const schema = options.schema ?? z.object({ ordinary: z.string().required(), count: z.number().min(0).default(2).volatile(),
    token: z.string().role('secret').volatile(), value: z.any().volatile(), added: z.string().volatile(),
    nested: z.object({ ordinary: z.string(), live: z.number().volatile() }) })
  const ctx = await boot('fixture', root, readProfilePatchesFromView('fixture', profile, provider.documents.current(), provider.documents.bundleLayers(provider.documents.current())), (ctx) => {
    ctx.provide('profileContext', profile); bindProfileDocuments(ctx, provider.documents)
    ctx.loader.builtins.editor = ConfigEditor; ctx.loader.builtins.settings = Settings
    ctx.loader.builtins.probe = { Config: schema, apply() {} }
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await vi.waitFor(() => { expect(Reflect.get(ctx.settings, 'migrationTask')).toBeUndefined() })
  const revision = (ns = 'probe') => ctx.settings.describe().find(row => row.ns === ns)!.revision
  const change = (value: object, op: 'update' | 'replace' | 'import' = 'update'): SettingsDocumentChange => ({ ns: 'probe', expectedRevision: revision(), op, value })
  const publish = async (changes: readonly SettingsDocumentChange[]) => {
    const expected = provider.documents.current().reference
    const derive = await ctx.settings.createDocumentDerivation(changes, expected)
    const result = await provider.documents.withWriteSnapshot({ operationId: createProfileDocumentOperationId(), expected }, derive)
    await ctx.configEditor.refreshDocuments()
    return result
  }
  return { ...provider, ctx, profile, root, revision, change, publish }
}

it('derives a detached multi-entry candidate and leaves publication and Loader application to their owners', async () => {
  const f = await fixture({ source: '# retained comment\n- id: probe\n  config:\n    ordinary: !!js "\'fixed\'"\n    count: 2\n    token: secret\n' })
  const value = { count: 6 }, changes: SettingsDocumentChange[] = [f.change(value), { ns: 'other', expectedRevision: f.revision('other'), op: 'update', value: { count: 8 } }]
  const before = f.documents.current(), derive = await f.ctx.settings.createDocumentDerivation(changes, before.reference)
  value.count = 99
  Object.assign(changes[0]!, { ns: 'other', op: 'replace', expectedRevision: -1 }); changes.length = 0
  expect(f.receipts.size).toBe(0)
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2, token: 'secret' })
  const result = await f.documents.withWriteSnapshot({
    operationId: createProfileDocumentOperationId(), expected: before.reference,
  }, derive)
  expect(result.receipt).toMatchObject({ publication: 'published', verification: 'verified', durability: 'confirmed' })
  expect(f.contents.get(f.profile.patchPath)).toContain('# retained comment')
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js')
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2 })
  await f.ctx.configEditor.refreshDocuments()
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 6, token: 'secret' })
  expect(f.ctx.settings.describe().find(row => row.ns === 'other')?.value).toMatchObject({ count: 8 })
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original poison: [')
  expect(() => derive(before)).toThrow('already been used')
})

it('retains existing mutation and replacement rules in a managed candidate', async () => {
  const f = await fixture()
  await f.publish([f.change({ count: 7, value: ['one', 'two'], added: 'temporary' })])
  const ops = [{ op: 'unset' as const, path: ['value', '0'] }, { op: 'unset' as const, path: ['count'] }]
  const before = f.documents.current(), derive = await f.ctx.settings.createDocumentDerivation([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops }], before.reference)
  ops[0]!.path[1] = '1'
  await f.documents.withWriteSnapshot({ operationId: createProfileDocumentOperationId(), expected: before.reference }, derive)
  await f.ctx.configEditor.refreshDocuments()
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2, value: ['two'], token: 'secret' })
  await f.publish([f.change({ count: 3 }, 'replace')])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 3, token: 'secret', nested: {} })
  expect(f.ctx.configEditor.entries().find(row => row.options.id === 'probe')?.options.config).toMatchObject({ ordinary: 'fixed' })
})

it.each([false, 0, '', [], ['second', 'first'], null, { child: false }, {}].map(value => ({ value })))('imports absent fields while preserving explicit Profile data $value', async ({ value }) => {
  const f = await fixture({ source: JSON.stringify([{ id: 'probe', config: { ordinary: 'fixed', count: 2, value, token: '' } }]) })
  await f.publish([f.change({ count: 9, token: 'legacy-secret', value: { child: true, sibling: 'legacy' }, added: 'imported' }, 'import')])
  const next = f.ctx.settings.describe().find(row => row.ns === 'probe')!.value
  const expectedValue = value !== null && typeof value === 'object' && !Array.isArray(value) ? { child: true, sibling: 'legacy', ...value } : value
  expect(next).toEqual({ count: 2, token: '', value: expectedValue, added: 'imported', nested: {} })
  expect(f.receipts.size).toBe(1)
})

it('keeps explicit default-valued overrides even when the whole import result equals the inherited config', async () => {
  const source = '- id: probe\n  config: { ordinary: fixed, count: 2, token: secret }\n'
  const f = await fixture({ source })
  await f.publish([f.change({ count: 9 }, 'import')])
  expect(f.ctx.configEditor.configuration().find(row => row.entry.options.id === 'probe')?.override).toEqual({ ordinary: 'fixed', count: 2, token: 'secret' })
  expect(f.contents.get(f.profile.patchPath)).toContain('count: 2')
})

it('reads explicit overrides from the supplied snapshot, including entries inserted by the Profile', async () => {
  const f = await fixture({ source: '- insert:\n    - id: inserted\n      name: cordis:probe\n      config: { ordinary: fixed, count: 0 }\n- id: other\n  disabled: false\n' })
  await f.publish([{ ns: 'inserted', expectedRevision: f.revision('inserted'), op: 'import', value: { count: 9, added: 'imported' } }, f.change({ count: 7 }, 'import')])
  expect(f.ctx.settings.describe().find(row => row.ns === 'inserted')?.value).toEqual({ count: 0, added: 'imported', nested: {} })
  expect(f.contents.get(f.profile.patchPath)).toContain('disabled: false')
})

it('lets legacy values replace inherited values only when the Profile does not own those fields', async () => {
  const f = await fixture()
  await f.publish([f.change({ count: 9, token: 'legacy' }, 'import')])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 9, token: 'legacy', nested: {} })
})

it('rejects duplicate targets and requires managed authority without changing ordinary writes', async () => {
  const f = await fixture(), change = f.change({ count: 7 })
  await expect(f.ctx.settings.createDocumentDerivation([change, change], f.documents.current().reference)).rejects.toThrow('Duplicate Settings namespace')
  await expect(f.ctx.settings.createDocumentDerivation([], f.documents.current().reference)).rejects.toThrow('bounded managed edit set')
  const ordinary = await configurationFixture({ hmr: false })
  await expect(ordinary.ctx.settings.createDocumentDerivation([], f.documents.current().reference)).rejects.toThrow('requires native Profile documents')
  await ordinary.ctx.settings.update('first', { count: 8 })
  expect(ordinary.ctx.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ count: 8 })
  expect(f.receipts.size).toBe(0)
})

it.each([{ ordinary: 'changed' }, { unknown: true }, { nested: { ordinary: 'changed' } }, { count: -1 }])('refuses invalid candidate fields before publication: %j', async (value) => {
  const f = await fixture()
  await expect(f.publish([f.change(value)])).rejects.toThrow()
  expect(f.receipts.size).toBe(0)
  expect(f.contents.get(f.profile.patchPath)).toBe('[]\n')
})

it('refuses ordinary paths, non-JSON input and targets that expose no form', async () => {
  const f = await fixture(), expected = f.documents.current().reference
  await expect(f.ctx.settings.createDocumentDerivation([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops: [{ op: 'unset', path: ['ordinary'] }] }], expected)).rejects.toThrow('not volatile')
  await expect(f.ctx.settings.createDocumentDerivation([f.change({ value: new Date() })], expected)).rejects.toThrow('Config')
  await expect(f.ctx.settings.createDocumentDerivation([{ ns: 'missing', expectedRevision: 0, op: 'update', value: {} }], expected)).rejects.toThrow('No configurable')
  expect(f.receipts.size).toBe(0)
})

it('refuses stale view references even if a caller supplies a retained old view', async () => {
  const f = await fixture(), before = f.documents.current(), change = f.change({ count: 7 })
  const oldView = await f.ctx.settings.createDocumentDerivation([change], before.reference)
  const changedView = await f.ctx.settings.createDocumentDerivation([change], before.reference)
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '[]\n' })
  expect(() => oldView(before)).toThrow('view changed')
  expect(() => changedView(f.documents.current())).toThrow('view changed')
  expect(f.receipts.size).toBe(0)
})

it('rechecks the entry revision and real fiber identity when deriving under the native lease', async () => {
  const f = await fixture(), before = f.documents.current(), old = f.change({ count: 7 })
  const stale = await f.ctx.settings.createDocumentDerivation([old], before.reference)
  const entry = f.ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  await entry.update({ config: { ...(entry.options.config as Record<string, unknown>), count: 4 } })
  await expect(f.documents.withWriteSnapshot({ operationId: createProfileDocumentOperationId(), expected: before.reference }, stale)).rejects.toThrow('changed since it was read')
  const replaced = await f.ctx.settings.createDocumentDerivation([f.change({ count: 8 })], before.reference)
  await entry.update({ disabled: true })
  await entry.update({ disabled: false })
  expect(() => replaced(before)).toThrow('entry changed')
  expect(f.receipts.size).toBe(0)
})

it('refuses a higher-layer override and native view movement during validation', async () => {
  const f = await fixture()
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: { ordinary: fixed, count: 4 }\n' })
  await f.ctx.configEditor.refreshDocuments()
  await expect(f.publish([f.change({ count: 7 })])).rejects.toThrow('overridden')
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: undefined })
  await f.ctx.configEditor.refreshDocuments()
  f.beforePublish(() => { f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '[]\n' }) })
  await expect(f.publish([f.change({ count: 7 })])).rejects.toThrow('changed during validation')
  expect(f.receipts.size).toBe(0)
})

it.each(['update', 'replace', 'import'] as const)('refuses submitted expression markers in %s values', async (op) => {
  const f = await fixture()
  for (const value of [{ __jsExpr: '42' }, { __jsExpr: '42', sibling: true }, { nested: [{ __jsExpr: '42' }] }]) {
    await expect(f.publish([f.change({ value }, op)])).rejects.toThrow('expression')
  }
  expect(f.receipts.size).toBe(0)
})

it('preserves explicit nested values introduced by a Profile group replacement', async () => {
  const f = await fixture({ extra: [{ insert: [{ id: 'group', name: 'cordis:group', group: true,
    config: [{ id: 'nested', name: 'cordis:probe', config: { ordinary: 'bundle', count: 3 } }] }] }],
  source: '- id: group\n  config:\n    - id: nested\n      name: cordis:probe\n      config: { ordinary: explicit, count: 0 }\n' })
  await f.publish([{ ns: 'nested', expectedRevision: f.revision('nested'), op: 'import', value: { count: 9 } }])
  expect(f.ctx.settings.describe().find(row => row.ns === 'nested')?.value).toEqual({ count: 0, nested: {} })
  expect(f.ctx.configEditor.entries().find(row => row.options.id === 'nested')?.options.config).toMatchObject({ ordinary: 'explicit' })
})

it('preserves ordinary expression writes and copied raw expressions in a data-only candidate', async () => {
  const f = await fixture()
  await f.ctx.settings.update('probe', { value: { __jsExpr: '42' } })
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: 42 })
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js')
  await f.publish([f.change({ count: 7 })])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 7, value: 42 })
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js')
})

it('rejects expression markers in every submitted mutation value', async () => {
  const f = await fixture()
  await expect(f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate',
    ops: [{ op: 'set', path: ['value'], value: [{ __jsExpr: '42' }] }] }])).rejects.toThrow('expression')
  expect(f.receipts.size).toBe(0)
})

it('refuses targets inserted only by a higher layer instead of inventing Profile ownership', async () => {
  const f = await fixture()
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- insert:\n    - id: home-only\n      name: cordis:probe\n      config: { ordinary: fixed, count: 2 }\n' })
  await f.ctx.configEditor.refreshDocuments()
  await expect(f.publish([{ ns: 'home-only', expectedRevision: f.revision('home-only'), op: 'import', value: { count: 7 } }])).rejects.toThrow('Profile entry is missing')
  expect(f.receipts.size).toBe(0)
})

it('imports into a null Profile config through the owning schema defaults', async () => {
  const f = await fixture({ source: '- id: probe\n  config: null\n', schema: z.object({ value: z.any().volatile() }) })
  await f.publish([f.change({ value: false }, 'import')])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ value: false })
})

it.each([
  [{ op: 'set' as const, path: ['value', '__jsExpr'], value: '42' }],
  [{ op: 'set' as const, path: ['value', 'nested', '__jsExpr'], value: '42' }],
  [{ op: 'set' as const, path: ['value'], value: {} }, { op: 'set' as const, path: ['value', '__jsExpr'], value: '42' }],
  [{ op: 'set' as const, path: ['value'], value: [{}] }, { op: 'set' as const, path: ['value', '0', '__jsExpr'], value: '42' }],
].map(ops => ({ ops })))('refuses expression markers assembled by mutation paths: $ops', async ({ ops }) => {
  const f = await fixture()
  await expect(f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops }])).rejects.toThrow('expression')
  expect(f.receipts.size).toBe(0)
  expect(f.contents.get(f.profile.patchPath)).toBe('[]\n')
})

it.each([
  { op: 'set' as const, path: ['value', '__jsExpr'], value: '43' },
  { op: 'set' as const, path: ['value', 'sibling'], value: true },
  { op: 'unset' as const, path: ['value', 'sibling'] },
  { op: 'unset' as const, path: ['value', '__jsExpr'] },
])('refuses mutation traversal through a retained raw expression: %j', async (op) => {
  const f = await fixture({ source: '- id: probe\n  config: { ordinary: fixed, value: !!js 42 }\n' })
  const before = f.contents.get(f.profile.patchPath)
  await expect(f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops: [op] }])).rejects.toThrow('expression')
  expect(f.receipts.size).toBe(0)
  expect(f.contents.get(f.profile.patchPath)).toBe(before)
})

it('refuses converting an existing expression object by deleting its sibling fields', async () => {
  const f = await fixture({ source: '- id: probe\n  config: { ordinary: fixed, value: { __jsExpr: "42", sibling: true } }\n' })
  const before = f.contents.get(f.profile.patchPath)
  await expect(f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate',
    ops: [{ op: 'unset', path: ['value', 'sibling'] }] }])).rejects.toThrow('expression')
  expect(f.receipts.size).toBe(0)
  expect(f.contents.get(f.profile.patchPath)).toBe(before)
})

it('preserves whole raw expressions through array removals and rejects traversal into array expressions', async () => {
  const f = await fixture({ source: '- id: probe\n  config: { ordinary: fixed, value: [literal, !!js 42] }\n' })
  await f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops: [{ op: 'unset', path: ['value', '0'] }] }])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: [42] })
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js')
  const before = f.contents.get(f.profile.patchPath)
  for (const path of [['value', '0', '__jsExpr'], ['value', '0', 'sibling']]) {
    await expect(f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate',
      ops: [{ op: 'set', path, value: '43' }] }])).rejects.toThrow('expression')
  }
  expect(f.receipts.size).toBe(1)
  expect(f.contents.get(f.profile.patchPath)).toBe(before)
  await f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops: [{ op: 'set', path: ['value', '0'], value: false }] }])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: [false] })
})

it('restores an inherited raw expression as a whole and retains ordinary mutation behavior', async () => {
  const f = await fixture({ extra: [{ id: 'probe', config: { ordinary: 'fixed', count: 2, value: { __jsExpr: '42' } } }],
    source: '- id: probe\n  config: { ordinary: fixed, count: 2, value: false }\n' })
  await f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate', ops: [{ op: 'unset', path: ['value'] }] }])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: 42 })
  await f.ctx.settings.mutate('probe', [{ op: 'set', path: ['value', '__jsExpr'], value: '43' }])
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: 43 })
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js 43')
})

it('allows data-only edits to replace primitive and null values without expression traversal', async () => {
  const f = await fixture()
  for (const value of [null, false]) {
    await f.publish([f.change({ value })])
    await f.publish([{ ns: 'probe', expectedRevision: f.revision(), op: 'mutate',
      ops: [{ op: 'set', path: ['value', 'child'], value: 'ordinary-data' }] }])
    expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ value: { child: 'ordinary-data' } })
  }
})
