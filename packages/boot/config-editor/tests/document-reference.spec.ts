/** Actual ConfigEditor and Include consumers use admitted versions while original files contain poison. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Hmr from '@deepseek-ai/dsh-hmr'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { bindProfileDocuments, boot, readProfilePatchesFromView, type ProfileContext, type ProfileDocumentReceipt } from '@deepseek-ai/dsh-app-boot'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'
import ConfigEditor, { ConfigurationReconciliationError, createOfflineConfigurationEditor } from '../src/index.ts'
import { createManagedConfigurationDerivation, editManagedConfiguration, managedConfigurationLayers, refreshManagedConfiguration, reverseManagedConfiguration } from '../src/managed-editor.ts'
import { documentProviderFixture } from '../../app-boot/tests/document-provider-fixture.ts'

const aggregateFailure: unknown = expect.any(AggregateError)
const loaderFailure: unknown = expect.any(Error)

async function fixture(source: string | null = '[]\n', homePatch?: string, options: { hmr?: boolean; probe?: Record<string, unknown>; extra?: PatchOptions[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'config-editor-documents-'))
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  const profile: ProfileContext = {
    name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  const root = join(dir, 'cordis.yml')
  for (const path of [root, profile.patchPath, join(dir, 'package.json'), join(dir, 'compatibility.json')]) writeFileSync(path, 'original poison: [\n')
  const provider = documentProviderFixture(profile, [{ insert: [
    { id: 'editor', name: 'cordis:editor' }, { id: 'probe', name: 'cordis:probe', config: options.probe ?? { value: 'initial', other: 'inherited' } },
    ...options.hmr ? [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }] : [],
  ] }, ...options.extra ?? []], { [profile.patchPath]: source ?? undefined, [join(home, 'cordis.patch.yml')]: homePatch })
  const effects: string[] = []
  let duringFailure: (() => void) | undefined
  let ready: (() => void) | undefined
  const ctx = await boot('fixture', root, readProfilePatchesFromView('fixture', profile, provider.documents.current(), provider.documents.bundleLayers(provider.documents.current())), (ctx) => {
    ctx.provide('profileContext', profile)
    bindProfileDocuments(ctx, provider.documents)
    ctx.loader.builtins.editor = ConfigEditor
    if (options.hmr) {
      ctx.provide('appReady', { onReady(listener) { ready = listener; return () => { ready = undefined } } })
      ctx.loader.builtins.timer = Timer; ctx.loader.builtins.hmr = Hmr
    }
    ctx.loader.builtins.probe = {
      Config: z.object({ value: z.string().required(), other: z.string(), added: z.string() }),
      apply(ctx: Context, config: { value: string }) {
        if (config.value === 'fail') { duringFailure?.(); throw new Error('fixture activation failed') }
        effects.push(config.value)
        ctx.effect(() => () => { effects.push(`dispose:${config.value}`) })
      },
    }
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  ready?.()
  if (options.hmr) await ctx.hmr.runExclusive(async () => {})
  const entry = () => ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  return { ...provider, ctx, profile, root, entry, effects, duringFailure(callback: () => void) { duringFailure = callback } }
}

it('reads managed raw inheritance, publishes through the native writer and preserves every original after disposal', async () => {
  const f = await fixture('# retained comment\n- id: probe\n  config: { value: before, other: explicit }\n')
  expect(f.ctx.configEditor.configuration().find(row => row.entry.options.id === 'probe')).toMatchObject({
    inherited: { value: 'initial', other: 'inherited' }, override: { value: 'before', other: 'explicit' },
  })
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  expect(receipt.document).toMatchObject({ publication: 'published', verification: 'verified', durability: 'confirmed' })
  expect(f.entry().options.config).toEqual({ value: 'after', other: 'explicit' })
  expect(f.contents.get(f.profile.patchPath)).toContain('# retained comment')
  await f.ctx.fiber.dispose()
  for (const path of [f.root, f.profile.patchPath, join(f.profile.dir, 'package.json'), join(f.profile.dir, 'compatibility.json')]) {
    expect(readFileSync(path, 'utf8')).toBe('original poison: [\n')
  }
  expect(f.receipts.size).toBe(1)
})

it('derives a schema-checked candidate without publishing or applying it, retaining raw expressions and comments', async () => {
  const f = await fixture('# source comment\n- id: probe\n  config:\n    value: before\n    other: !!js "\'expression\'"\n')
  const effects = [...f.effects]
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ entry: f.entry(), change: current => ({ ...current, value: 'candidate' }) }])
  const writes = derive(f.documents.current())
  expect(writes).toHaveLength(1)
  const write = writes[0]!
  expect(write.logicalPath).toBe(f.profile.patchPath)
  if (write.state === 'absent') throw new Error('Expected a present candidate')
  expect(write.text).toContain('value: candidate')
  expect(write.text).toContain('!!js')
  expect(write.text).toContain('# source comment')
  expect(f.effects).toEqual(effects); expect(f.receipts.size).toBe(0)
  expect(f.entry().options.config).toMatchObject({ value: 'before' })
})

it('candidate owned-field reversal retains unrelated raw changes and refuses changes to the owned field', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ reverse: receipt }])
  f.external({ [f.profile.patchPath]: '- id: probe\n  name: cordis:probe\n  config: { value: after, other: inherited, added: unrelated }\n' })
  const writes = derive(f.documents.current())
  const write = writes[0]!
  if (write.state === 'absent') throw new Error('Unrelated data must retain the document')
  expect(write.text).toContain('added: unrelated')
  expect(write.text).toContain('value: initial')
  f.external({ [f.profile.patchPath]: '- id: probe\n  name: cordis:probe\n  config: { value: concurrent, other: inherited }\n' })
  expect(() => derive(f.documents.current())).toThrow('owned field changed')
  expect(f.receipts.size).toBe(1)
})

it('refuses invalid schemas and higher overlays before native publication', async () => {
  const f = await fixture()
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), () => ({ value: 42 }))).rejects.toThrow()
  expect(f.receipts.size).toBe(0)
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: { value: overlay }\n' })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), () => ({ value: 'edit' }))).rejects.toThrow('overridden')
  expect(f.receipts.size).toBe(0)
})

it('derives once and refuses native view movement during validation', async () => {
  const f = await fixture()
  let calls = 0
  f.beforePublish(() => { f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '[]\n' }) })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), (current) => { calls++; return { ...current, value: 'next' } })).rejects.toThrow('changed during validation')
  expect(calls).toBe(1)
  expect(f.receipts.size).toBe(0)
})

it('reverses only owned raw fields and retains a concurrent unrelated override', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [f.profile.patchPath]: '- id: probe\n  name: cordis:probe\n  config: { value: after, other: inherited, added: unrelated }\n' })
  const reversed = await f.ctx.configEditor.reverseEdit(receipt)
  expect(reversed.document.after).not.toBe(receipt.document.before)
  expect(f.contents.get(f.profile.patchPath)).toContain('added: unrelated')
  expect(f.contents.get(f.profile.patchPath)).toContain('value: initial')
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited', added: 'unrelated' })
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original poison: [\n')
})

it('refuses reversal when an owned field changed and keeps native history', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [f.profile.patchPath]: '- id: probe\n  name: cordis:probe\n  config: { value: concurrent, other: inherited }\n' })
  await expect(f.ctx.configEditor.reverseEdit(receipt)).rejects.toThrow('owned field changed')
  expect(f.receipts.size).toBe(1)
  expect(await f.documents.readView(receipt.document.before)).toBeDefined()
})

it('reports publication and reverse receipts when ordinary plugin activation fails', async () => {
  const f = await fixture()
  let failure: unknown
  try { await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'fail' })) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ConfigurationReconciliationError)
  expect(failure).toMatchObject({ document: { publication: 'published' }, reversal: { publication: 'published' } })
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited' })
  expect(f.receipts.size).toBe(2)
})

it('automatic reconciliation reversal preserves a concurrent unrelated edit in the same document', async () => {
  const f = await fixture()
  f.duringFailure(() => { f.external({ [f.profile.patchPath]: '# later comment\n- id: probe\n  name: cordis:probe\n  config: { value: fail, other: inherited, added: later }\n' }) })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'fail' })))
    .rejects.toBeInstanceOf(ConfigurationReconciliationError)
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited', added: 'later' })
  expect(f.contents.get(f.profile.patchPath)).toContain('# later comment')
  expect(f.receipts.size).toBe(2)
})

it('retains a late publication failure for inspection without automatically repeating or reversing it', async () => {
  const f = await fixture()
  f.lateFailure(new Error('final acknowledgement lost'))
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))).rejects.toMatchObject({ receipt: { publication: 'published' } })
  expect(f.receipts.size).toBe(1)
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited' })
})

it('retains unconfirmed durability for inspection without admitting it to the running Loader', async () => {
  const f = await fixture()
  f.unconfirmed()
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))).rejects.toMatchObject({ receipt: { durability: 'unconfirmed' } })
  expect(f.receipts.size).toBe(1)
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited' })
})

it('round trips raw !!js expressions through edit and native owned-field reversal', async () => {
  const f = await fixture('- id: probe\n  config:\n    value: before\n    other: !!js "\'expression\'"\n')
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  expect(f.entry().options.config).toEqual({ value: 'after', other: { __jsExpr: "'expression'" } })
  expect(f.contents.get(f.profile.patchPath)).toContain('!!js')
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.entry().options.config).toEqual({ value: 'before', other: { __jsExpr: "'expression'" } })
})

it('reuses the native semantic reversal offline without constructing fibers or applying plugins', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  await f.ctx.fiber.dispose()
  const effects = [...f.effects], validated: unknown[] = []
  const offline = createOfflineConfigurationEditor(f.profile, f.documents, (entry) => {
    validated.push(entry.config)
    z.object({ value: z.string().required(), other: z.string() })(entry.config as { value: string; other: string })
  })
  const declaration = offline.configuration().find(row => row.entry.options.id === 'probe')
  expect(declaration?.entry).not.toHaveProperty('fiber')
  expect(declaration?.entry.options.config).toEqual({ value: 'after', other: 'inherited' })
  const restored = await offline.reverseEdit(receipt)
  expect(restored.reconciliation).toBe('offline')
  expect(validated).toEqual([{ value: 'initial', other: 'inherited' }])
  expect(offline.configuration().find(row => row.entry.options.id === 'probe')?.entry.options.config)
    .toEqual({ value: 'initial', other: 'inherited' })
  expect(await offline.refreshDocuments()).toBe(restored.document.after)
  expect(f.effects).toEqual(effects)
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original poison: [\n')
})

it('refuses offline native validation failure before publishing a reverse document', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const offline = createOfflineConfigurationEditor(f.profile, f.documents, () => { throw new Error('native schema refuses restore') })
  await expect(offline.reverseEdit(receipt)).rejects.toThrow('native schema refuses restore')
  expect(f.receipts.size).toBe(1)
  expect(f.documents.current().reference).toBe(receipt.document.after)
})


it('serializes receipted edits, reversals and refreshes with the actual HMR queue', async () => {
  const f = await fixture('[]\n', undefined, { hmr: true })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const holding = f.ctx.hmr.runExclusive(async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  const edit = f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'queued' }))
  expect(f.receipts.size).toBe(0)
  release.resolve(undefined); await holding
  const receipt = await edit
  expect(f.entry().options.config).toMatchObject({ value: 'queued' })
  await f.ctx.configEditor.reverseEdit(receipt)
  f.external({ [f.profile.patchPath]: '- id: probe\n  config: { value: refreshed }\n' })
  expect(await f.ctx.configEditor.refreshDocuments()).toBe(f.documents.current().reference)
  expect(f.entry().options.config).toEqual({ value: 'refreshed' })
})

it('rejects native operations without a bound authority and bounds candidate batches', async () => {
  const f = await fixture()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const change = { entry: f.entry(), change: (current: Record<string, unknown>) => current }
  await expect(createManagedConfigurationDerivation(ctx, [change], () => true)).rejects.toThrow('bounded managed edit set')
  await expect(f.ctx.configEditor.createDocumentDerivation([])).rejects.toThrow('bounded managed edit set')
  await expect(f.ctx.configEditor.createDocumentDerivation(Array.from({ length: 1025 }, () => change))).rejects.toThrow('bounded managed edit set')
  await expect(editManagedConfiguration(ctx, f.entry(), () => true, current => current)).rejects.toThrow('authority is unavailable')
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  await expect(reverseManagedConfiguration(ctx, receipt)).rejects.toThrow('authority is unavailable')
  await expect(refreshManagedConfiguration(ctx)).rejects.toThrow('authority is unavailable')
})

it.each(['missing', 'mismatch', 'not-published', 'unverified', 'unconfirmed', 'no-after'] as const)(
  'rejects %s persisted receipts before reading history or publishing reversal', async (reason) => {
    const f = await fixture()
    const original = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
    let document: ProfileDocumentReceipt = original.document
    if (reason === 'missing') f.receipts.delete(document.operationId)
    else if (reason === 'mismatch') document = { ...document, before: document.after! }
    else {
      document = reason === 'not-published' ? { ...document, publication: 'not-published' }
        : reason === 'unverified' ? { ...document, verification: 'failed' }
          : reason === 'unconfirmed' ? { ...document, durability: 'unconfirmed' }
            : { ...document, after: undefined }
      f.receipts.set(document.operationId, document)
    }
    const receipt = { ...original, document }, read = vi.spyOn(f.documents, 'readView')
    onTestFinished(() => { read.mockRestore() })
    await expect(f.ctx.configEditor.reverseEdit(receipt)).rejects.toThrow('matching persisted native publication receipt')
    await expect(f.ctx.configEditor.createDocumentDerivation([{ reverse: receipt }])).rejects.toThrow('exact persisted receipt')
    expect(read).not.toHaveBeenCalled()
    expect(f.contents.get(f.profile.patchPath)).toContain('value: after')
  },
)

it('restores explicit document absence through both candidate and applied reversals', async () => {
  const f = await fixture(null)
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ reverse: receipt }])
  expect(derive(f.documents.current())).toEqual([{ logicalPath: f.profile.patchPath, expected: f.documents.current().read(f.profile.patchPath).reference, state: 'absent' }])
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.documents.current().read(f.profile.patchPath).state).toBe('absent')
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited' })
})

it('keeps a concurrently extended document when restoring an originally absent patch', async () => {
  const f = await fixture(null)
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [f.profile.patchPath]: f.contents.get(f.profile.patchPath)! + '- id: editor\n  disabled: false\n' })
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ reverse: receipt }])
  expect(derive(f.documents.current())[0]).toHaveProperty('text', '- id: editor\n  disabled: false\n')
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.contents.get(f.profile.patchPath)).toBe('- id: editor\n  disabled: false\n')
})

it('uses retained raw document history when the admitted code graph no longer admits historical views', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const readView = f.documents.readView.bind(f.documents)
  f.documents.readDocumentVersion = async (reference, path) => (await readView(reference)).read(path)
  const rejected = vi.spyOn(f.documents, 'readView').mockRejectedValue(new Error('Historical code graph is no longer admitted'))
  onTestFinished(() => { rejected.mockRestore() })
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.entry().options.config).toMatchObject({ value: 'initial' })
  expect(rejected).not.toHaveBeenCalled()
})

it('removes inherited-equivalent overrides while preserving matching row metadata and unrelated rows', async () => {
  const f = await fixture('- id: probe\n  name: cordis:probe\n  disabled: false\n  config: { value: before }\n- id: editor\n  disabled: false\n')
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), (_current, inherited) => inherited)
  expect(f.contents.get(f.profile.patchPath)).not.toContain('config:')
  expect(f.contents.get(f.profile.patchPath)).toContain('disabled: false')
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.entry().options.config).toEqual({ value: 'before' })
})

it('keeps a newly created override row when concurrent metadata still belongs to it', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [f.profile.patchPath]: f.contents.get(f.profile.patchPath)! + '  disabled: false\n' })
  await f.ctx.configEditor.reverseEdit(receipt)
  expect(f.contents.get(f.profile.patchPath)).toContain('disabled: false')
  expect(f.contents.get(f.profile.patchPath)).not.toContain('config:')
})

it('refuses reversal when an override row was added or removed after publication', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [f.profile.patchPath]: '[]\n' })
  await expect(f.ctx.configEditor.reverseEdit(receipt)).rejects.toThrow('override rows changed')
  expect(f.receipts.size).toBe(1)
})

it('refuses reverse derivation when its entry is disabled after publication', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ reverse: receipt }])
  f.external({ [f.profile.patchPath]: f.contents.get(f.profile.patchPath)! + '  disabled: true\n' })
  await f.ctx.configEditor.refreshDocuments()
  expect(() => derive(f.documents.current())).toThrow('entry changed')
  await expect(createManagedConfigurationDerivation(f.ctx, [{ reverse: receipt }], () => false)).rejects.toThrow('entry is missing or ambiguous')
})

it('refuses a candidate when the admitted bundle graph removes its entry or a higher layer overrides it', async () => {
  const f = await fixture()
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ entry: f.entry(), change: current => ({ ...current, value: 'candidate' }) }])
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: { value: home }\n' })
  expect(() => derive(f.documents.current())).toThrow('overridden by another layer')
  const layers = vi.spyOn(f.documents, 'bundleLayers').mockReturnValue({ ...f.documents.selection, layers: [] })
  onTestFinished(() => { layers.mockRestore() })
  expect(() => derive(f.documents.current())).toThrow('entry is missing or ambiguous')
  expect(f.receipts.size).toBe(0)
})

it('rejects a non-sequence raw managed patch', async () => {
  const f = await fixture()
  f.external({ [f.profile.patchPath]: '{}' })
  expect(() => managedConfigurationLayers(f.documents, f.profile.patchPath)).toThrow('YAML sequence')
})

it('retains the original publication when a concurrent owned change prevents automatic reversal', async () => {
  const f = await fixture()
  f.duringFailure(() => { f.external({ [f.profile.patchPath]: '- id: probe\n  name: cordis:probe\n  config: { value: concurrent }\n' }) })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'fail' })))
    .rejects.toMatchObject({ document: { publication: 'published' }, reversal: undefined, cause: aggregateFailure })
  expect(f.receipts.size).toBe(1)
  expect(f.contents.get(f.profile.patchPath)).toContain('value: concurrent')
})

it('retains a successful reversal publication even when its Loader application fails', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: { value: fail }\n' })
  await expect(f.ctx.configEditor.reverseEdit(receipt)).rejects.toMatchObject({
    document: { publication: 'published' }, reversal: undefined, cause: loaderFailure,
  })
  expect(f.receipts.size).toBe(2)
  expect(f.contents.get(f.profile.patchPath)).toBe('[]\n')
})

it('retains both publications when automatic reversal also fails to reconcile a later overlay', async () => {
  const f = await fixture()
  f.duringFailure(() => { f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: { value: fail }\n' }) })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'fail' })))
    .rejects.toMatchObject({ document: { publication: 'published' }, reversal: { publication: 'published' }, cause: aggregateFailure })
  expect(f.receipts.size).toBe(2)
})

it('derives and applies an empty configuration for a plugin with no declared config', async () => {
  const f = await fixture()
  const editor = f.ctx.configEditor.entries().find(entry => entry.options.id === 'editor')!
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ entry: editor, change: current => current }])
  expect(derive(f.documents.current())[0]).toHaveProperty('text', '[]\n')
  await f.ctx.configEditor.editWithReceipt(editor, current => current)
  expect(f.contents.get(f.profile.patchPath)).toBe('[]\n')
})

it('refuses publication after reconciliation deactivates the selected fiber', async () => {
  const f = await fixture()
  const entry = f.entry()
  f.external({ [f.profile.patchPath]: '- id: probe\n  disabled: true\n' })
  await expect(f.ctx.configEditor.editWithReceipt(entry, current => ({ ...current, value: 'after' })))
    .rejects.toThrow('entry or view changed before native publication')
  expect(f.receipts.size).toBe(0)
})

it('refuses publication if its native writer admits a newer view than the validated reference', async () => {
  const f = await fixture()
  const original = f.documents.withWriteSnapshot.bind(f.documents)
  const writer = vi.spyOn(f.documents, 'withWriteSnapshot').mockImplementation((request, derive) => {
    f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '[]\n' })
    return original({ ...request, expected: f.documents.current().reference }, derive)
  })
  onTestFinished(() => { writer.mockRestore() })
  await expect(f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' })))
    .rejects.toThrow('entry or view changed before native publication')
  expect(f.receipts.size).toBe(0)
})

it('refuses reversal when the admitted graph no longer contains its target', async () => {
  const f = await fixture()
  const receipt = await f.ctx.configEditor.editWithReceipt(f.entry(), current => ({ ...current, value: 'after' }))
  const layers = vi.spyOn(f.documents, 'bundleLayers').mockReturnValue({ ...f.documents.selection, layers: [] })
  onTestFinished(() => { layers.mockRestore() })
  await expect(f.ctx.configEditor.reverseEdit(receipt)).rejects.toThrow('reversal target is missing or ambiguous')
  expect(f.receipts.size).toBe(1)
})

it('rejects a candidate made ineffective by a null higher-layer config', async () => {
  const f = await fixture()
  const derive = await f.ctx.configEditor.createDocumentDerivation([{ entry: f.entry(), change: () => ({ value: 'candidate' }) }])
  f.external({ [join(f.profile.home, 'cordis.patch.yml')]: '- id: probe\n  config: null\n' })
  expect(() => derive(f.documents.current())).toThrow('overridden by another layer')
})

it('traverses group children and refuses a batch that removes an earlier edited child', async () => {
  const f = await fixture('[]\n', undefined, { extra: [{ insert: [{
    id: 'group', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'cordis:probe', config: { value: 'nested' } }],
  }] }] })
  const child = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'child')!
  const group = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'group')!
  const offline = createOfflineConfigurationEditor(f.profile, f.documents, () => {})
  expect(offline.configuration().find(row => row.entry.options.id === 'child')?.entry.options.config).toEqual({ value: 'nested' })
  const derive = await createManagedConfigurationDerivation(f.ctx, [
    { entry: child, change: current => ({ ...current, value: 'candidate' }) },
    { entry: group, change: () => ({}) },
  ], () => true)
  expect(() => derive(f.documents.current())).toThrow('configuration disappeared')
  expect(f.receipts.size).toBe(0)
})

it('resets aliased override rows through their retained anchor without replacing unrelated YAML', async () => {
  const f = await fixture('- &override\n  id: probe\n  config: { value: before }\n- *override\n')
  await f.ctx.configEditor.editWithReceipt(f.entry(), (_current, inherited) => inherited)
  expect(f.contents.get(f.profile.patchPath)).toContain('&override')
  expect(f.contents.get(f.profile.patchPath)).toContain('*override')
  expect(f.contents.get(f.profile.patchPath)).not.toContain('config:')
  expect(f.entry().options.config).toEqual({ value: 'initial', other: 'inherited' })
})


it('refuses edits whose ownership is withdrawn during reconciliation', async () => {
  const f = await fixture()
  await expect(editManagedConfiguration(f.ctx, f.entry(), () => false, current => current))
    .rejects.toThrow('entry changed during reload')
  expect(f.receipts.size).toBe(0)
})
