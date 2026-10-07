# Profile 管理

[English](boot.md) | 中文

[boot 包组](../../packages/boot/README.zh.md)负责 launcher 提供的 profile 访问与插件管理器。[插件管理器](../../packages/boot/plugin-manager/README.zh.md)文档说明持久化、重载与包操作行为。

## 管理记录

`PluginEntryId` 标识一个 Loader 条目；调用方从 `listPlugins` 获取，不自行拼接 patch id。

`PluginInfo` 包含模块标识、实际启停状态、fiber 阶段和可选的展示 `meta`，以及唯一的 `patchId` 或 `readOnlyReason`。

`BundleInfo` 包含包名、可选的安装版本、组合层选择状态、删除可用性、可选的解析错误；由 profile 自身依赖提供、且安装不提供的组合包还带有 `source`，即该依赖在 `pnpm add` 中可用的 spec。它的可选 `meta` 与各行的 `BundleRowInfo.meta` 包含展示文本或元信息诊断；Client 在渲染时选择语言。

`InstallBundleOptions.enabled` 默认为 true，false 表示安装但不选择组合包层。`approvedBuilds` 在安装前向指定的待审批包名授予持久脚本权限。`registry` 指定首先询问的注册表；缺省为配置的那个。

`PluginRegistries` 携带配置的第一个注册表（`null` 即 pnpm 自身配置指定的那个）、随后依次询问的备选注册表，以及 `resolved`——pnpm 自身配置指向的 URL，未读到时为 `null`。`InspectOptions.registry` 指定一次查询首先询问的注册表。

`ChangeResult.changed` 报告磁盘修改，独立于 `application`：`applied`、`restart-required`、`overridden` 或 `failed`。可选的 `error` 包含可本地化的错误码和外部诊断。`packageResult` 记录 pnpm 退出码、有界输出、截断标志及完整诊断日志路径；当管理器终止了一个停止打印的运行，还记录 `timedOut`。被终止的运行不论信号留下什么退出状态都归类为 `timeout`，因此安装与删除都报告失败而非成功，也不会再询问下一个注册表。`pendingBuilds` 列出整个 profile 尚未决定的包；`approvedBuilds` 记录本次操作授予权限的包名；`registries` 按顺序列出一次安装问过的注册表；`bundle` 与 `version` 给出完成的安装新增的包及其清单版本；`failedAt` 说明最后一次失败的运行连不上的是所问的注册表，还是 git 或 tarball spec 自身拉取的主机。

## 托管文档视图

`ProfileDocuments` 是由启动器准入、供 [App boot](../../packages/boot/app-boot/README.zh.md) 使用的权威文档访问接口。`ProfileDocumentViewReference` 标识完整且不可变的期望配置；`ProfileDocumentReference` 标识单个文档版本或已记录的缺失状态。`ProfileDocumentSelection` 将逻辑 profile、home 及其已准入的代码和包文档标识固定在一起。这些引用不授予存储访问权限，期望视图也不表示 Loader 已应用该配置。

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

`ProfileDocumentSnapshot` 区分原始文本存在与明确缺失；不在已准入读取集合内的路径会抛错，不会被当作缺失文档。`ProfileDocumentLayers` 将已解析的[组合包层](../../packages/boot/app-boot/src/profile.ts)绑定到视图所指定的准确代码和包文档选择。`refresh()` 准入期望视图，消费方则另行记录 Loader 协调成功的结果。

## 文档发布回执

`ProfileDocumentOperationId` 是调用方保留的幂等键。每个 `ProfileDocumentWrite` 指定已准入的逻辑路径、预期的不可变文档引用，以及替换文本或明确缺失状态。`withWriteSnapshot` 在原生串行化期间调用一次派生函数，并在发布前重新检查完整的预期视图。回执产生前抛错表示没有发布；晚发或不确定的结果保留回执，供 `inspectOperation` 检查，而不是自动重试。

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

`ProfileDocumentReceipt` 分别报告发布、验证和持久性，与 Loader 应用结果相互独立。`ProfileDocumentPublication` 在后继视图可用时保留它，并保留任何晚发错误。只有发布为 `published`、验证为 `verified`、持久性为 `confirmed`、`after` 与返回的视图匹配且没有错误时，消费方才接受成功结果。

## 配置编辑与撤销

[Config Editor](../../packages/boot/config-editor/README.zh.md) 仅在原生发布完成且 Loader 协调成功后返回 `ConfigurationEditReceipt`。其 `entry` 选择器包含原始 Loader 行的 `id` 和 `name`。`ConfigurationDocumentChange` 提供配置项及原始配置派生函数（`Raw` 即 `Record<string, unknown>`），或待撤销的准确持久化回执。

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

`createDocumentDerivation` 准备有序编辑及带回执的撤销操作，不发布也不协调它们；返回的派生函数在调用方的原生写快照中运行一次。撤销要求已验证且持久化的发布历史，仅还原仍匹配的自有原始字段，保留当前无关编辑。配置项缺失或有歧义、fiber 被替换、回执过期或 schema 校验失败时，编辑会被拒绝。

## 托管包操作

`ProfilePackageOperations` 是启动器绑定、供 [Plugin Manager](../../packages/boot/plugin-manager/README.zh.md) 使用的提供方。`ManagedPackageRequest` 将安装、删除或包命令绑定到持久的 `ProfilePackageOperationId` 及预期文档视图。复用操作 id 会检查其已保存的请求和结果；载荷发生变化时会拒绝，不会重新运行包脚本。

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

`ManagedPackagePolicy` 在 [PackageOperationOptions](../../packages/boot/plugin-manager/src/operations.ts) 的基础上增加注册表选择、GitHub 连接超时和进度观察。现有执行、取消及构建脚本同意规则仍然有效；更新器回滚不会限制或撤销另行获准脚本的副作用。发布结果不确定时返回失败的 `ChangeResult` 并保留操作 id；`inspectOperation` 读取其持久结果，不重复包命令或发布。

## Carrier 准入值

`ctx.runtimeAdmission` 是固定 carrier 提供的启动值，不是独立挂载的服务。其 [RuntimeAdmission](../../packages/boot/app-boot/src/runtime-admission.ts) 联合类型报告 `unenrolled`、`blocked` 或 `managed`；上下文值排除 `blocked`，因为准入被阻止时应用无法启动。`unenrolled` 要求确认运行时管理不存在。`managed` 为当前进程保留已准入的代码图、文档访问接口和 carrier 生命周期回调。

carrier 在导入业务代码前取得准入结果，并在插件挂载前提供所保留的结果。`requireManagedRuntimeAdmission` 只接受已准入当前进程的不透明结果，不接受调用方构造的同字段对象。[App boot 包](../../packages/boot/app-boot/README.zh.md) 负责基于该准入状态进行组合。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
