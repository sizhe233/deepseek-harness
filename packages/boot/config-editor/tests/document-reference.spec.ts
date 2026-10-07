/** Actual ConfigEditor and Include consumers use admitted versions while original files contain poison. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bindProfileDocuments, boot, readProfilePatchesFromView, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished } from 'vitest'
import ConfigEditor, { ConfigurationReconciliationError, createOfflineConfigurationEditor } from '../src/index.ts'
import { documentProviderFixture } from '../../app-boot/tests/document-provider-fixture.ts'

async function fixture(source = '[]\n', homePatch?: string) {
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
    { id: 'editor', name: 'cordis:editor' }, { id: 'probe', name: 'cordis:probe', config: { value: 'initial', other: 'inherited' } },
  ] }], { [profile.patchPath]: source, [join(home, 'cordis.patch.yml')]: homePatch })
  const effects: string[] = []
  let duringFailure: (() => void) | undefined
  const ctx = await boot('fixture', root, readProfilePatchesFromView('fixture', profile, provider.documents.current(), provider.documents.bundleLayers(provider.documents.current())), (ctx) => {
    ctx.provide('profileContext', profile)
    bindProfileDocuments(ctx, provider.documents)
    ctx.loader.builtins.editor = ConfigEditor
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
