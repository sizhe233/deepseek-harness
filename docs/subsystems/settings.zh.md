# 插件配置表单

[English](settings.md) | 中文

[设置服务](../../packages/settings/settings/README.zh.md) 从活动 profile 条目投影 volatile Config 字段。[配置编辑器](../../packages/boot/config-editor/README.zh.md) 通过 Cordis patch 持久化编辑。业务消费者对自己的 Config 引用调用 `.get()`。

## 标识与值

表单命名空间是当前 profile 中可唯一定位条目的本地 id。多个插件实例在条目 id 不同时拥有独立表单。普通字段被排除。描述符包含实际值、继承值、显式 profile 覆盖值和乐观修订号。

## 编辑

`update` 合并提交的字段。`replace` 先将即时字段重置为继承配置，再应用提交的字段。`mutate` 操作独立路径，保留客户端响应中未包含的秘密值。每次写入都会验证完整 Config，并在持久化前拒绝过期修订号。

`settings/document-updated` 在 Loader 配置变化后使表单描述符失效。这是 UI 通知；消费者仅在需要刷新注册信息时使用 `loader/volatile-update`。

## 托管候选

`createDocumentDerivation(changes, expectedView)` 为调用方现有的原生文档写快照准备一次性派生函数。每个目标都带有描述符修订号；返回写入前会重新检查原生视图、条目修订号及实际 Loader fiber。输入是独立的 JSON 数据副本。值和修改路径不能引入可执行 YAML 表达式标记；路径不能进入既有原始表达式内部，但仍可整体替换或重置表达式。ConfigEditor 仍负责 YAML 序列化与完整 Config 验证。发布、协调及迁移确认仍是调用方的独立操作。

每个命名空间只出现一次。`update`、`replace` 和 `mutate` 保留普通表单语义。`import` 将调用方选定的旧版 section 映射到 `ns`，按字段是否存在而非值比较保留显式 Profile 字段，并补齐缺失的嵌套子字段。显式数组整体替代旧版数组。不推断别名、源路径或迁移账本。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [ProfileDocumentView](boot.zh.md) · [ProfileDocumentViewReference](boot.zh.md) · [ProfileDocumentWrite](boot.zh.md)

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
