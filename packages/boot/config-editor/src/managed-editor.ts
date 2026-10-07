/** Native document publication with raw field ownership and ordinary Loader reconciliation. */
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, resolveConfig } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  assertProfileDocumentSelection, composeEntries, createProfileDocumentOperationId,
  markProfileDocumentsApplied, publishedProfileDocumentView,
  readProfilePatchesFromView, reconcileProfilePatches, withProfileDocumentView,
  type ProfileContext, type ProfileDocuments, type ProfileDocumentLayers, type ProfileDocumentOperationId,
  type ProfileDocumentPublication, type ProfileDocumentReceipt, type ProfileDocumentView,
  type ProfileDocumentWrite, type ProfileDocumentSnapshot, type ProfileDocumentViewReference,
} from '@deepseek-ai/dsh-app-boot'
import yaml from 'js-yaml'
import { isMap, Scalar, visit } from 'yaml'
import { parseManagedPatch as parse } from './managed-patch.ts'
import { reverseOwnedConfig } from './owned-fields.ts'

type Raw = Record<string, unknown>
type Selector = { id: string; name: string }

/** Native publication and the actual Loader application result for one entry's raw config edit. */
export interface ConfigurationEditReceipt {
  readonly entry: Readonly<Selector>
  readonly document: ProfileDocumentReceipt
  readonly reconciliation: 'applied'
}

/** Raw changes composed into one native document candidate, without publishing or reconciling it. */
export type ConfigurationDocumentChange = {
  readonly entry: Entry
  readonly change: (current: Raw, inherited: Raw) => Raw
} | { readonly reverse: Pick<ConfigurationEditReceipt, 'entry' | 'document'> }

/**
 * Capture verified reverse history and derive one raw write under a caller's native document snapshot.
 * @param ctx Current Host with real active plugin fibers.
 * @param changes Ordered raw edits or owned-field reversals.
 * @param available Recheck the editor's current entry ownership.
 * @returns A synchronous derivation for the native publication or candidate preparation callback.
 */
export async function createManagedConfigurationDerivation(
  ctx: Context, changes: readonly ConfigurationDocumentChange[], available: (entry: Entry) => boolean,
): Promise<(view: ProfileDocumentView) => readonly ProfileDocumentWrite[]> {
  const documents = ctx.get('profileDocuments')
  if (documents === undefined || changes.length < 1 || changes.length > 1024) throw new Error('Native configuration derivation requires a bounded managed edit set')
  const path = ctx.profileContext.patchPath
  const steps = await Promise.all(changes.map(async (change) => {
    if ('entry' in change) return { ...change, selector: { id: change.entry.options.id, name: change.entry.options.name }, fiber: change.entry.fiber }
    const saved = await documents.inspectOperation(change.reverse.document.operationId)
    if (!saved || !isDeepStrictEqual(saved, change.reverse.document) || saved.publication !== 'published'
      || saved.verification !== 'verified' || saved.durability !== 'confirmed' || saved.after === undefined) throw new Error('Native candidate reversal requires its exact persisted receipt')
    const before = await rawHistory(documents, saved.before, path), after = await rawHistory(documents, saved.after, path)
    const rows = [...ctx.loader.entries()].filter(entry => entry.options.id === change.reverse.entry.id
      && entry.options.name === change.reverse.entry.name && available(entry))
    if (rows.length !== 1) throw new Error('Native candidate reversal entry is missing or ambiguous')
    const entry = rows[0] as Entry
    return { ...change, entry, selector: change.reverse.entry, fiber: entry.fiber, before, after }
  }))
  return (view) => {
    assertProfileDocumentSelection(view, documents.selection)
    let source = text(view, path)
    const canRestoreAbsence = steps.some(step => 'before' in step && step.before.state === 'absent' && snapshotText(step.after) === source)
    for (const step of steps) {
      if (!available(step.entry) || step.fiber === undefined || step.entry.fiber !== step.fiber || step.fiber.state !== FiberState.ACTIVE) throw new Error('Native candidate configuration entry changed')
      const current = replace(view, path, source), base = inherited(documents, path, current, step.selector)
      if ('reverse' in step) source = reverseText(snapshotText(step.before), snapshotText(step.after), source, step.selector, base)
      else {
        const patches = readProfilePatchesFromView('dsh', ctx.profileContext, current, documents.bundleLayers(current))
        const rows = flatten(composeEntries([patches])).filter(row => row.id === step.selector.id && row.name === step.selector.name)
        if (rows.length !== 1) throw new Error('Native candidate configuration entry is missing or ambiguous')
        const next = step.change(structuredClone((rows[0]?.config ?? {}) as Raw), base)
        source = editText(source, step.selector, next, base)
        const candidate = replace(view, path, source)
        const effective = flatten(composeEntries([readProfilePatchesFromView('dsh', ctx.profileContext, candidate, documents.bundleLayers(candidate))])).find(row => row.id === step.selector.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) throw new Error('Native candidate configuration is overridden by another layer')
      }
    }
    const candidate = replace(view, path, source)
    const effective = flatten(composeEntries([readProfilePatchesFromView('dsh', ctx.profileContext, candidate, documents.bundleLayers(candidate))]))
    for (const step of steps) {
      const row = effective.find(row => row.id === step.selector.id && row.name === step.selector.name)
      if (!row || !step.fiber) throw new Error('Native candidate configuration disappeared')
      const next: unknown = structuredClone(row.config ?? {})
      const resolved: unknown = step.fiber.ctx.waterfall(step.fiber, 'internal/config', next, () => next)
      resolveConfig(step.fiber.runtime as NonNullable<typeof step.fiber.runtime>, resolved)
    }
    return canRestoreAbsence && rawRows(source).length === 0
      ? [{ logicalPath: path, expected: view.read(path).reference, state: 'absent' }]
      : [{ logicalPath: path, expected: view.read(path).reference, text: source }]
  }
}

/** Retains the first publication and any reverse publication when Loader application fails. */
export class ConfigurationReconciliationError extends Error {
  constructor(readonly document: ProfileDocumentReceipt, readonly reversal: ProfileDocumentReceipt | undefined, cause: unknown) {
    super('Configuration publication did not reconcile; inspect the retained publication and reversal receipts', { cause })
  }
}

const flatten = (rows: EntryOptions[]): EntryOptions[] => rows.flatMap(row => [row,
  ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])

function text(view: ProfileDocumentView, path: string): string {
  const snapshot = view.read(path)
  return snapshot.state === 'present' ? snapshot.text : '[]\n'
}

const snapshotText = (snapshot: ProfileDocumentSnapshot) => snapshot.state === 'present' ? snapshot.text : '[]\n'
async function rawHistory(
  documents: ProfileDocuments, reference: ProfileDocumentViewReference, path: string,
): Promise<ProfileDocumentSnapshot> {
  return documents.readDocumentVersion === undefined
    ? (await documents.readView(reference)).read(path) : documents.readDocumentVersion(reference, path)
}

function stringify(document: ReturnType<typeof parse>): string {
  visit(document, { Map(_key, node) {
    if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
    const expression = new Scalar(node.get('__jsExpr'))
    expression.tag = 'tag:yaml.org,2002:js'
    return expression
  } })
  return String(document)
}

function matches(row: unknown, selector: Selector): row is PatchOptions {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && Reflect.get(row, 'id') === selector.id && Reflect.get(row, 'insert') === undefined
    && (Reflect.get(row, 'name') === undefined || Reflect.get(row, 'name') === selector.name)
}

function rawRows(source: string): PatchOptions[] {
  const rows: unknown = yaml.load(source, { schema: entryListSchema })
  if (!Array.isArray(rows)) throw new Error('Profile patch must be a YAML sequence')
  return rows as PatchOptions[]
}

function replace(view: ProfileDocumentView, path: string, source: string): ProfileDocumentView {
  return { ...view, read(logicalPath) { return logicalPath === path ? { ...view.read(path), state: 'present', text: source } : view.read(logicalPath) } }
}

/**
 * Read raw profile overrides and fixed admitted bundle layers without reopening originals.
 * @param documents Native document authority for this process.
 * @param path Logical Profile patch filename.
 * @param view Desired view to inspect, defaulting to the authority's admitted current view.
 * @returns The native editor's inherited-layer inputs.
 */
export function managedConfigurationLayers(documents: ProfileDocuments, path: string, view = documents.current()): { layers: ProfileDocumentLayers['layers']; patches: PatchOptions[] } {
  assertProfileDocumentSelection(view, documents.selection)
  return { layers: documents.bundleLayers(view).layers, patches: rawRows(text(view, path)) }
}

function inherited(documents: ProfileDocuments, path: string, view: ProfileDocumentView, selector: Selector): Raw {
  const loaded = managedConfigurationLayers(documents, path, view)
  const patches = loaded.patches.map((row) => {
    if (!matches(row, selector)) return row
    const rest = { ...row }; Reflect.deleteProperty(rest, 'config'); return rest
  })
  const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === selector.id)
  return structuredClone((row?.config ?? {}) as Raw)
}

function editText(source: string, selector: Selector, next: Raw, inherited: Raw): string {
  const document = parse(source)
  const rows = rawRows(source)
  const indexes = rows.flatMap((row, index) => matches(row, selector) ? [index] : [])
  if (isDeepStrictEqual(next, inherited)) {
    for (const index of indexes) {
      const row = document.contents.items[index]
      if (isMap(row)) row.delete('config')
    }
  } else {
    const index = indexes.at(-1)
    if (index === undefined) document.add(document.createNode({ ...selector, config: next }))
    else document.setIn([index, 'config'], document.createNode(next))
  }
  return stringify(document)
}

function reverseText(before: string, after: string, current: string, selector: Selector, inherited: Raw): string {
  const select = (source: string) => rawRows(source).flatMap((row, index) => matches(row, selector) ? [{ row, index }] : [])
  const b = select(before), a = select(after), c = select(current)
  if (c.length !== a.length || b.length > a.length) throw new Error('Configuration override rows changed after publication')
  const document = parse(current)
  for (let index = a.length - 1; index >= 0; index--) {
    const prior = b[index]?.row, next = (a[index] as (typeof a)[number]).row, latest = c[index] as (typeof c)[number]
    const config = (row: PatchOptions | undefined) => {
      const value: unknown = row?.config
      return row !== undefined && Object.hasOwn(row, 'config') ? { present: true as const, value } : { present: false as const }
    }
    const reversed = reverseOwnedConfig(config(prior), config(next), config(latest.row))
    if (reversed.present) {
      const value = !b.some(item => Object.hasOwn(item.row, 'config')) && reversed.value !== null && typeof reversed.value === 'object' && !Array.isArray(reversed.value)
        ? { ...inherited, ...reversed.value } : reversed.value
      document.setIn([latest.index, 'config'], document.createNode(value))
    }
    else {
      document.deleteIn([latest.index, 'config'])
      if (prior === undefined && Object.keys(latest.row).every(key => ['id', 'name', 'config'].includes(key))) document.delete(latest.index)
    }
  }
  return stringify(document)
}

async function reconcile(
  ctx: Context, documents: ProfileDocuments, view: ProfileDocumentView, requiredIds: readonly string[] = [],
): Promise<void> {
  const patches = readProfilePatchesFromView('dsh', ctx.profileContext, view, documents.bundleLayers(view))
  const applied = await withProfileDocumentView(ctx, view, () => reconcileProfilePatches(ctx.root, patches, 'dsh', requiredIds, true))
  markProfileDocumentsApplied(ctx, applied.view.reference)
}

/**
 * Reverse a receipted config change from retained raw versions under the current native view's CAS.
 * @param ctx Process context already holding HMR serialization.
 * @param receipt Original editor receipt, verified against native operation inspection before reading history.
 * @param operationId Caller-retained reversal key for interruption recovery.
 * @returns A newer publication whose owned fields were reversed and Loader reconciliation completed.
 */
export async function reverseManagedConfiguration(ctx: Context, receipt: Pick<ConfigurationEditReceipt, 'entry' | 'document'>, operationId: ProfileDocumentOperationId = createProfileDocumentOperationId()): Promise<ConfigurationEditReceipt> {
  const documents = ctx.get('profileDocuments')
  if (documents === undefined) throw new Error('Native Profile document authority is unavailable')
  const result = await reverseNativeDocument(ctx.profileContext, documents, receipt, operationId)
  const view = publishedProfileDocumentView(result)
  try { await reconcile(ctx, documents, view) }
  catch (error) { throw new ConfigurationReconciliationError(result.receipt, undefined, error) }
  return { entry: receipt.entry, document: result.receipt, reconciliation: 'applied' }
}

async function reverseNativeDocument(
  profile: ProfileContext, documents: ProfileDocuments, receipt: Pick<ConfigurationEditReceipt, 'entry' | 'document'>,
  operationId: ProfileDocumentOperationId, validate?: (entry: EntryOptions) => Promise<void> | void,
): Promise<ProfileDocumentPublication> {
  const saved = await documents.inspectOperation(receipt.document.operationId)
  if (saved === undefined || !isDeepStrictEqual(saved, receipt.document) || saved.publication !== 'published'
    || saved.verification !== 'verified' || saved.durability !== 'confirmed' || saved.after === undefined) {
    throw new Error('Configuration reversal requires a matching persisted native publication receipt')
  }
  const path = profile.patchPath
  const [before, after] = await Promise.all([rawHistory(documents, saved.before, path), rawHistory(documents, saved.after, path)])
  const current = await documents.refresh()
  return documents.withWriteSnapshot({ operationId, expected: current.reference }, async (view) => {
    const source = reverseText(snapshotText(before), snapshotText(after), text(view, path), receipt.entry,
      inherited(documents, path, view, receipt.entry))
    const patches = readProfilePatchesFromView('dsh', profile, replace(view, path, source), documents.bundleLayers(view))
    const entries = flatten(composeEntries([patches])).filter(row => row.id === receipt.entry.id && row.name === receipt.entry.name)
    if (entries.length !== 1) throw new Error('Configuration reversal target is missing or ambiguous')
    await validate?.(structuredClone(entries[0] as EntryOptions))
    const previous = before, published = after, latest = view.read(path)
    if (previous.state === 'absent' && published.state === 'present' && latest.state === 'present' && latest.text === published.text) {
      return [{ logicalPath: path, expected: latest.reference, state: 'absent' }]
    }
    return [{ logicalPath: path, expected: view.read(path).reference, text: source }]
  })
}

/** A declaration read without constructing a Loader Entry or plugin fiber. */
export interface OfflineConfigurationEntry { options: EntryOptions }

/** Restore-only native editor; publication never asserts application by a running Loader. */
export interface OfflineConfigurationEditor {
  readonly documentPath: string
  /** @returns Detached configuration declarations from the current admitted document view. */
  configuration(): Array<{ entry: OfflineConfigurationEntry; inherited: Raw; override: Raw }>
  /** @returns A freshly admitted desired reference; no plugin is mounted or reconciled. */
  refreshDocuments(): Promise<ProfileDocumentView['reference']>
  /**
   * Reverse still-matching owned fields from a confirmed native receipt.
   * @param receipt Original entry selector and persisted native publication facts.
   * @param operationId Caller-retained key for inspection after an interrupted reversal.
   * @returns Confirmed reverse publication, explicitly labelled as offline.
   */
  reverseEdit(receipt: Pick<ConfigurationEditReceipt, 'entry' | 'document'>, operationId?: ProfileDocumentOperationId):
  Promise<Pick<ConfigurationEditReceipt, 'entry' | 'document'> & { reconciliation: 'offline' }>
}

/**
 * Create a restore-only native editor sharing the live editor's YAML and raw-field reversal semantics.
 * @param profile Logical Profile facts admitted by the offline launcher.
 * @param documents Qualified native read/history/publication authority; no filesystem fallback is installed.
 * @param validateRestoredEntry Native validators from the fixed admitted code graph, without plugin application or expressions.
 * @returns An offline adapter; no Loader, fiber, package activation or application receipt is fabricated.
 */
export function createOfflineConfigurationEditor(
  profile: ProfileContext, documents: ProfileDocuments, validateRestoredEntry: (entry: EntryOptions) => Promise<void> | void,
): OfflineConfigurationEditor {
  assertProfileDocumentSelection(documents.current(), { ...documents.selection, profileDir: profile.dir, home: profile.home })
  const entries = new Map<string, OfflineConfigurationEntry>()
  return {
    documentPath: profile.patchPath,
    configuration() {
      const view = documents.current()
      const loaded = managedConfigurationLayers(documents, profile.patchPath, view)
      const rows = flatten(composeEntries([readProfilePatchesFromView('dsh', profile, view, documents.bundleLayers(view))]))
      return rows.filter(row => rows.filter(candidate => candidate.id === row.id).length === 1).map((row) => {
        const entry = entries.get(row.id) ?? { options: row }
        entry.options = structuredClone(row); entries.set(row.id, entry)
        const override: unknown = loaded.patches.findLast(patch => matches(patch, row) && patch.config !== undefined)?.config
        return { entry, inherited: inherited(documents, profile.patchPath, view, row),
          override: structuredClone((override ?? {}) as Raw),
        }
      })
    },
    async refreshDocuments() {
      const view = await documents.refresh()
      assertProfileDocumentSelection(view, documents.selection)
      return view.reference
    },
    async reverseEdit(receipt, operationId = createProfileDocumentOperationId()) {
      const result = await reverseNativeDocument(profile, documents, receipt, operationId, validateRestoredEntry)
      publishedProfileDocumentView(result)
      return { entry: receipt.entry, document: result.receipt, reconciliation: 'offline' }
    },
  }
}

/**
 * Apply the latest finalized desired view after inspecting an interrupted native operation.
 * @param ctx Process context already holding HMR serialization.
 * @returns The newly acknowledged applied view reference.
 */
export async function refreshManagedConfiguration(ctx: Context): Promise<ProfileDocumentView['reference']> {
  const documents = ctx.get('profileDocuments')
  if (documents === undefined) throw new Error('Native Profile document authority is unavailable')
  const view = await documents.refresh()
  await reconcile(ctx, documents, view)
  return view.reference
}

/**
 * Publish a schema-validated raw config edit through the native authority and reconcile its exact successor.
 * @param ctx Process context already holding HMR serialization.
 * @param entry Current uniquely addressed profile entry.
 * @param available Rechecks editor ownership immediately before and during native derivation.
 * @param change Derives once from detached raw current and inherited values.
 * @param operationId Caller-retained idempotency key for later operation inspection.
 * @returns Publication facts and successful Loader application; failures retain native receipts.
 */
export async function editManagedConfiguration(
  ctx: Context, entry: Entry, available: () => boolean,
  change: (current: Raw, inherited: Raw) => Raw,
  operationId: ProfileDocumentOperationId = createProfileDocumentOperationId(),
): Promise<ConfigurationEditReceipt> {
  const documents = ctx.get('profileDocuments')
  if (documents === undefined) throw new Error('Native Profile document authority is unavailable')
  const view = await documents.refresh()
  await reconcile(ctx, documents, view)
  if (!available() || entry.fiber === undefined) throw new Error('Configuration entry changed during reload')
  const fiber = entry.fiber
  const selector = { id: entry.options.id, name: entry.options.name }
  const path = ctx.profileContext.patchPath
  const result = await documents.withWriteSnapshot({ operationId, expected: view.reference }, (currentView) => {
    if (currentView.reference !== view.reference || !available() || entry.fiber !== fiber || fiber.state !== FiberState.ACTIVE) {
      throw new Error('Configuration entry or view changed before native publication')
    }
    const base = inherited(documents, path, currentView, selector)
    const next = change(structuredClone((entry.options.config ?? {}) as Raw), base)
    const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
    resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
    const source = editText(text(currentView, path), selector, next, base)
    const patches = readProfilePatchesFromView('dsh', ctx.profileContext, replace(currentView, path, source), documents.bundleLayers(currentView))
    const effective = flatten(composeEntries([patches])).find(row => row.id === selector.id)
    if (!isDeepStrictEqual(effective?.config ?? {}, next)) throw new Error(`Configuration for "${selector.id}" is overridden by a home patch or command-line overlay`)
    return [{ logicalPath: path, expected: currentView.read(path).reference, text: source }]
  })
  const published = publishedProfileDocumentView(result)
  try { await reconcile(ctx, documents, published, [selector.id]) }
  catch (error) {
    let reversal: ProfileDocumentReceipt | undefined
    try { reversal = (await reverseManagedConfiguration(ctx, { entry: selector, document: result.receipt })).document }
    catch (failure) {
      if (failure instanceof ConfigurationReconciliationError) reversal = failure.document
      throw new ConfigurationReconciliationError(result.receipt, reversal, new AggregateError([error, failure]))
    }
    throw new ConfigurationReconciliationError(result.receipt, reversal, error)
  }
  return { entry: selector, document: result.receipt, reconciliation: 'applied' }
}
