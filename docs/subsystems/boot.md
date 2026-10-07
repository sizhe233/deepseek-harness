# Profile management

English | [中文](boot.zh.md)

The [boot package group](../../packages/boot/README.md) owns launcher-provided profile access and the plugin manager. [Plugin Manager](../../packages/boot/plugin-manager/README.md) documents persistence, reload and package-operation behavior.

## Management records

`PluginEntryId` identifies one Loader entry; callers obtain it from `listPlugins` rather than constructing a patch id.

`PluginInfo` carries module identity, effective enablement, fiber phase and optional display `meta`, plus a unique `patchId` or a `readOnlyReason`.

`BundleInfo` carries the package name, optional installed version, selected enablement, removal availability, optional resolution error, and, for a bundle the profile's own dependency supplies and the installation does not, `source`: that dependency as a spec `pnpm add` accepts. Its optional `meta` and each `BundleRowInfo.meta` contain display text or a metadata diagnostic; Clients select a language at render time.

`InstallBundleOptions.enabled` defaults to true. False installs without selecting the bundle layer. `approvedBuilds` grants persistent script permission to the supplied pending package names before installation. `registry` names the registry asked first; absent, the configured one.

`PluginRegistries` carries the configured first registry, `null` for the one pnpm's own configuration names, the fallbacks asked after it, and `resolved`, the URL pnpm's own configuration names or `null` while unread. `InspectOptions.registry` names the registry a lookup asks first.

`ChangeResult.changed` reports a disk edit independently of `application`: `applied`, `restart-required`, `overridden` or `failed`. Optional `error` carries a localizable code and external diagnostic. `packageResult` records the pnpm exit code, bounded output, truncation flag and complete diagnostic log path, plus `timedOut` when the manager terminated a run that stopped printing. A terminated run is classified `timeout` whatever exit status the signal left behind, so installation and removal report failure instead of success and no further registry is asked. `pendingBuilds` lists undecided packages across the profile; `approvedBuilds` records the names granted permission by this operation; `registries` lists the registries an installation asked, in order; `bundle` and `version` name the package a finished installation added and its manifest version; `failedAt` says whether the last failed run could not reach the registry it asked or the host a git or tarball spec is fetched from.

## Managed document views

`ProfileDocuments` is the launcher-admitted authority consumed by [App boot](../../packages/boot/app-boot/README.md). `ProfileDocumentViewReference` identifies a complete immutable desired configuration; `ProfileDocumentReference` identifies one document version or recorded absence. `ProfileDocumentSelection` fixes the logical profile and home together with their admitted code and package-document identities. These references do not authorize storage access, and a desired view does not establish Loader application.

```ts type-equiv
/** Provider-issued identity of one complete configuration and package-document view. */
type ProfileDocumentViewReference = Branded<'ProfileDocumentViewReference'>
```

```ts type-equiv
/** Provider-issued identity of an immutable document version or recorded absence. */
type ProfileDocumentReference = Branded<'ProfileDocumentReference'>
```

```ts type-equiv
/** Admitted process code identity; configuration publication cannot change it. */
type ProfileCodeBindingReference = Branded<'ProfileCodeBindingReference'>
```

```ts type-equiv
/** Package-document set admitted with one process code binding, excluding pending package edits. */
type ProfilePackageDocumentsReference = Branded<'ProfilePackageDocumentsReference'>
```

```ts type-equiv
/** Logical locations and immutable package selection owned by the requesting launcher. */
interface ProfileDocumentSelection {
  readonly profileDir: string
  readonly home: string
  readonly codeBinding: ProfileCodeBindingReference
  readonly packageDocuments: ProfilePackageDocumentsReference
}
```

```ts type-equiv
/** Detached text or an explicit absence; unlisted paths are never treated as absent. */
type ProfileDocumentSnapshot = Readonly<{
  logicalPath: string
  reference: ProfileDocumentReference
}> & (Readonly<{ state: 'present'; text: string }> | Readonly<{ state: 'absent' }>)
```

```ts type-equiv
/** Immutable desired configuration; this does not assert a running Loader has applied it. */
interface ProfileDocumentView {
  readonly reference: ProfileDocumentViewReference
  readonly selection: ProfileDocumentSelection
  /**
   * Read an admitted logical filename without reopening its source.
   * @param logicalPath Canonical absolute filename in this view's admitted read set.
   * @returns The immutable snapshot, including an explicit absence when admitted.
   * @throws When the filename is not in the read set.
   */
  read(logicalPath: string): ProfileDocumentSnapshot
}
```

```ts type-equiv
/** Bundle layers loaded from the exact code and package-document selection admitted for this process. */
interface ProfileDocumentLayers {
  readonly codeBinding: ProfileDocumentSelection['codeBinding']
  readonly packageDocuments: ProfileDocumentSelection['packageDocuments']
  readonly layers: readonly ProfileLayer[]
}
```

`ProfileDocumentSnapshot` distinguishes present raw text from explicit absence; a path outside the admitted read set throws rather than becoming an absent document. `ProfileDocumentLayers` binds the resolved [bundle layers](../../packages/boot/app-boot/src/profile.ts) to the view’s exact code and package-document selection. `refresh()` admits a desired view, while consumers separately record successful Loader reconciliation.

## Document publication receipts

`ProfileDocumentOperationId` is a caller-retained idempotency key. Each `ProfileDocumentWrite` names an admitted logical path, its expected immutable document reference, and either replacement text or explicit absence. `withWriteSnapshot` invokes the derivation once under native serialization and rechecks the complete expected view before publication. A throw before a receipt means no publication; late or uncertain outcomes retain their receipt for `inspectOperation` instead of automatic retry.

```ts type-equiv
/** Caller-generated idempotency key, persisted and inspected by the native document authority. */
type ProfileDocumentOperationId = Branded<'ProfileDocumentOperationId'>
```

```ts type-equiv
/** Exact candidate bytes and the immutable document they replace. */
type ProfileDocumentWrite = Readonly<{
  readonly logicalPath: string
  readonly expected: ProfileDocumentReference
}> & (Readonly<{ text: string; state?: 'present' }> | Readonly<{ state: 'absent' }>)
```

```ts type-equiv
/** Independent native publication facts; Loader reconciliation is reported by its consumer. */
interface ProfileDocumentReceipt {
  readonly operationId: ProfileDocumentOperationId
  readonly before: ProfileDocumentViewReference
  readonly after: ProfileDocumentViewReference | undefined
  readonly publication: 'not-published' | 'published' | 'unknown'
  readonly verification: 'verified' | 'failed' | 'not-performed'
  readonly durability: 'confirmed' | 'unconfirmed'
}
```

```ts type-equiv
/** Native completion, retaining late failures instead of reducing them to a rejected Promise. */
interface ProfileDocumentPublication {
  readonly receipt: ProfileDocumentReceipt
  readonly view: ProfileDocumentView | undefined
  readonly error?: Error
}
```

`ProfileDocumentReceipt` reports publication, verification and durability independently of Loader application. `ProfileDocumentPublication` preserves the successor view when available and any late error. A consumer admits success only when publication is `published`, verification is `verified`, durability is `confirmed`, `after` matches the returned view, and no error remains.

## Configuration edits and reversal

[Config Editor](../../packages/boot/config-editor/README.md) returns `ConfigurationEditReceipt` only after native publication and successful Loader reconciliation. Its `entry` selector contains the original Loader row’s `id` and `name`. `ConfigurationDocumentChange` supplies either an entry and a raw-config derivation (`Raw` is `Record<string, unknown>`) or the exact persisted receipt to reverse.

```ts type-equiv
/** Native publication and the actual Loader application result for one entry's raw config edit. */
interface ConfigurationEditReceipt {
  readonly entry: Readonly<Selector>
  readonly document: ProfileDocumentReceipt
  readonly reconciliation: 'applied'
}
```

```ts type-equiv
/** Raw changes composed into one native document candidate, without publishing or reconciling it. */
type ConfigurationDocumentChange = {
  readonly entry: Entry
  readonly change: (current: Raw, inherited: Raw) => Raw
} | { readonly reverse: Pick<ConfigurationEditReceipt, 'entry' | 'document'> }
```

`createDocumentDerivation` prepares ordered edits and receipted reversals without publishing or reconciling them; the returned derivation runs once in the caller’s native write snapshot. Reversal requires verified, durable publication history and reverses only still-matching owned raw fields, preserving unrelated current edits. Missing or ambiguous entries, replaced fibers, stale receipts and schema failures refuse the edit.

## Managed package operations

`ProfilePackageOperations` is the launcher-bound provider used by [Plugin Manager](../../packages/boot/plugin-manager/README.md). `ManagedPackageRequest` binds an install, removal or package command to a durable `ProfilePackageOperationId` and the expected document view. Reusing an operation id inspects its saved request and outcome; a changed payload refuses rather than rerunning package scripts.

```ts type-equiv
/** Durable identity retained across package preparation, publication and response loss. */
type ProfilePackageOperationId = Branded<'ProfilePackageOperationId'>
```

```ts type-equiv
/** A normal package request against one finalized native Profile read vector. */
type ManagedPackageRequest = Readonly<{
  operationId: ProfilePackageOperationId
  expected: ProfileDocumentViewReference
}> & (Readonly<{ kind: 'install'; spec: string; options?: InstallBundleOptions }>
  | Readonly<{ kind: 'remove'; name: string }>
  | Readonly<{ kind: 'command'; args: readonly string[] }>)
```

```ts type-equiv
/** Existing execution, consent, registry and cancellation policy; no caller pathname grants storage authority. */
interface ManagedPackagePolicy extends PackageOperationOptions {
  readonly registries: PluginRegistries
  readonly githubConnectionTimeoutMs: number
  /** Progress changes cancellation availability only after the provider durably enters publication. */
  readonly onProgress?: (phase: PluginInstallProgress['phase'], attempt?: PluginInstallProgress['attempt']) => void
}
```

`ManagedPackagePolicy` extends [PackageOperationOptions](../../packages/boot/plugin-manager/src/operations.ts) with registry selection, the GitHub connection timeout and progress observation. Existing execution, cancellation and build-script consent remain in force; updater rollback does not contain or reverse separately approved scripts’ side effects. Uncertain publication returns a failed `ChangeResult` retaining the operation id; `inspectOperation` reads its durable outcome without repeating package commands or publication.

## Carrier admission value

`ctx.runtimeAdmission` is a fixed-carrier boot value, not an independently mounted service. Its [RuntimeAdmission](../../packages/boot/app-boot/src/runtime-admission.ts) union reports `unenrolled`, `blocked` or `managed`; the context value excludes `blocked` because a blocked admission prevents application startup. `unenrolled` requires positive absence of runtime management. `managed` retains the admitted code graph, document authority and carrier lifecycle callbacks for this process.

The carrier obtains admission before importing business code and provides the retained result before plugins mount. `requireManagedRuntimeAdmission` accepts only the opaque result admitted to this process, not a caller-constructed object with the same fields. The [App boot package](../../packages/boot/app-boot/README.md) owns composition over that admitted state.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconfigeditor--configeditor"></a>

### `ctx.configEditor` — `ConfigEditor`

Persist complete raw configs and apply them through the normal Loader path.

```ts cordis-catalog
/**
 * Prepare raw edits for one versioned candidate while retaining real schema and owned-field validation.
 * @param changes Ordered entry edits or receipted reversals.
 * @returns A derivation to invoke exactly once under the native document write snapshot.
 */
createDocumentDerivation( changes: readonly ConfigurationDocumentChange[], ): Promise<(view: ProfileDocumentView) => readonly ProfileDocumentWrite[]>

/** Addressable profile rows; nested Includes have independent configuration ownership.
 * @returns Active entries with unique profile patch ids.
 */
entries(): Entry[]

/** Read inherited and explicit profile values for the active entries.
 * @returns Detached layer values alongside their Loader entries.
 */
configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>

/** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
 * @param entry Current Loader entry, also used to detect replacement during the write.
 * @param change Derive a raw config from the current entry and its inherited layer.
 * @returns Fulfillment after Loader reconciliation completes.
 */
async edit( entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>, ): Promise<void>

/**
 * Edit managed documents with inspectable native publication facts; ordinary edit() retains its void API.
 * @param entry Current uniquely addressed profile entry.
 * @param change Derive once from detached raw values under native serialization.
 * @param operationId Optional caller-retained key for interruption recovery.
 * @returns Native publication receipt after successful Loader reconciliation.
 */
async editWithReceipt( entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>, operationId?: ProfileDocumentOperationId, ): Promise<ConfigurationEditReceipt>

/**
 * Reverse only still-matching owned raw fields from a persisted native operation.
 * @param receipt Original editor receipt; current unrelated changes survive the newer publication.
 * @param operationId Optional caller-retained reversal key for interruption recovery.
 * @returns The native reverse receipt after Loader reconciliation.
 */
async reverseEdit(receipt: Pick<ConfigurationEditReceipt, 'entry' | 'document'>, operationId?: ProfileDocumentOperationId): Promise<ConfigurationEditReceipt>

/** Apply the latest finalized native document view after operation inspection.
 * @returns The applied reference; a missing native binding or reconciliation failure rejects.
 */
async refreshDocuments(): Promise<ProfileDocumentViewReference>
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/**
 * Register an exact configuration path relative to this HMR instance's base directory.
 * @param filename Relative or absolute configuration path.
 * @param refresh Awaited callback for additions, changes and removals.
 * @returns Disposer that closes the watch and drains its active refresh.
 */
registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/** Read exact plugin-version exemptions saved in this profile.
 * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
 * record or file problem the reader rejected, which the caller reports instead of failing.
 */
@Remote listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }

/** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
 * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
 * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
 * @param enabled Whether to grant rather than revoke the exemption.
 * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
 * @returns Saved and runtime outcomes. Startup-only profiles require restart.
 */
@Remote setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult>

/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
 * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
 * @returns Package versions, manifest descriptions, the installable spec of profile dependencies, rows, optional
 * display metadata, activation selections, whether the installation offers the bundle, and removal availability.
 */
@Remote listBundles(): Promise<BundleInfo[]>

/** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
 * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
 */
@Remote async registries(): Promise<PluginRegistries>

/** Read what a spec names before installing it.
 * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
 * @param options The registry asked first.
 * @param signal Ends a registry lookup early.
 * @returns The package the spec names, or why it is refused.
 */
@Remote async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

/**
 * Install a package using the same pnpm implementation as dsh plugin. GitHub
 * repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts;
 * only network failures or timeouts stop installation, while pnpm owns authentication and transport fallback. A run
 * that fails, is cancelled, or adds a package without a bundle patch restores
 * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
 * @param spec One package spec, including local paths relative to the invocation directory.
 * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names,
 * the pending build scripts to allow for this profile before pnpm runs, and the registry asked first.
 * @returns Package-manager diagnostics, the registries asked, and the observed activation outcome.
 */
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Recover the result of an active installation without cancelling it.
 * @param requestId The id supplied when installation started.
 * @returns The installation's outcome after it settles, or null if no active request has that id.
 * Completed results are not retained; null establishes neither success nor cancellation.
 */
@Remote async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>

/** Stop an installation this manager owns and wait until its files are back.
 * @param requestId The id the installation was started with.
 * @returns `cancelled` once the Git check or pnpm exited and the files are restored, `too-late` once the bundle is being
 * applied, `not-running` for any other id.
 */
@Remote async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path; a selected name no
 * dependency holds is only deselected.
 * @param name Installed dependency or selected bundle name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxpluginregistryprobe--pluginregistryprobe"></a>

### `ctx.pluginRegistryProbe` — `PluginRegistryProbe`

Compares public registry responses on the Host; the Client owns the initial selection.

```ts cordis-catalog
/**
 * Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy.
 * Concurrent readers share a probe; a winner cancels and awaits the other request.
 * @returns the first registry with a successful response, or null when disabled or neither responds successfully; results are cached.
 * @throws rejects when the service has been unloaded.
 */
@Remote async fastest(): Promise<string | null>
```

Source: [`packages/client/ui-plugin-manager/src/index.ts`](../../packages/client/ui-plugin-manager/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="ctxprofiledocuments--profiledocuments"></a>

### `ctx.profileDocuments` — `ProfileDocuments`

Native authority supplied only after launcher enrollment; no provider is installed by this package.

```ts cordis-catalog
/**
 * Select bundle layers from this view's config manifest within the fixed admitted package graph.
 * @param view Exact admitted or derived candidate configuration view.
 * @returns Layers whose code/package identities still equal selection; unadmitted bundles refuse.
 */
bundleLayers(view: ProfileDocumentView): ProfileDocumentLayers

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
withWriteSnapshot( request: Readonly<{ operationId: ProfileDocumentOperationId; expected: ProfileDocumentViewReference }>, derive: (view: ProfileDocumentView) => readonly ProfileDocumentWrite[] | Promise<readonly ProfileDocumentWrite[]>, ): Promise<ProfileDocumentPublication>

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
```

Source: [`packages/boot/app-boot/src/profile-documents.ts`](../../packages/boot/app-boot/src/profile-documents.ts)

<a id="ctxprofilepackageoperations--profilepackageoperations"></a>

### `ctx.profilePackageOperations` — `ProfilePackageOperations`

A separately installed provider owns staging, exact archive admission, publication and recovery.

```ts cordis-catalog
/**
 * Preserve ordinary install/remove semantics in updater-owned staging, then coordinate package documents and code.
 * Script execution retains its explicit existing consent and side effects; updater rollback does not sandbox scripts.
 * @param request Fixed operation identity and expected native document selection.
 * @param policy Existing package workflow limits, registry policy, cancellation and diagnostic observers.
 * @returns Durable staging outcome; uncertain publication is failed with its operation id retained, never automatically retried.
 * Repeated operation ids inspect the persisted request and outcome; changed payloads refuse instead of rerunning scripts.
 */
run(request: ManagedPackageRequest, policy: ManagedPackagePolicy): Promise<ChangeResult>

/**
 * Read an existing durable operation without repeating package commands or publication.
 * @param operationId Previously submitted package operation.
 * @returns The retained result, or undefined when no operation was recorded.
 */
inspectOperation(operationId: ProfilePackageOperationId): Promise<ChangeResult | undefined>
```

Source: [`packages/boot/plugin-manager/src/managed-operations.ts`](../../packages/boot/plugin-manager/src/managed-operations.ts)

<a id="app-boot-events"></a>

### `app-boot/*` events

<a id="app-bootconfig-reload--emit"></a>

#### `app-boot/config-reload` — emit

Profile patches were reconciled into the running Loader tree: every entry update settled and no new inactive entry was introduced. Carries no diff; listeners re-read Loader entries.

```ts cordis-catalog
/**
 * Profile patches were reconciled into the running Loader tree: every entry update settled and no new
 * inactive entry was introduced. Carries no diff; listeners re-read Loader entries.
 * @mode emit
 */
'app-boot/config-reload'(): void
```

Source: [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrconfig-update-failed--parallel"></a>

#### `hmr/config-update-failed` — parallel

A watched configuration refresh failed.

```ts cordis-catalog
/** A watched configuration refresh failed.
 * @mode parallel
 * @param filename Absolute configuration path.
 * @param error Normalized refresh failure.
 */
'hmr/config-update-failed'(filename: string, error: Error): Promise<void> | void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="plugin-manager-events"></a>

### `plugin-manager/*` events

<a id="plugin-managerchanged--emit"></a>

#### `plugin-manager/changed` — emit

The profile's plugins, bundles, or composition changed: a manager operation completed. A patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing here.

```ts cordis-catalog
/**
 * The profile's plugins, bundles, or composition changed: a manager
 * operation completed. A patch generation applied outside the manager,
 * by HMR's watcher after a CLI or hand edit, announces nothing here.
 * @mode emit
 * @param change - what changed.
 */
'plugin-manager/changed'(change: PluginChange): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-log--emit"></a>

#### `plugin-manager/install-log` — emit

One chunk of a pnpm run's output, streamed as the run produces it.

```ts cordis-catalog
/**
 * One chunk of a pnpm run's output, streamed as the run produces it.
 * @mode emit
 * @param chunk - the chunk and the run it belongs to.
 */
'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-state--emit"></a>

#### `plugin-manager/install-state` — emit

An installation moved between its Host phases. `installing` is announced once per registry the installation asks, with the attempt's registry and position; `cancelling` and `applying` once.

```ts cordis-catalog
/**
 * An installation moved between its Host phases. `installing` is announced once per registry the
 * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
 * @mode emit
 * @param progress - the installation's request id and phase, with the attempt while installing.
 */
'plugin-manager/install-state'(progress: PluginInstallProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
