/** Host consumer adapters for one launcher-admitted native Profile document authority. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { bindIncludeDocumentSource, type EntryDocumentHandle } from '@deepseek-ai/cordis-plugin-include'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { assertProfileDocumentSelection, type ProfileDocumentReference, type ProfileDocumentSelection, type ProfileDocumentSnapshot, type ProfileDocumentView, type ProfileDocumentViewReference } from './profile-document-view.ts'
import type { ProfileDocumentLayers } from './profile-context.ts'

/** Caller-generated idempotency key, persisted and inspected by the native document authority. */
export type ProfileDocumentOperationId = Branded<'ProfileDocumentOperationId'>

/** Exact candidate bytes and the immutable document they replace. */
export type ProfileDocumentWrite = Readonly<{
  readonly logicalPath: string
  readonly expected: ProfileDocumentReference
}> & (Readonly<{ text: string; state?: 'present' }> | Readonly<{ state: 'absent' }>)

/** Independent native publication facts; Loader reconciliation is reported by its consumer. */
export interface ProfileDocumentReceipt {
  readonly operationId: ProfileDocumentOperationId
  readonly before: ProfileDocumentViewReference
  readonly after: ProfileDocumentViewReference | undefined
  readonly publication: 'not-published' | 'published' | 'unknown'
  readonly verification: 'verified' | 'failed' | 'not-performed'
  readonly durability: 'confirmed' | 'unconfirmed'
}

/** Native completion, retaining late failures instead of reducing them to a rejected Promise. */
export interface ProfileDocumentPublication {
  readonly receipt: ProfileDocumentReceipt
  readonly view: ProfileDocumentView | undefined
  readonly error?: Error
}

/** Detached native editing copy; its path never names an original or a published version. */
export interface ProfileDocumentDraft {
  readonly id: ProfileDocumentOperationId
  readonly logicalPath: string
  readonly baseView: ProfileDocumentViewReference
  readonly baseDocument: ProfileDocumentReference
  /** Host-only path; remote clients receive the draft identity and explicit import behavior. */
  readonly path: string
  readonly saveBehavior: 'explicit-import'
}

/** Native editing copies retain their exact base and reject saves against a changed document vector. */
export interface ProfileDocumentDrafts {
  /**
   * Prepare an exclusive native draft of the exact current document.
   * @param request Caller-retained operation identity and current base.
   * @returns Finalized draft metadata; uncertain preparation must be inspected by the native owner.
   */
  prepare(request: {
    operationId: ProfileDocumentOperationId
    expected: ProfileDocumentViewReference
    logicalPath: string
  }): Promise<ProfileDocumentDraft>
  /**
   * Observe a completed editor save without publishing it.
   * @param draftId Previously prepared draft.
   * @returns Native draft identity and current content digest for explicit import.
   */
  inspect(draftId: ProfileDocumentOperationId): Promise<{ draft: ProfileDocumentDraft; sha256: string }>
  /**
   * Import exactly the observed draft save against its unchanged base view.
   * @param request New publication identity, prepared draft and observed content digest.
   * @returns Native publication facts; stale bases or changed draft saves refuse before publication.
   */
  import(request: {
    operationId: ProfileDocumentOperationId
    draftId: ProfileDocumentOperationId
    sha256: string
  }): Promise<ProfileDocumentPublication>
}

/** One retained legacy-import attempt; native receipts remain distinct from Loader application. */
export interface ProfileDocumentMigrationEntry {
  readonly key: string
  readonly operationId: ProfileDocumentOperationId
  readonly status: 'published' | 'rejected'
  readonly receipt?: ProfileDocumentReceipt
  readonly reason?: string
}

/** Migration journals use the native committed-state owner and never rename import sources. */
export interface ProfileDocumentMigrations {
  /**
   * Read attempts for one exact source version.
   * @param source Immutable admitted migration source.
   * @returns Retained attempts, including rejected sections.
   */
  read(source: { logicalPath: string; reference: ProfileDocumentReference }): Promise<readonly ProfileDocumentMigrationEntry[]>
  /**
   * Record an attempted section after checking its native publication, if any.
   * @param source Exact source version; changed sources refuse.
   * @param entry Final attempt facts. Uncertain publications cannot be recorded as rejected.
   */
  record(source: { logicalPath: string; reference: ProfileDocumentReference }, entry: ProfileDocumentMigrationEntry): Promise<void>
  /**
   * Ask the native state engine to inspect one retained migration acknowledgement.
   * @param source Exact legacy source version.
   * @param operationId Stable section operation identity; corruption or unsupported phases remain fenced.
   */
  recover(source: { logicalPath: string; reference: ProfileDocumentReference }, operationId: ProfileDocumentOperationId): Promise<void>
}

/** Detached native participant inputs captured while its document and shared Home leases remain held. */
export interface ProfileDocumentParticipant {
  readonly domainId: string
  /** Opaque native metadata, including source/conflict revisions; only its native issuer decodes it. */
  readonly state: Uint8Array
  readonly homeDomainId: string
  readonly homeState: Uint8Array
  /** Existing E selector facts held through this shared D publication; pending intent changes invalidate the view. */
  readonly runtimeEpochs: readonly { readonly domainId: string; readonly revision: number; readonly sha256: string }[]
  readonly documents: readonly ProfileDocumentSnapshot[]
  readonly homeDocuments: readonly ProfileDocumentSnapshot[]
  /** A participant's admitted code graph selects only its matching immutable package set. */
  readonly packageOverlays: readonly { readonly packageSet: string; readonly document: ProfileDocumentSnapshot }[]
}

/** Native authority supplied only after launcher enrollment; no provider is installed by this package. */
export interface ProfileDocuments {
  /** Available only when the native launcher admits private editable draft locations. */
  readonly drafts?: ProfileDocumentDrafts
  /** Native committed-state ledger for importing legacy source sections once. */
  readonly migrations?: ProfileDocumentMigrations
  readonly selection: ProfileDocumentSelection
  /**
   * Select bundle layers from this view's config manifest within the fixed admitted package graph.
   * @param view Exact admitted or derived candidate configuration view.
   * @returns Layers whose code/package identities still equal selection; unadmitted bundles refuse.
   */
  bundleLayers(view: ProfileDocumentView): ProfileDocumentLayers
  /** Stable native document-domain identity; logical paths remain diagnostic labels. */
  readonly domainId: Branded<'ProfileDocumentDomainId'>
  /**
   * Return the last document view admitted by this authority.
   * @returns The desired view, never an assertion of Loader application.
   */
  current(): ProfileDocumentView
  /**
   * Admit the latest native document selection without reopening original files.
   * @returns The fresh desired view, also retained by current().
   */
  refresh(): Promise<ProfileDocumentView>
  /**
   * Read an immutable view retained by this authority, for receipted semantic reversal.
   * @param reference Exact historical view for this process's admitted selection.
   * @returns Detached historical documents; unavailable history fails without inference.
   */
  readView(reference: ProfileDocumentViewReference): Promise<ProfileDocumentView>
  /**
   * Read one retained mutable document across code activations without admitting an old code/package view.
   * @param reference Exact retained native view named by an inspected publication receipt.
   * @param logicalPath An admitted mutable document label; package snapshots are excluded.
   * @returns Original raw text or explicit absence for owned-field reversal.
   */
  readDocumentVersion?(reference: ProfileDocumentViewReference, logicalPath: string): Promise<ProfileDocumentSnapshot>
  /**
   * Derive once under native serialization, rechecking the complete read/source/conflict/participant vector before publication.
   * The provider captures returned bytes once and persists the operation before dependent mutation. A throw before a
   * receipt means no publication; late/uncertain outcomes return their receipt for inspection, never automatic retry.
   * @param request Idempotency key and exact expected view including code/package selection and metadata epochs.
   * @param derive Native semantic validation, called once with the current immutable view while its lease is held.
   * @returns Persisted publication facts and verified successor when available; updates current() only on admitted success.
   */
  withWriteSnapshot(
    request: Readonly<{ operationId: ProfileDocumentOperationId; expected: ProfileDocumentViewReference }>,
    derive: (view: ProfileDocumentView) => readonly ProfileDocumentWrite[] | Promise<readonly ProfileDocumentWrite[]>,
  ): Promise<ProfileDocumentPublication>
  /**
   * Inspect the persisted outcome without repeating publication.
   * @param operationId Previously submitted idempotency key.
   * @returns The retained receipt, or undefined if no operation was recorded.
   */
  inspectOperation(operationId: ProfileDocumentOperationId): Promise<ProfileDocumentReceipt | undefined>
  /**
   * Subscribe from an admitted cursor, replaying any registration gap; overflow/reopen requests a full refresh.
   * Observer callbacks cannot alter publication facts and must not be awaited by native publication.
   * @param after Last observed view; source/conflict and pending-package metadata also invalidate this cursor.
   * @param invalidate Notification to reread the current admitted view.
   * @returns Synchronous subscription cancellation; consumer owns draining its reconciliation queue.
   */
  subscribe(after: ProfileDocumentViewReference, invalidate: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Explicit launcher binding; absence retains ordinary unenrolled behavior. */
    profileDocuments: ProfileDocuments
  }
}

/** Native operation failure with inspection facts retained for the initiator. */
export class ProfileDocumentPublicationError extends Error {
  constructor(readonly receipt: ProfileDocumentReceipt, cause?: Error) {
    super(`Profile document operation ${receipt.operationId} requires inspection (${receipt.publication}, ${receipt.verification}, ${receipt.durability})`, { cause })
  }
}

/** Create a caller-retained idempotency key for native outcome inspection.
 * @returns A new native operation idempotency key.
 */
export function createProfileDocumentOperationId(): ProfileDocumentOperationId {
  return brandString<ProfileDocumentOperationId>(randomUUID())
}

/**
 * Require finalized, verified, durable publication before admitting a successor to consumers.
 * @param result Native operation outcome.
 * @returns The admitted successor; unknown or unconfirmed outcomes require operation inspection.
 */
export function publishedProfileDocumentView(result: ProfileDocumentPublication): ProfileDocumentView {
  if (result.receipt.publication !== 'published' || result.receipt.verification !== 'verified' || result.view === undefined
    || result.receipt.durability !== 'confirmed' || result.receipt.after !== result.view.reference || result.error !== undefined) {
    throw new ProfileDocumentPublicationError(result.receipt, result.error)
  }
  return result.view
}

const applied = new WeakMap<Context, ProfileDocumentViewReference>()
const reading = new AsyncLocalStorage<{ root: Context; view: ProfileDocumentView }>()

/**
 * Read the exact view held by an ongoing composition, otherwise the provider's admitted desired view.
 * @param ctx Process context.
 * @returns The coherent view for all consumers in this asynchronous composition, or undefined when unenrolled.
 */
export function currentProfileDocumentView(ctx: Context): ProfileDocumentView | undefined {
  const held = reading.getStore()
  return held?.root === ctx.root ? held.view : ctx.get('profileDocuments')?.current()
}

/**
 * Keep Include and compatibility reads on one view throughout asynchronous Loader reconciliation.
 * @param ctx Process context.
 * @param view Already admitted view to apply.
 * @param action Composition and activation using that view.
 * @returns The action result and applied view, including native missing-Include initialization successors.
 */
export async function withProfileDocumentView<T>(
  ctx: Context, view: ProfileDocumentView, action: () => Promise<T>,
): Promise<{ value: T; view: ProfileDocumentView }> {
  const documents = ctx.get('profileDocuments')
  if (documents !== undefined) assertProfileDocumentSelection(view, documents.selection)
  const held = { root: ctx.root, view }
  const value = await reading.run(held, action)
  return { value, view: held.view }
}

/**
 * Record successful Loader reconciliation for this process, independently of desired publication.
 * @param ctx Booted process root.
 * @param reference View whose entire reconciliation completed.
 */
export function markProfileDocumentsApplied(ctx: Context, reference: ProfileDocumentViewReference): void {
  applied.set(ctx.root, reference)
}

/**
 * Read the last successfully applied view for this process.
 * @param ctx Booted process root.
 * @returns Applied reference, or undefined before an explicit reconciliation acknowledgement.
 */
export function appliedProfileDocuments(ctx: Context): ProfileDocumentViewReference | undefined {
  return applied.get(ctx.root)
}

/**
 * Bind real Include reads/writes to the same native authority used by ConfigEditor and HMR.
 * @param ctx Prepared launcher context carrying profileContext.
 * @param documents Admitted native provider; supplying this adapter does not qualify enrollment or persistence.
 * @returns The Include binding disposer.
 */
export function bindProfileDocuments(ctx: Context, documents: ProfileDocuments): () => void {
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Profile document binding requires a launcher Profile context')
  const assertView = (view: ProfileDocumentView): void => { assertProfileDocumentSelection(view, {
    profileDir: profile.dir, home: profile.home,
    codeBinding: documents.selection.codeBinding, packageDocuments: documents.selection.packageDocuments,
  }) }
  assertView(documents.current())
  assertProfileDocumentSelection(documents.current(), documents.selection)
  const root = join(profile.dir, 'cordis.yml')
  const handle = (logicalPath: string, view: ProfileDocumentView): EntryDocumentHandle => {
    assertView(view)
    if (logicalPath === root) return { state: 'present', text: '[]\n', writeback: 'discard' }
    const snapshot = view.read(logicalPath)
    return {
      ...snapshot, writeback: 'persist',
      async publish(text) {
        const request = { operationId: createProfileDocumentOperationId(), expected: view.reference }
        const result = await documents.withWriteSnapshot(request, (current) => {
          assertView(current)
          if (current.reference !== view.reference) throw new Error('Include document view changed before publication')
          return [{ logicalPath, expected: snapshot.reference, text }]
        })
        const successor = publishedProfileDocumentView(result)
        const held = reading.getStore()
        if (held?.root === ctx.root && held.view.reference === view.reference) held.view = successor
        return handle(logicalPath, successor)
      },
    }
  }
  const dispose = bindIncludeDocumentSource(ctx, {
    read(path) { return Promise.resolve(handle(path, currentProfileDocumentView(ctx) ?? documents.current())) },
  })
  ctx.provide('profileDocuments', documents)
  return dispose
}
