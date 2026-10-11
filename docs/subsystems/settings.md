# Plugin Configuration Forms

English | [中文](settings.zh.md)

The [settings service](../../packages/settings/settings/README.md) projects volatile Config fields from active profile entries. The [configuration editor](../../packages/boot/config-editor/README.md) persists edits through Cordis patches. Business consumers read `.get()` on their own Config references.

## Identity and values

A form namespace is the local id of a uniquely addressed entry in the active profile. Multiple plugin instances have separate forms when their entry ids differ. Ordinary fields are excluded. Descriptors carry resolved values, inherited values, explicit profile overrides, and an optimistic revision.

## Edits

`update` merges submitted fields. `replace` resets live fields to inherited configuration before applying submitted fields. `mutate` addresses individual paths, preserving secrets absent from a client response. Every write validates the complete Config and refuses stale revisions before persistence.

`settings/document-updated` invalidates form descriptors after Loader configuration changes. It is a UI notification; consumers use `loader/volatile-update` only when they need to refresh registration facts.

## Managed candidates

`createDocumentDerivation(changes, expectedView)` prepares a one-use derivation for the caller’s existing native document write snapshot. Every target has a descriptor revision; the native view, entry revision and actual Loader fiber are rechecked before returning writes. Inputs are detached JSON data. Values and mutation paths cannot introduce executable YAML expression markers; paths cannot traverse existing raw expressions, which remain replaceable or resettable as whole values. ConfigEditor still owns YAML serialization and complete Config validation. Publication, reconciliation and migration acknowledgement remain the caller’s separate operations.

Each namespace appears once. `update`, `replace` and `mutate` keep ordinary form semantics. `import` maps one caller-selected legacy section to `ns`, preserves explicit Profile fields by presence rather than value comparison, and fills missing nested children. Explicit arrays replace legacy arrays wholesale. No aliases, source paths or migration ledger are inferred.

```ts type-equiv
/** One revision-fenced form edit for a managed Profile document candidate. */
type SettingsDocumentChange = {
  /** Uniquely addressed active Profile entry; legacy callers map their section id explicitly. */
  readonly ns: string
  /** Entry revision returned by describe. */
  readonly expectedRevision: number
} & (
  | { readonly op: 'update' | 'replace' | 'import'; readonly value: object }
  | { readonly op: 'mutate'; readonly ops: readonly SettingsPathOp[] }
)
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsettings--settingsforms"></a>

### `ctx.settings` — `SettingsForms`

Project Config schemas into forms and own optional instance-level UI policy.

```ts cordis-catalog
/** Register the calling plugin instance's page policy without changing its Config.
 * @param presentation Automatic-page policy for this instance; `auto` defaults to true.
 * @param owner Plugin instance the policy belongs to; defaults to the calling fiber.
 * @returns Disposer; register it with the calling plugin's effects.
 * @throws If this instance already has a registered policy.
 */
configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void

/** Locate the profile patch for native editing.
 * @returns The ordinary Profile path or an exclusive native editing copy.
 * @throws When native draft preparation is unavailable or its base is stale.
 */
async prepareDocument(): Promise<string>

/** Identify a prepared copy without exposing its physical path to remote clients.
 * @param path Host-only path returned by prepareDocument.
 * @returns Draft identity when native explicit import is required.
 */
preparedDocumentDraft(path: string): { id: string; saveBehavior: 'explicit-import' } | undefined

/** Import an editor save against its immutable base, then use ordinary Loader reconciliation.
 * @param draftId Native draft identity returned when opening the editor.
 * @returns The published view reference after successful Loader reconciliation.
 * @throws For stale bases, invalid saves, unavailable drafts or failed reconciliation.
 */
async importDocumentDraft(draftId: string): Promise<string>

/** Read active plugin schemas and their live values.
 * @param options Redaction required for remote callers.
 * @returns Forms keyed by unique profile entry ids.
 */
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]

/** Merge editable fields into an entry's config.
 * @param ns Profile entry id.
 * @param patch Fields to merge.
 * @param expectedRevision Revision returned by describe.
 */
async update(ns: string, patch: object, expectedRevision?: number): Promise<void>

/** Reset all live fields, then set the supplied fields; ordinary config is preserved.
 * @param ns Profile entry id.
 * @param section Complete form values.
 * @param expectedRevision Revision returned by describe.
 */
async replace(ns: string, section: object, expectedRevision?: number): Promise<void>

/** Apply field edits without restating redacted secrets; unsetting an array index removes its element.
 * @param ns Profile entry id.
 * @param ops Ordered form edits.
 * @param expectedRevision Revision returned by describe.
 */
async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>

/**
 * Prepare live-field edits for one native candidate without publishing or reconciling it.
 * Import fills missing Profile fields; explicit values, including defaults and empty arrays, win.
 * Submitted values are JSON data; paths cannot create expression markers or traverse existing raw expressions.
 * @param changes One edit per namespace, with revisions from describe; imports map legacy ids explicitly.
 * @param expectedView Exact native view to derive under the caller's existing document write snapshot.
 * @returns A one-use derivation retaining Settings validation and ConfigEditor YAML/schema ownership.
 * @throws For missing native authority, duplicate namespaces, stale views or entries, or invalid fields.
 */
async createDocumentDerivation( changes: readonly SettingsDocumentChange[], expectedView: ProfileDocumentViewReference, ): Promise<(view: ProfileDocumentView) => readonly ProfileDocumentWrite[]>
```

Types: [ProfileDocumentView](boot.md) · [ProfileDocumentViewReference](boot.md) · [ProfileDocumentWrite](boot.md)

Source: [`packages/settings/settings/src/index.ts`](../../packages/settings/settings/src/index.ts)

<a id="ctxsettingscontroller--settingscontroller"></a>

### `ctx.settingsController` — `SettingsController`

Host service backing the generated `ctx.remote.settings` namespace. Every remote read uses `redactSecrets: true`, so a `role('secret')` field cannot ride a response. Writes expose the settings service's merge, replacement, and path-addressed operations, and classify every provider refusal as `settings/conflict` or `settings/rejected` with the service's message.

```ts cordis-catalog
/**
 * Describe every registered namespace for a configuration page: redacted
 * layered values plus the serialized schema the page renders its form from.
 * @returns provider writability, editable-document availability, and one view per namespace.
 * @throws RemoteError when no settings provider is mounted.
 */
@Remote describe(): SettingsDescribeValue

/**
 * Merge a patch into one namespace's stored user section.
 * @param ns - namespace key to write.
 * @param patch - fields to merge into the user section.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote update( ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Replace one namespace's stored user section wholesale.
 * @param ns - namespace key to write.
 * @param section - complete replacement user section.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote replace( ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Apply path-addressed edits to one namespace's user section, resolved against
 * the section as stored rather than against whatever the caller last read,
 * then answer with that namespace's new redacted view.
 * @param ns - namespace key to write.
 * @param ops - the edits to apply, in order.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async mutate( ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Materialize the provider-owned settings document and open it in a native text editor.
 * @param signal - caller lifetime; abort terminates preparation or the native command.
 * @returns confirmation after the native opener accepts the document.
 * @throws RemoteError when no document exists, preparation fails, or opening fails.
 */
@Remote async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>

/** Publish a saved native editing copy and reconcile the active configuration.
 * @param draftId Identity returned by openSettingsDocument; never a client supplied filename.
 * @returns Confirmation after publication and ordinary Loader reconciliation.
 * @throws RemoteError when the save is stale, invalid or cannot be applied.
 */
@Remote async importSettingsDocumentDraft(draftId: string): Promise<{ imported: true }>
```

Source: [`packages/api/settings-controller/src/index.ts`](../../packages/api/settings-controller/src/index.ts)

<a id="settings-events"></a>

### `settings/*` events

<a id="settingsdocument-updated--emit"></a>

#### `settings/document-updated` — emit

One profile entry's form values, availability, or page policy changed. Form clients re-read its schema, resolved values, and revision.

```ts cordis-catalog
/**
 * One profile entry's form values, availability, or page policy changed.
 * Form clients re-read its schema, resolved values, and revision.
 * @param ns Profile entry id.
 * @param revision The entry's new revision.
 * @mode emit
 */
'settings/document-updated'(ns: SettingsNamespace, revision: number): void
```

Source: [`packages/settings/settings/src/types.ts`](../../packages/settings/settings/src/types.ts)
<!-- END GENERATED cordis-surface -->
