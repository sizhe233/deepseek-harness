/** Managed Settings retains native form edits while unsafe external-file paths remain refused. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindProfileDocuments, boot, createProfileDocumentOperationId, type ProfileContext, type ProfileDocumentOperationId } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'
import Settings from '../src/index.ts'
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
