import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsDocumentStore } from '../src/client/settings-document-store.ts'

/** Store over a real mirror derived from the same scripted context. */
function derivedDocumentStore(remote: object) {
  const ctx = { remote } as never
  return new SettingsDocumentStore(ctx, new SettingsDescribeMirror(ctx))
}

function response(hasDocument = false) {
  return { ok: true, value: { writable: true, hasDocument, namespaces: [] } }
}

function opened(): RemoteResult<{ opened: true }> {
  return { ok: true, value: { opened: true } }
}

function describeFailed(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
}

describe('SettingsDocumentStore', () => {
  it('loads provider metadata and asks the settings domain to open its document', async () => {
    const describe = vi.fn(() => Promise.resolve(response(true)))
    const openDocument = vi.fn(() => Promise.resolve(opened()))
    const controller = derivedDocumentStore({ settings: { describe, openSettingsDocument: openDocument } })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'ready', opening: false, error: null,
    })
    await controller.open()
    expect(openDocument).toHaveBeenCalledWith()
  })

  it('marks absent or failed metadata unavailable without opening anything', async () => {
    const openDocument = vi.fn(() => Promise.resolve(opened()))
    const absent = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response()), openSettingsDocument: openDocument },
    })
    await absent.load()
    await absent.open()
    expect(absent.store.getSnapshot().status).toBe('unavailable')
    expect(openDocument).not.toHaveBeenCalled()

    const failed = derivedDocumentStore({
      settings: { describe: () => Promise.reject(new Error('offline')), openSettingsDocument: openDocument },
    })
    await failed.load()
    expect(failed.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })

    const rejected = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(describeFailed('provider failed')), openSettingsDocument: openDocument },
    })
    await rejected.load()
    expect(rejected.store.getSnapshot()).toMatchObject({
      status: 'unavailable', error: 'provider failed',
    })
  })

  it('collapses concurrent open gestures and recovers after a failure', async () => {
    let resolveOpen!: (response: RemoteResult<{ opened: true }>) => void
    const openDocument = vi.fn(() => new Promise<RemoteResult<{ opened: true }>>((resolve) => { resolveOpen = resolve }))
    const controller = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response(true)), openSettingsDocument: openDocument },
    })
    await controller.load()
    const first = controller.open()
    const second = controller.open()
    expect(openDocument).toHaveBeenCalledOnce()
    resolveOpen({ ok: false, error: new RemoteError('gateway/internal', 'no default editor', {}) })
    await Promise.all([first, second])
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', opening: false, error: 'no default editor',
    })
  })

  it('recovers availability via a mirror refresh after a failed first read', async () => {
    // A first read that failed leaves the action unavailable with the miss
    // recorded; the mirror's next refresh (a commit or reconnect) recovers it.
    const ctx = {
      remote: {
        settings: {
          describe: vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(response(true)),
          openSettingsDocument: vi.fn(),
        },
      },
    } as never
    const mirror = new SettingsDescribeMirror(ctx)
    const caught = new SettingsDocumentStore(ctx, mirror)
    await caught.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })
    await mirror.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  })
})

it('retains a native draft on stale import and clears it only after successful application', async () => {
  const importDraft = vi.fn().mockResolvedValueOnce({ ok: false, error: new RemoteError('settings/rejected', 'stale draft', { ns: '' }) })
    .mockResolvedValueOnce({ ok: true, value: { imported: true } })
  const controller = derivedDocumentStore({ settings: {
    describe: () => Promise.resolve(response(true)),
    openSettingsDocument: () => Promise.resolve({ ok: true, value: { opened: true, draft: { id: 'native-draft', saveBehavior: 'explicit-import' } } }),
    importSettingsDocumentDraft: importDraft,
  } })
  await controller.load(); await controller.open(); await controller.importSaved()
  expect(importDraft).toHaveBeenCalledWith('native-draft')
  expect(controller.store.getSnapshot()).toMatchObject({ draftId: 'native-draft', importError: true, error: 'stale draft' })
  await controller.importSaved()
  expect(controller.store.getSnapshot().draftId).toBeUndefined()
})


it('ignores imports without a draft and collapses gestures throughout open and import requests', async () => {
  type OpenValue = { opened: true; draft?: { id: string; saveBehavior: 'explicit-import' } }
  let finishOpen!: (result: RemoteResult<OpenValue>) => void
  let finishImport!: (result: RemoteResult<{ imported: true }>) => void
  const openDocument = vi.fn(() => new Promise<RemoteResult<OpenValue>>((resolve) => { finishOpen = resolve }))
  const importDraft = vi.fn(() => new Promise<RemoteResult<{ imported: true }>>((resolve) => { finishImport = resolve }))
  const controller = derivedDocumentStore({ settings: {
    describe: () => Promise.resolve(response(true)), openSettingsDocument: openDocument,
    importSettingsDocumentDraft: importDraft,
  } })
  await controller.importSaved()
  await controller.load()
  await controller.importSaved()
  expect(importDraft).not.toHaveBeenCalled()
  const opening = controller.open()
  finishOpen({ ok: true, value: { opened: true, draft: { id: 'saved-copy', saveBehavior: 'explicit-import' } } })
  await opening

  const reopening = controller.open()
  await controller.importSaved()
  expect(importDraft).not.toHaveBeenCalled()
  finishOpen({ ok: true, value: { opened: true, draft: { id: 'replacement-copy', saveBehavior: 'explicit-import' } } })
  await reopening
  const importing = controller.importSaved()
  await controller.importSaved()
  await controller.open()
  expect(importDraft).toHaveBeenCalledExactlyOnceWith('replacement-copy')
  expect(openDocument).toHaveBeenCalledTimes(2)
  expect(controller.store.getSnapshot()).toMatchObject({ importing: true, error: null, importError: false })
  finishImport({ ok: true, value: { imported: true } })
  await importing
  expect(controller.store.getSnapshot()).toMatchObject({ importing: false, error: null, importError: false })
  expect(controller.store.getSnapshot().draftId).toBeUndefined()
  await controller.importSaved()
  expect(importDraft).toHaveBeenCalledOnce()
})

it.each([
  [new Error('connection lost'), 'connection lost'],
  ['transport closed', 'Settings draft import did not complete'],
])('retains a saved copy after a thrown import failure and accepts an explicit retry: %s', async (failure, message) => {
  const importDraft = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true, value: { imported: true } })
  const controller = derivedDocumentStore({ settings: {
    describe: () => Promise.resolve(response(true)),
    openSettingsDocument: () => Promise.resolve({ ok: true, value: { opened: true, draft: { id: 'retry-copy', saveBehavior: 'explicit-import' } } }),
    importSettingsDocumentDraft: importDraft,
  } })
  await controller.load()
  await controller.open()
  await controller.importSaved()
  expect(controller.store.getSnapshot()).toMatchObject({ draftId: 'retry-copy', importing: false, importError: true, error: message })
  await controller.importSaved()
  expect(importDraft.mock.calls).toEqual([['retry-copy'], ['retry-copy']])
  expect(controller.store.getSnapshot()).toMatchObject({ importing: false, importError: false, error: null })
  expect(controller.store.getSnapshot().draftId).toBeUndefined()
})

it('stops following metadata after disposal and can resume with one subscription', async () => {
  const describe = vi.fn().mockResolvedValue(response(true))
  const ctx = { remote: { settings: { describe } } } as never
  const mirror = new SettingsDescribeMirror(ctx)
  const subscribe = vi.spyOn(mirror, 'subscribe')
  const controller = new SettingsDocumentStore(ctx, mirror)
  controller.dispose()
  await controller.load()
  await controller.load()
  expect(subscribe).toHaveBeenCalledOnce()
  controller.dispose()
  controller.dispose()
  const stopped = controller.store.getSnapshot()
  describe.mockResolvedValue(response(false))
  await mirror.load()
  expect(controller.store.getSnapshot()).toBe(stopped)
  await controller.load()
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(controller.store.getSnapshot().status).toBe('unavailable')
  controller.dispose()
})
