/** State owner for the optional local settings-document action. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Browser state of the Host-owned settings document. */
export interface SettingsDocumentState {
  /** Metadata-loading phase; unavailable means the provider has no local document or the read failed. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Whether one native-open request is in flight. */
  opening: boolean
  /** Last metadata/native-open diagnostic; UI exposes only localized copy. */
  error: string | null
  /** Native copy waiting for the user to save and explicitly import it. */
  draftId?: string
  /** Whether a saved-copy import is running. */
  importing?: boolean
  /** Select the localized save-conflict diagnostic. */
  importError?: boolean
}

/** Derives local-document availability from the shared mirror and invokes the pathless Host-owned open operation. */
export class SettingsDocumentStore {
  /** uSES-safe state source shared by the registered header action. */
  readonly store: SnapshotStore<SettingsDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null,
  })

  private following: (() => void) | undefined

  /**
   * @param ctx - the plugin's context, whose loopback `remote.settings`
   * namespace opens the provider document.
   * @param describeFace - the shared mirror's describe face (`hasDocument` source).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Begin following the mirror (idempotent) and reflect whether the current
   * provider owns a local document.
   * @returns settlement once the snapshot reflects the mirror.
   */
  async load(): Promise<void> {
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * Open the loaded document once; concurrent gestures collapse behind the in-flight action.
   * @returns after the native-open request settles, or immediately when unavailable/already opening.
   */
  async open(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening || current.importing) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
      state.importError = false
    })
    try {
      const result = await this.ctx.remote.settings.openSettingsDocument()
      if (!result.ok) {
        const { message } = result.error
        this.store.update((state) => { state.error = message })
      } else this.store.update((state) => {
        if (result.value.draft === undefined) delete state.draftId
        else state.draftId = result.value.draft.id
      })
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** Import a saved editing copy; a stale base stays visible for explicit review.
   * @returns After the native import and Loader reconciliation settle.
   */
  async importSaved(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.draftId === undefined || current.opening || current.importing) return
    this.store.update((state) => { state.importing = true; state.error = null; state.importError = false })
    try {
      const result = await this.ctx.remote.settings.importSettingsDocumentDraft(current.draftId)
      this.store.update((state) => {
        if (result.ok) delete state.draftId
        else { state.error = result.error.message; state.importError = true }
      })
    } catch (error) {
      this.store.update((state) => {
        state.error = error instanceof Error ? error.message : 'Settings draft import did not complete'
        state.importError = true
      })
    } finally { this.store.update((state) => { state.importing = false }) }
  }

  /** Stop following the mirror. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      // A held failure with no answer means the document cannot be located;
      // without one the read is still in flight and loading stands.
      if (mirrored.error !== null) {
        this.store.update((state) => {
          state.status = 'unavailable'
          state.error = mirrored.error
        })
      }
      return
    }
    const { hasDocument } = mirrored.view
    this.store.update((state) => {
      state.status = hasDocument ? 'ready' : 'unavailable'
      state.error = null
    })
  }
}
