/** In-memory native-capability double for real Host consumer tests; never a durability provider. */
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createProfileDocumentView,
  type ProfileCodeBindingReference, type ProfileContext, type ProfileDocumentOperationId,
  type ProfileDocumentReceipt, type ProfileDocumentReference, type ProfileDocuments,
  type ProfileDocumentSnapshot, type ProfileDocumentView, type ProfileDocumentViewReference,
  type ProfilePackageDocumentsReference,
} from '../src/index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** @returns A test authority simulating finalized receipt facts; it supplies no native durability evidence. */
export function documentProviderFixture(
  profile: ProfileContext, patches: PatchOptions[], initial: Record<string, string | undefined> = {},
) {
  let revision = 0
  const listeners = new Set<() => void>()
  const history = new Map<ProfileDocumentViewReference, ProfileDocumentView>()
  const receipts = new Map<ProfileDocumentOperationId, ProfileDocumentReceipt>()
  const contents = new Map<string, string | undefined>([
    [profile.patchPath, '[]\n'], [join(profile.home, 'cordis.patch.yml'), undefined],
    [join(profile.dir, 'compatibility.json'), undefined], ...Object.entries(initial),
  ])
  const selection = {
    profileDir: profile.dir, home: profile.home,
    codeBinding: brandString<ProfileCodeBindingReference>('fixture-code'),
    packageDocuments: brandString<ProfilePackageDocumentsReference>('fixture-packages'),
  }
  const snapshot = (): ProfileDocumentView => {
    const view = createProfileDocumentView({
      selection, reference: brandString<ProfileDocumentViewReference>(`fixture-view-${revision}`),
      documents: [...contents].map(([logicalPath, text]): ProfileDocumentSnapshot => ({
        logicalPath, reference: brandString<ProfileDocumentReference>(`fixture-document-${revision}:${logicalPath}`),
        ...text === undefined ? { state: 'absent' } : { state: 'present', text },
      })),
    })
    history.set(view.reference, view)
    return view
  }
  let current = snapshot()
  let beforePublish: (() => void) | undefined
  let lateError: Error | undefined
  let durability: ProfileDocumentReceipt['durability'] = 'confirmed'
  let writing = false
  const notify = () => { for (const listener of listeners) listener() }
  const external = (changes: Record<string, string | undefined>): void => {
    for (const [path, text] of Object.entries(changes)) contents.set(path, text)
    revision++; current = snapshot(); notify()
  }
  const documents: ProfileDocuments = {
    selection, domainId: brandString<ProfileDocuments['domainId']>('fixture-domain'),
    bundleLayers: () => ({ ...selection, layers: [{ packageName: 'fixture', packageDir: profile.dir, patchPaths: [], patches }] }),
    current: () => current,
    refresh: async () => current,
    async readView(reference) {
      const view = history.get(reference)
      if (view === undefined) throw new Error('Historical view is unavailable')
      return view
    },
    async withWriteSnapshot(request, derive) {
      if (writing) throw new Error('Reentrant native writer')
      if (request.expected !== current.reference) throw new Error('Stale native document view')
      if (receipts.has(request.operationId)) throw new Error('Inspect an existing operation instead of publishing again')
      writing = true
      try {
        const before = current
        const writes = structuredClone(await derive(before))
        beforePublish?.()
        if (current.reference !== before.reference) throw new Error('Native document view changed during validation')
        for (const write of writes) {
          if (write.expected !== before.read(write.logicalPath).reference) throw new Error('Stale native document')
        }
        for (const write of writes) contents.set(write.logicalPath, write.state === 'absent' ? undefined : write.text)
        revision++; current = snapshot()
        const receipt: ProfileDocumentReceipt = {
          operationId: request.operationId, before: before.reference, after: current.reference,
          publication: 'published', verification: 'verified', durability,
        }
        receipts.set(request.operationId, receipt)
        notify()
        return { receipt, view: current, ...lateError === undefined ? {} : { error: lateError } }
      } finally { writing = false }
    },
    inspectOperation: async id => receipts.get(id),
    subscribe(after, listener) {
      listeners.add(listener)
      if (after !== current.reference) listener()
      return () => { listeners.delete(listener) }
    },
  }
  return { documents, external, receipts, contents, notify, listeners,
    beforePublish(callback: () => void) { beforePublish = callback },
    lateFailure(error: Error) { lateError = error },
    unconfirmed() { durability = 'unconfirmed' },
  }
}
