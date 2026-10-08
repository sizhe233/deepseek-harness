/** Managed Settings retains native form edits while unsafe external-file paths remain refused. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindProfileDocuments, boot, createProfileDocumentOperationId, type ProfileContext, type ProfileDocumentOperationId, type ProfileDocumentMigrationEntry, type ProfileDocumentMigrations, type ProfileDocumentDrafts, type ProfileDocumentReceipt } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'
import Settings from '../src/index.ts'
import { configurationFixture } from './configuration-fixture.ts'
import { documentProviderFixture } from '../../../boot/app-boot/tests/document-provider-fixture.ts'

async function fixture(legacy?: string) {
  const home = mkdtempSync(join(tmpdir(), 'settings-documents-')), dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  const profile: ProfileContext = { name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const root = join(dir, 'cordis.yml'), oldSettings = join(home, 'settings.yaml')
  writeFileSync(root, 'original root poison: ['); writeFileSync(profile.patchPath, 'original patch poison: [')
  if (legacy !== undefined) writeFileSync(oldSettings, legacy)
  const provider = documentProviderFixture(profile, [{ insert: [
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'probe', name: 'cordis:probe', config: { count: 2, token: 'private-secret' } },
  ] }], { [oldSettings]: legacy })
  const ctx = await boot('fixture', root, [], (ctx) => {
    ctx.provide('profileContext', profile); bindProfileDocuments(ctx, provider.documents)
    ctx.loader.builtins.editor = ConfigEditor; ctx.loader.builtins.settings = Settings
    ctx.loader.builtins.probe = {
      Config: z.object({ count: z.number().min(1).volatile(), token: z.string().role('secret').volatile() }),
      apply() {},
    }
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await vi.waitFor(() => { expect(Reflect.get(ctx.settings, 'migrationTask')).toBeUndefined() })
  return { ...provider, ctx, profile, oldSettings }
}

it('rejects external opening before the controller can pass a logical original to the native opener', async () => {
  const f = await fixture()
  const openTextFile = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  const controller = new SettingsController(f.ctx, { openTextFile })
  expect(controller.describe()).toMatchObject({ writable: true, hasDocument: false })
  expect(f.ctx.settings.documentPath).toBe(f.profile.patchPath)
  await expect(controller.openSettingsDocument(new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/internal' })
  expect(openTextFile).not.toHaveBeenCalled()
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original patch poison: [')
})

it('does not rename or import managed legacy settings without a native migration ledger', async () => {
  const original = 'probe:\n  count: 9\n'
  const f = await fixture(original)
  await Promise.resolve()
  expect(readFileSync(f.oldSettings, 'utf8')).toBe(original)
  expect(existsSync(f.oldSettings + '.imported')).toBe(false)
  expect(f.receipts.size).toBe(0)
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2 })
})

it('keeps redaction and revisioned native form edits while the external draft capability is unavailable', async () => {
  const f = await fixture()
  const before = f.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'probe')!
  expect(JSON.stringify(before)).not.toContain('private-secret')
  await f.ctx.settings.update('probe', { count: 3 }, before.revision)
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 3, token: 'private-secret' })
  await expect(f.ctx.settings.update('probe', { count: 4 }, before.revision)).rejects.toThrow('changed since')
  expect(f.receipts.size).toBe(1)
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original patch poison: [')
})

it('opens a detached draft and imports its saved bytes through native publication and ordinary reconciliation', async () => {
  const f = await fixture()
  const original = f.documents.current(), id = createProfileDocumentOperationId()
  const draft = { id, logicalPath: f.profile.patchPath, path: join(f.profile.home, 'private-draft.yml'),
    baseView: original.reference, baseDocument: original.read(f.profile.patchPath).reference, saveBehavior: 'explicit-import' as const }
  const prepare = vi.fn(async () => draft)
  Object.defineProperty(f.documents, 'drafts', { value: {
    prepare,
    inspect: async () => ({ draft, sha256: 'fixture-saved-digest' }),
    import: async (request: { operationId: ProfileDocumentOperationId }) => f.documents.withWriteSnapshot({
      operationId: request.operationId, expected: draft.baseView,
    }, () => [{
      logicalPath: draft.logicalPath, expected: draft.baseDocument, text: '- id: probe\n  config:\n    count: 8\n    token: private-secret\n',
    }]),
  } })
  const openTextFile = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  const controller = new SettingsController(f.ctx, { openTextFile })
  const result = await controller.openSettingsDocument(new AbortController().signal)
  expect(controller.describe().hasDocument).toBe(true)
  expect(result).toEqual({ opened: true, draft: { id, saveBehavior: 'explicit-import' } })
  expect(JSON.stringify(result)).not.toContain(draft.path)
  expect(openTextFile.mock.calls[0]?.[0]).toBe(draft.path)
  await controller.importSettingsDocumentDraft(id)
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 8 })
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original patch poison: [')
  await expect(controller.importSettingsDocumentDraft(id)).rejects.toMatchObject({ code: 'settings/rejected' })
})

it('records legacy section receipts and rejections once without renaming the source', async () => {
  const original = 'probe:\n  count: 9\nmissing-entry:\n  count: 4\n', f = await fixture(original)
  const ledger = new Map<string, { key: string; status: string }>()
  Object.defineProperty(f.documents, 'migrations', { value: {
    read: async () => [...ledger.values()], recover: async () => {},
    record: async (_source: unknown, entry: { key: string; status: string }) => { ledger.set(entry.key, entry) },
  } })
  const migrate = Reflect.get(f.ctx.settings, 'importLegacyDocument') as () => Promise<void>
  await migrate.call(f.ctx.settings)
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 9 })
  expect(ledger.get('probe')?.status).toBe('published')
  expect(ledger.get('missing-entry')?.status).toBe('rejected')
  const count = f.receipts.size
  await migrate.call(f.ctx.settings)
  expect(f.receipts.size).toBe(count)
  expect(readFileSync(f.oldSettings, 'utf8')).toBe(original)
  expect(existsSync(f.oldSettings + '.imported')).toBe(false)
})


type Fixture = Awaited<ReturnType<typeof fixture>>

function migrationLedger(f: Fixture) {
  const entries = new Map<string, ProfileDocumentMigrationEntry>()
  const ledger = {
    read: vi.fn<ProfileDocumentMigrations['read']>(async () => [...entries.values()]),
    recover: vi.fn<ProfileDocumentMigrations['recover']>(async () => {}),
    record: vi.fn<ProfileDocumentMigrations['record']>(async (_source, entry) => { entries.set(entry.key, entry) }),
  }
  Object.defineProperty(f.documents, 'migrations', { value: ledger })
  return { ...ledger, entries }
}

function importLegacy(f: Fixture): Promise<void> {
  const migrate = Reflect.get(f.ctx.settings, 'importLegacyDocument') as () => Promise<void>
  return migrate.call(f.ctx.settings)
}

function migrationIdentity(f: Fixture, section: string) {
  const source = { logicalPath: f.oldSettings, reference: f.documents.current().read(f.oldSettings).reference }
  const operationId = brandString<ProfileDocumentOperationId>(`settings-migration-${createHash('sha256').update(JSON.stringify([source.reference, section])).digest('hex')}`)
  return { source, operationId }
}

function retainedReceipt(f: Fixture, section: string): ProfileDocumentReceipt {
  return { operationId: migrationIdentity(f, section).operationId,
    before: f.documents.current().reference, after: f.documents.current().reference,
    publication: 'published', verification: 'verified', durability: 'confirmed' }
}

function editingDraft(f: Fixture) {
  const view = f.documents.current()
  const draft = { id: createProfileDocumentOperationId(), logicalPath: f.profile.patchPath,
    path: join(f.profile.home, 'private-copy.yml'), baseView: view.reference,
    baseDocument: view.read(f.profile.patchPath).reference, saveBehavior: 'explicit-import' as const }
  const drafts = {
    prepare: vi.fn<ProfileDocumentDrafts['prepare']>(async () => draft),
    inspect: vi.fn<ProfileDocumentDrafts['inspect']>(async () => ({ draft, sha256: 'saved-copy-digest' })),
    import: vi.fn<ProfileDocumentDrafts['import']>(async request => f.documents.withWriteSnapshot({
      operationId: request.operationId, expected: draft.baseView,
    }, () => [{ logicalPath: draft.logicalPath, expected: draft.baseDocument,
      text: '- id: probe\n  config:\n    count: 8\n    token: private-secret\n' }])),
  }
  Object.defineProperty(f.documents, 'drafts', { value: drafts })
  return { draft, drafts }
}

it.each(['', 'a'.repeat(257), 'line\nbreak', 'nul\u0000byte', 'delete\u007fbyte'])('refuses an invalid native draft identity before inspection: %j', async (id) => {
  const f = await fixture(), { drafts } = editingDraft(f)
  await expect(f.ctx.settings.importDocumentDraft(id)).rejects.toThrow('Invalid settings draft identity')
  expect(drafts.inspect).not.toHaveBeenCalled()
  expect(drafts.import).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(0)
})

it('refuses native draft import without capabilities and refuses a copy owned by another document', async () => {
  const f = await fixture()
  await expect(f.ctx.settings.importDocumentDraft('saved-copy')).rejects.toThrow('Native Settings drafts are unavailable')
  const { draft, drafts } = editingDraft(f)
  drafts.inspect.mockResolvedValue({ draft: { ...draft, logicalPath: join(f.profile.home, 'other.yml') }, sha256: 'other-copy-digest' })
  await expect(f.ctx.settings.importDocumentDraft(draft.id)).rejects.toThrow('Draft does not belong to this Settings document')
  expect(drafts.import).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(0)
})

it('reports a published draft separately from failed Loader reconciliation and retains its receipt for inspection', async () => {
  const f = await fixture(), { draft, drafts } = editingDraft(f)
  const failure = new Error('Loader refused the published copy')
  vi.spyOn(f.ctx.configEditor, 'refreshDocuments').mockRejectedValueOnce(failure)
  await expect(f.ctx.settings.importDocumentDraft(draft.id)).rejects.toMatchObject({
    message: 'Settings copy was published, but configuration reload failed; inspect the published revision before retrying',
    cause: failure, reconciliation: 'failed',
    receipt: { publication: 'published', verification: 'verified', durability: 'confirmed' },
  })
  expect(drafts.inspect).toHaveBeenCalledExactlyOnceWith(draft.id)
  expect(drafts.import).toHaveBeenCalledOnce()
  const request = drafts.import.mock.calls[0]![0]
  expect(request).toMatchObject({ draftId: draft.id, sha256: 'saved-copy-digest' })
  expect(request.operationId).not.toBe(draft.id)
  const published = f.documents.current().read(f.profile.patchPath)
  expect(published.state === 'present' && published.text).toContain('count: 8')
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2 })
  expect(f.receipts.size).toBe(1)
  await f.ctx.configEditor.refreshDocuments()
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 8 })
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('original patch poison: [')
})

it('refuses a legacy document with a non-object root without renaming or publishing it', async () => {
  const original = '- probe\n', f = await fixture(original), ledger = migrationLedger(f)
  await expect(importLegacy(f)).rejects.toThrow('Legacy Settings source must contain section objects')
  expect(ledger.read).not.toHaveBeenCalled()
  expect(ledger.record).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(0)
  expect(readFileSync(f.oldSettings, 'utf8')).toBe(original)
})

it.each(['null\n', ''])('recovers an empty legacy ledger without inventing section operations: %j', async (original) => {
  const f = await fixture(original), ledger = migrationLedger(f)
  ledger.read.mockRejectedValueOnce(new Error('interrupted acknowledgement'))
  await importLegacy(f)
  expect(ledger.read).toHaveBeenCalledTimes(2)
  expect(ledger.recover).not.toHaveBeenCalled()
  expect(ledger.record).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(0)
  expect(readFileSync(f.oldSettings, 'utf8')).toBe(original)
})

it('recovers stable section identities before reading an interrupted migration ledger again', async () => {
  const f = await fixture('probe:\n  count: 9\nmissing-entry:\n  count: 4\n'), ledger = migrationLedger(f)
  const probe = migrationIdentity(f, 'probe'), missing = migrationIdentity(f, 'missing-entry')
  ledger.entries.set('probe', { key: 'probe', operationId: probe.operationId, status: 'published', receipt: retainedReceipt(f, 'probe') })
  ledger.entries.set('missing-entry', { key: 'missing-entry', operationId: missing.operationId, status: 'rejected', reason: 'Missing entry' })
  ledger.read.mockRejectedValueOnce(new Error('interrupted acknowledgement'))
  await importLegacy(f)
  expect(ledger.recover.mock.calls).toEqual([[probe.source, probe.operationId], [missing.source, missing.operationId]])
  expect(ledger.read.mock.invocationCallOrder[1]).toBeGreaterThan(ledger.recover.mock.invocationCallOrder[1]!)
  expect(ledger.record).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(0)
  await importLegacy(f)
  expect(ledger.recover).toHaveBeenCalledTimes(2)
})

it('acknowledges an already verified native section without publishing it again', async () => {
  const f = await fixture('probe:\n  count: 9\n'), ledger = migrationLedger(f), receipt = retainedReceipt(f, 'probe')
  f.receipts.set(receipt.operationId, receipt)
  const publish = vi.spyOn(f.documents, 'withWriteSnapshot')
  await importLegacy(f)
  expect(ledger.entries.get('probe')).toEqual({ key: 'probe', operationId: receipt.operationId, status: 'published', receipt })
  expect(publish).not.toHaveBeenCalled()
  await importLegacy(f)
  expect(ledger.record).toHaveBeenCalledOnce()
  expect(publish).not.toHaveBeenCalled()
})

const uncertainFacts = [
  { publication: 'unknown' as const },
  { verification: 'failed' as const },
  { durability: 'unconfirmed' as const },
]

it.each(uncertainFacts)('fences a retained legacy section with unresolved native facts: %j', async (facts) => {
  const f = await fixture('probe:\n  count: 9\n'), ledger = migrationLedger(f)
  const receipt = { ...retainedReceipt(f, 'probe'), ...facts }
  f.receipts.set(receipt.operationId, receipt)
  const publish = vi.spyOn(f.documents, 'withWriteSnapshot')
  await expect(importLegacy(f)).rejects.toThrow('requires native operation inspection')
  expect(ledger.record).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

it('retains rejected scalar sections and non-Error failures without repeating attempted imports', async () => {
  const f = await fixture('scalar: 9\nprobe:\n  count: 9\n'), ledger = migrationLedger(f)
  const edit = vi.spyOn(f.ctx.configEditor, 'editWithReceipt').mockRejectedValueOnce('native prepublication refusal')
  await importLegacy(f)
  expect(ledger.entries.get('scalar')).toMatchObject({ status: 'rejected', reason: 'Legacy Settings section must be an object' })
  expect(ledger.entries.get('probe')).toMatchObject({ status: 'rejected', reason: 'Legacy section validation failed' })
  await importLegacy(f)
  expect(edit).toHaveBeenCalledOnce()
  expect(f.receipts.size).toBe(0)
})

it.each(uncertainFacts)('does not call a partly published section rejected after a native failure: %j', async (facts) => {
  const f = await fixture('probe:\n  count: 9\n'), ledger = migrationLedger(f)
  const publish = f.documents.withWriteSnapshot.bind(f.documents)
  vi.spyOn(f.documents, 'withWriteSnapshot').mockImplementation(async (request, derive) => {
    const publication = await publish(request, derive)
    const receipt = { ...publication.receipt, ...facts }
    f.receipts.set(request.operationId, receipt)
    return { ...publication, receipt }
  })
  await expect(importLegacy(f)).rejects.toThrow()
  expect(ledger.record).not.toHaveBeenCalled()
  expect(f.receipts.size).toBe(1)
  const published = f.documents.current().read(f.profile.patchPath)
  expect(published.state === 'present' && published.text).toContain('count: 9')
})

it('retries migration after a reported ledger failure and stops following documents when disposed', async () => {
  const f = await fixture('probe:\n  count: 9\n'), ledger = migrationLedger(f)
  let failRead!: (reason: Error) => void
  ledger.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject }))
  const failure = new Error('ledger temporarily inaccessible')
  ledger.recover.mockRejectedValueOnce(failure)
  f.notify()
  await vi.waitFor(() => { expect(ledger.read).toHaveBeenCalledOnce() })
  f.notify()
  f.ctx.emit('app-boot/config-reload')
  expect(ledger.read).toHaveBeenCalledOnce()
  failRead(failure)
  await vi.waitFor(() => { expect(f.ctx.logger.buffer.some(row => row.type === 'error' && row.args[0] === failure)).toBe(true) })
  await vi.waitFor(() => { expect(Reflect.get(f.ctx.settings, 'migrationTask')).toBeUndefined() })
  f.notify()
  await vi.waitFor(() => { expect(ledger.entries.get('probe')?.status).toBe('published') })
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 9 })
  await f.ctx.fiber.dispose()
  const calls = ledger.read.mock.calls.length
  f.notify()
  await Promise.resolve()
  expect(ledger.read).toHaveBeenCalledTimes(calls)
  expect(f.listeners.size).toBe(0)
})


it('returns the ordinary profile document directly and does not advertise an unknown native copy', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  expect(ctx.settings.canPrepareDocument).toBe(true)
  expect(await ctx.settings.prepareDocument()).toBe(profile.patchPath)
  expect(ctx.settings.preparedDocumentDraft(profile.patchPath)).toBeUndefined()
})

it('reports Loader settlement failure without dropping live settings or leaking a rejected startup task', async () => {
  const f = await fixture()
  const entry = f.ctx.configEditor.entries().find(row => row.options.id === 'settings')!
  await entry.update({ disabled: true })
  const failure = new Error('Loader settlement failed')
  vi.spyOn(f.ctx.loader, 'await').mockRejectedValueOnce(failure)
  await entry.update({ disabled: false })
  await vi.waitFor(() => { expect(f.ctx.logger.buffer.some(row => row.type === 'error' && row.args[0] === failure)).toBe(true) })
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 2 })
  await f.ctx.settings.update('probe', { count: 4 })
  expect(f.ctx.settings.describe().find(row => row.ns === 'probe')?.value).toMatchObject({ count: 4 })
})
