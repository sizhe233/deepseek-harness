/** Host-side configuration control for the generic MCP Loader entries. */

import { Context } from '@deepseek-ai/cordis'
import type { FiberState, Volatile } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsForms, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy } from './reconnect-policy.ts'
import type {
  McpConfigurationEntry, McpConfigurationPatch, McpConfigurationSnapshot, McpFiberPhase,
  McpReconnectPatch, McpReconnectView, McpSecretKey, McpTransport,
} from './types.ts'

/** Exact Loader module owned by this configuration surface. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Settings namespace used for UI-owned MCP overrides. */
export const MCP_CONFIGURATION_NAMESPACE = 'mcp-configuration' as SettingsNamespace

// Cordis exposes these states as a const enum across the package boundary.
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
} as const

interface StoredMcpOverride {
  enabled?: boolean
  transport?: McpTransport
  serverName?: string
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: McpReconnectPatch
  env?: Record<string, string>
  envUnset?: string[]
  headers?: Record<string, string>
  headersUnset?: string[]
}

interface StoredMcpOverrides {
  entries: Record<string, StoredMcpOverride>
}

interface EntryConfiguration {
  config: Record<string, unknown>
  disabled: Entry['options']['disabled']
}

/** Raw configuration accepted by the standalone MCP control-plane entry. */
export interface McpConfigurationInput {
  /** Saved sparse overrides keyed by full Loader entry ids. */
  entries?: Record<string, StoredMcpOverride>
}

/** Live override map supplied by the Loader's volatile configuration. */
export interface McpConfigurationConfig {
  /** Read before reconciling one bridge or accepting an editor mutation. */
  entries: Volatile<Record<string, StoredMcpOverride>>
}

const ReconnectPatchSchema = s.object({
  enabled: s.boolean(),
  initialDelayMs: s.number(),
  maxDelayMs: s.number(),
  maxAttempts: s.number(),
})

// Single-branch unions preserve omitted collections instead of materializing
// empty overrides. Secret values persist in the profile, but structural
// redaction removes them from settings.describe before that surface reaches a
// browser. The MCP Remote below exposes only key names and configured flags.
const StoredOverrideSchema: s<StoredMcpOverride> = s.object({
  enabled: s.boolean(),
  transport: s.union(['stdio', 'streamable-http'] as const),
  serverName: s.string(),
  command: s.string(),
  args: s.union([s.array(String)]),
  cwd: s.string(),
  url: s.string(),
  toolCallTimeoutMs: s.number(),
  failOnStartupError: s.boolean(),
  reconnect: s.union([ReconnectPatchSchema]),
  env: s.union([s.dict(s.string().role('secret'))]),
  envUnset: s.union([s.array(String)]),
  headers: s.union([s.dict(s.string().role('secret'))]),
  headersUnset: s.union([s.array(String)]),
})

/** Volatile profile configuration; the custom MCP editor owns its presentation. */
export const McpOverridesSchema: s<McpConfigurationInput, McpConfigurationConfig> = s.object({
  entries: s.dict(StoredOverrideSchema).default({}).volatile(),
})

const RESET_FIELDS = new Set([
  'enabled', 'transport', 'serverName', 'command', 'args', 'cwd', 'url',
  'toolCallTimeoutMs', 'failOnStartupError', 'reconnect', 'env', 'headers',
])
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_PATCH_STRING = 16 * 1024
const MAX_PATCH_ARGS = 256
const MAX_PATCH_KEYS = 128

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type McpConfigurationErrorCode =
  | 'mcp/bad-request'
  | 'mcp/read-only'
  | 'mcp/conflict'
  | 'mcp/not-found'
  | 'mcp/write-failed'

type McpConfigurationErrorDetails = { readonly entryId?: string }

function failure(
  code: McpConfigurationErrorCode,
  message: string,
  details: McpConfigurationErrorDetails = {},
): RemoteError<McpConfigurationErrorCode> {
  return new RemoteError(code, message, details)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function objectKeys(value: unknown): McpSecretKey[] {
  return Object.entries(record(value))
    .filter(([, entry]) => entry !== undefined && entry !== null)
    .map(([key, entry]) => ({ key, configured: typeof entry !== 'string' || entry.length > 0 }))
}

/** Only bridge entries belong to the editable inventory; the gateway has its own module. */
function isMcpBridgeEntry(entry: Entry): boolean {
  return entry.options.name === MCP_CLIENT_MODULE && !entry.options.group
}

function phaseOf(entry: Entry): McpFiberPhase {
  const state: unknown = entry.fiber?.state
  switch (state) {
    case 0: return 'pending'
    case 1: return 'loading'
    case 2: return 'active'
    case 3: return 'failed'
    case 5: return 'unloading'
    default: return null
  }
}

async function settleEntry(entry: Entry): Promise<void> {
  // A disposed failed fiber retains its startup error. Await disposal itself
  // when disabling, rather than rethrowing an error from the old connection.
  if (entry.disabled) await entry.fiber?.dispose()
  else await entry.fiber?.await()
}

function configOf(entry: Entry): Record<string, unknown> {
  const resolved = record(entry.fiber?.config)
  return Object.keys(resolved).length > 0 ? resolved : record(entry.options.config)
}

function reconnectOf(config: Record<string, unknown>): McpReconnectView {
  const reconnect = record(config.reconnect)
  return {
    enabled: bool(reconnect.enabled, RECONNECT_DEFAULTS.enabled),
    initialDelayMs: number(reconnect.initialDelayMs, RECONNECT_DEFAULTS.initialDelayMs),
    maxDelayMs: number(reconnect.maxDelayMs, RECONNECT_DEFAULTS.maxDelayMs),
    maxAttempts: number(reconnect.maxAttempts, RECONNECT_DEFAULTS.maxAttempts),
  }
}

function projectEntry(entry: Entry, revision: number): McpConfigurationEntry {
  const config = configOf(entry)
  const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const args = Array.isArray(config.args) ? config.args.filter((value): value is string => typeof value === 'string') : []
  const serverName = text(config.serverName) ?? entry.options.id
  const command = text(config.command)
  const cwd = text(config.cwd)
  const url = text(config.url)
  return {
    entryId: entry.id,
    moduleName: entry.options.name,
    enabled: !entry.disabled,
    fiberPhase: phaseOf(entry),
    transport,
    serverName,
    ...command === undefined ? {} : { command },
    args,
    ...cwd === undefined ? {} : { cwd },
    ...url === undefined ? {} : { url },
    env: objectKeys(config.env),
    headers: objectKeys(config.headers),
    toolCallTimeoutMs: number(config.toolCallTimeoutMs, 60_000),
    failOnStartupError: bool(config.failOnStartupError, false),
    reconnect: reconnectOf(config),
    revision,
  }
}

function patchRecord(value: unknown, method: string): McpConfigurationPatch {
  const parsed = z.object({
    enabled: z.boolean().optional(),
    transport: z.enum(['stdio', 'streamable-http']).optional(),
    serverName: z.string().max(MAX_PATCH_STRING).optional(),
    command: z.string().max(MAX_PATCH_STRING).optional(),
    args: z.array(z.string().max(MAX_PATCH_STRING)).max(MAX_PATCH_ARGS).optional(),
    cwd: z.string().max(MAX_PATCH_STRING).optional(),
    url: z.string().max(MAX_PATCH_STRING).optional(),
    toolCallTimeoutMs: z.number().int().positive().optional(),
    failOnStartupError: z.boolean().optional(),
    reconnect: z.object({
      enabled: z.boolean().optional(),
      initialDelayMs: z.number().positive().optional(),
      maxDelayMs: z.number().positive().optional(),
      maxAttempts: z.number().int().positive().optional(),
    }).strict().optional(),
    env: z.object({
      set: z.record(z.string().regex(ENV_KEY_PATTERN), z.string().max(MAX_PATCH_STRING)).optional(),
      unset: z.array(z.string().regex(ENV_KEY_PATTERN)).max(MAX_PATCH_KEYS).optional(),
    }).strict().optional(),
    headers: z.object({
      set: z.record(z.string().min(1).max(256), z.string().max(MAX_PATCH_STRING)).optional(),
      unset: z.array(z.string().min(1).max(256)).max(MAX_PATCH_KEYS).optional(),
    }).strict().optional(),
    reset: z.array(z.string()).max(32).optional(),
  }).strict().safeParse(value)
  if (!parsed.success) throw failure('mcp/bad-request', `invalid MCP configuration patch (${method})`)
  for (const key of parsed.data.reset ?? []) {
    if (!RESET_FIELDS.has(key)) throw failure('mcp/bad-request', `unsupported MCP reset field "${key}"`)
  }
  return parsed.data as McpConfigurationPatch
}

/** Delete one known override field without resorting to dynamic property access. */
function resetOverrideField(next: StoredMcpOverride, key: string): void {
  switch (key) {
    case 'enabled': delete next.enabled; break
    case 'transport': delete next.transport; break
    case 'serverName': delete next.serverName; break
    case 'command': delete next.command; break
    case 'args': delete next.args; break
    case 'cwd': delete next.cwd; break
    case 'url': delete next.url; break
    case 'toolCallTimeoutMs': delete next.toolCallTimeoutMs; break
    case 'failOnStartupError': delete next.failOnStartupError; break
    case 'reconnect': delete next.reconnect; break
    case 'env': delete next.env; delete next.envUnset; break
    case 'headers': delete next.headers; delete next.headersUnset; break
  }
}

function mergeOverride(previous: StoredMcpOverride | undefined, patch: McpConfigurationPatch): StoredMcpOverride {
  const next: StoredMcpOverride = clone(previous ?? {})
  for (const key of patch.reset ?? []) {
    resetOverrideField(next, key)
  }
  for (const key of [
    'enabled', 'transport', 'serverName', 'command', 'args', 'cwd', 'url',
    'toolCallTimeoutMs', 'failOnStartupError',
  ] as const) {
    const value = patch[key]
    if (value !== undefined) next[key] = clone(value) as never
  }
  if (patch.reconnect !== undefined) next.reconnect = { ...next.reconnect, ...patch.reconnect }
  for (const kind of ['env', 'headers'] as const) {
    const change = patch[kind]
    if (change === undefined) continue
    const values = kind === 'env' ? { ...(next.env ?? {}) } : { ...(next.headers ?? {}) }
    const removed = new Set(kind === 'env' ? (next.envUnset ?? []) : (next.headersUnset ?? []))
    for (const key of change.unset ?? []) {
      Reflect.deleteProperty(values, key)
      removed.add(key)
    }
    for (const [key, value] of Object.entries(change.set ?? {})) {
      values[key] = value
      removed.delete(key)
    }
    if (kind === 'env') {
      next.env = values
      next.envUnset = [...removed]
    } else {
      next.headers = values
      next.headersUnset = [...removed]
    }
  }
  return next
}

function mergeConfig(base: Record<string, unknown>, override: StoredMcpOverride | undefined): Record<string, unknown> {
  const next = clone(base)
  if (override === undefined) return next
  for (const key of [
    'transport', 'serverName', 'command', 'args', 'cwd', 'url',
    'toolCallTimeoutMs', 'failOnStartupError',
  ] as const) {
    if (override[key] !== undefined) next[key] = clone(override[key])
  }
  if (override.reconnect !== undefined) next.reconnect = { ...record(next.reconnect), ...clone(override.reconnect) }
  for (const kind of ['env', 'headers'] as const) {
    const overrideValues = kind === 'env' ? override.env : override.headers
    const unset = kind === 'env' ? override.envUnset : override.headersUnset
    if (overrideValues === undefined && unset === undefined) continue
    const values = { ...record(next[kind]), ...(overrideValues ?? {}) }
    for (const key of unset ?? []) Reflect.deleteProperty(values, key)
    next[kind] = values
  }
  // Switching transport must not leave fields from the other discriminant in
  // the candidate. Removing them also keeps the persisted override independent
  // from whatever defaults the active branch supplies.
  if (next.transport === 'stdio') {
    delete next.url
    delete next.headers
  } else if (next.transport === 'streamable-http') {
    delete next.command
    delete next.args
    delete next.cwd
    delete next.env
  }
  return next
}

function validateCandidate(config: Record<string, unknown>, entryId: string): void {
  const transport = config.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw failure('mcp/bad-request', 'MCP transport must be stdio or streamable-http', { entryId })
  }
  const serverName = text(config.serverName)
  if (serverName === undefined || !SERVER_NAME_PATTERN.test(serverName)) {
    throw failure('mcp/bad-request', 'MCP serverName is invalid', { entryId })
  }
  if (transport === 'stdio') {
    const command = text(config.command)
    if (command === undefined || command.trim() === '') {
      throw failure('mcp/bad-request', 'MCP stdio command must not be empty', { entryId })
    }
  } else {
    const url = text(config.url)
    if (url === undefined) throw failure('mcp/bad-request', 'MCP HTTP URL is required', { entryId })
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw failure('mcp/bad-request', 'MCP HTTP URL must use http or https', { entryId })
    }
  }
  const timeout = config.toolCallTimeoutMs
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw failure('mcp/bad-request', 'MCP toolCallTimeoutMs must be a positive integer', { entryId })
  }
  try {
    resolveReconnectPolicy(record(config.reconnect), `mcp-client(${serverName}): reconnect`)
  } catch {
    throw failure('mcp/bad-request', 'MCP reconnect policy is invalid', { entryId })
  }
}

/** Host Remote that edits existing MCP entries and reconfigures them live. */
export class McpConfigurationGateway extends TypertRemoteService {
  static inject = ['loader']
  static Config = McpOverridesSchema

  private settings: SettingsForms | undefined
  private readonly entryId: string | undefined
  private overrides: StoredMcpOverrides = { entries: {} }
  private revision = 0
  private disposed = false
  private tail: Promise<void> = Promise.resolve()
  private readonly baselines = new Map<string, EntryConfiguration>()
  private readonly applied = new Map<string, EntryConfiguration>()
  private readonly waitingForStart = new Set<string>()
  private readonly ownUpdates = new WeakSet<object>()

  constructor(ctx: Context, config: McpConfigurationConfig) {
    super(ctx, 'mcpConfiguration')
    this.entryId = ctx.fiber.entry?.options.id
    this.overrides = { entries: clone(config.entries.get()) as StoredMcpOverrides['entries'] }
    const readOverride = (entryId: string) => this.overrides.entries[entryId]
    const ownUpdates = this.ownUpdates
    ctx.on('internal/config', function (_config, next) {
      const resolved: unknown = next()
      const entry = this.entry
      if (entry === undefined || !isMcpBridgeEntry(entry) || this.parent.fiber.entry === entry
        || ownUpdates.has(record(this._config))) return resolved
      const override = readOverride(entry.id)
      // Include/HMR can reapply the profile after the editor has restored its
      // overrides. Apply the settings layer at the native resolution point so
      // that a competing profile refresh cannot restore stale live values.
      return override === undefined ? resolved : mergeConfig(record(resolved), override)
    }, { global: true })
    const syncOverrides = (): void => {
      this.overrides = { entries: clone(config.entries.get()) as StoredMcpOverrides['entries'] }
      void this.enqueue(() => this.reconcile())
    }
    ctx.on('loader/volatile-update', syncOverrides)
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
      settingsCtx.effect(() => () => { this.settings = undefined }, 'mcp-configuration.settings')
    })
    ctx.effect(() => {
      const offEntry = ctx.on('loader/entry-init', () => { void this.enqueue(() => this.reconcile()) })
      const offConfig = ctx.on('loader/config-update', () => { void this.enqueue(() => this.reconcile()) })
      const offStatus = ctx.on('internal/status', (fiber) => {
        if (fiber.state !== FIBER_STATE.ACTIVE && fiber.state !== FIBER_STATE.FAILED) return
        // Only resume an initialization we actually deferred. Reacting to our
        // own failed reload and rollback would repeatedly retry the same bad
        // stored override with no backoff.
        if (this.waitingForStart.size === 0) return
        const entry = [...ctx.loader.entries()].find(candidate => candidate.fiber === fiber
          && this.waitingForStart.has(candidate.id))
        if (entry === undefined) return
        this.waitingForStart.delete(entry.id)
        void this.enqueue(() => this.reconcile())
      })
      return () => { offEntry(); offConfig(); offStatus() }
    }, 'mcp-configuration.loader-events')
    ctx.effect(() => async () => { this.disposed = true; await this.tail }, 'mcp-configuration.lifecycle')
    void this.enqueue(() => this.reconcile())
  }

  /**
   * Read the current MCP entries without returning any secret values.
   * @returns redacted entries and the current configuration revision.
   */
  @Remote('list')
  async list(): Promise<McpConfigurationSnapshot> {
    await this.enqueue(() => this.reconcile())
    return this.snapshot()
  }

  /**
   * Persist one patch, then wait for that entry's old connection to be replaced.
   * @param entryId - exact Loader entry to edit.
   * @param patchInput - fields to replace, remove, or reset.
   * @param expectedRevision - revision read before the edit.
   * @returns redacted inventory after the change has been saved.
   */
  @Remote('update')
  async update(entryId: string, patchInput: McpConfigurationPatch, expectedRevision: number): Promise<McpConfigurationSnapshot> {
    return this.enqueue(async () => {
      const patch = patchRecord(patchInput, 'mcpConfiguration.update')
      const settings = this.settings
      if (settings === undefined || this.entryId === undefined || !settings.writable) throw failure('mcp/read-only', 'MCP configuration is read-only in this deployment')
      const actualRevision = this.currentRevision()
      if (expectedRevision !== actualRevision) {
        throw failure('mcp/conflict', 'MCP configuration changed elsewhere; refresh before saving', { entryId })
      }
      const entry = this.find(entryId)
      if (entry === undefined) throw failure('mcp/not-found', 'MCP entry is no longer present', { entryId })
      if ((!entry.disabled && entry.fiber === undefined)
        || entry.fiber?.state === FIBER_STATE.PENDING || entry.fiber?.state === FIBER_STATE.LOADING) {
        throw failure('mcp/conflict', 'MCP connection is still starting; refresh before saving', { entryId })
      }
      this.waitingForStart.delete(entry.id)
      const previousConfig = clone(record(entry.options.config))
      // Keep the raw disabled option for rollback. It may be a `!!js`
      // expression; coercing it to Boolean would permanently replace a
      // profile expression with `true` after a failed settings write.
      const previousDisabled = entry.options.disabled
      const previousEntries = clone(this.overrides.entries)
      const baseline = this.captureBaseline(entry)
      const previousOverride = this.overrides.entries[entryId]
      const nextOverride = mergeOverride(previousOverride, patch)
      const nextEntries = clone(this.overrides.entries)
      if (Object.keys(nextOverride).length === 0) Reflect.deleteProperty(nextEntries, entryId)
      else nextEntries[entryId] = nextOverride
      // Validate the resolved view so profile `!!js` expressions remain valid
      // while the raw baseline is retained for Loader write-back.
      validateCandidate(mergeConfig(configOf(entry), nextOverride), entryId)

      // Disabling cannot fail activation. Commit its override before teardown,
      // so ConfigEditor's pre-write reload sees any existing failed fiber as
      // unchanged instead of recreating it from the inherited enabled row.
      const deferDisable = nextOverride.enabled === false
      try {
        if (!deferDisable) await this.applyEntry(entry, nextOverride, baseline)
        this.overrides = { entries: nextEntries }
        await this.persist(nextEntries, actualRevision)
      } catch {
        this.overrides = { entries: previousEntries }
        if (deferDisable) throw failure('mcp/write-failed', 'MCP configuration was not saved; the previous connection was kept', { entryId })
        try {
          await entry.update({
            config: previousConfig,
            disabled: previousDisabled ?? null,
          })
          await settleEntry(entry)
          this.applied.delete(entry.id)
        } catch (rollbackError) {
          this.applied.delete(entry.id)
          this.ctx.logger.error('mcp-configuration: runtime rollback failed for %s', entryId, rollbackError)
          throw failure('mcp/write-failed', 'MCP configuration was not saved and the previous connection could not be restored; refresh before retrying', { entryId })
        }
        throw failure('mcp/write-failed', 'MCP configuration was not saved; the previous connection was restored', { entryId })
      }
      // Profile persistence can reapply the inherited bridge rows before the
      // volatile control map commits. Settle those overrides before replying.
      await this.reconcile()
      this.revision = this.currentRevision()
      return this.snapshot()
    })
  }

  private find(entryId: string): Entry | undefined {
    try {
      const entry = this.ctx.loader.resolve(entryId)
      return isMcpBridgeEntry(entry) ? entry : undefined
    } catch {
      return undefined
    }
  }

  private currentRevision(): number {
    const descriptor = this.settings?.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === this.entryId)
    return descriptor?.revision ?? this.revision
  }

  private snapshot(): McpConfigurationSnapshot {
    const revision = this.currentRevision()
    this.revision = revision
    return {
      writable: this.entryId !== undefined && this.settings?.writable === true,
      revision,
      entries: [...this.ctx.loader.entries()]
        .filter(isMcpBridgeEntry)
        .map(entry => projectEntry(entry, revision)),
    }
  }

  private captureBaseline(entry: Entry): EntryConfiguration {
    const current = record(entry.options.config)
    const previous = this.applied.get(entry.id)
    let baseline = this.baselines.get(entry.id)
    if (baseline === undefined || previous === undefined || !equal(current, previous.config)
      || !equal(entry.options.disabled ?? null, previous.disabled ?? null)) {
      baseline = { config: clone(current), disabled: clone(entry.options.disabled) }
      this.baselines.set(entry.id, baseline)
    }
    return baseline
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const entries = [...this.ctx.loader.entries()]
    const ids = new Set(entries.map(entry => entry.id))
    for (const id of this.waitingForStart) if (!ids.has(id)) this.waitingForStart.delete(id)
    for (const entry of entries) {
      if (!isMcpBridgeEntry(entry)) continue
      // Entry.update cannot replace a fiber while its original start is still
      // committing. Resume from internal/status after that start has settled.
      if ((!entry.disabled && entry.fiber === undefined)
        || entry.fiber?.state === FIBER_STATE.PENDING || entry.fiber?.state === FIBER_STATE.LOADING) {
        this.waitingForStart.add(entry.id)
        continue
      }
      this.waitingForStart.delete(entry.id)
      const override = this.overrides.entries[entry.id]
      const baseline = this.captureBaseline(entry)
      // The initial Loader activation may already have consumed the saved override.
      // A failed connection retries only after its effective configuration changes.
      if (entry.fiber?.state === FIBER_STATE.FAILED
        && (override?.enabled === undefined || entry.disabled === !override.enabled)
        && equal(configOf(entry), mergeConfig(configOf(entry), override))) continue
      try {
        await this.applyEntry(entry, override, baseline)
      } catch (error) {
        this.ctx.logger.warn('mcp-configuration: override could not be applied for %s', entry.id, error)
      }
    }
  }

  private async applyEntry(entry: Entry, override: StoredMcpOverride | undefined, base: EntryConfiguration): Promise<void> {
    const candidate = mergeConfig(base.config, override)
    validateCandidate(mergeConfig(configOf(entry), override), entry.id)
    const desiredDisabled = override?.enabled === undefined ? base.disabled : !override.enabled
    const previous = this.applied.get(entry.id)
    if (previous !== undefined && equal(previous.config, candidate) && equal(previous.disabled ?? null, desiredDisabled ?? null)
      && equal(record(entry.options.config), candidate)
      && equal(entry.options.disabled ?? null, desiredDisabled ?? null)) return
    const options = { config: candidate, disabled: desiredDisabled ?? null }
    const priorConfig = record(entry.options.config)
    const restoringStoredOverride = equal(override, this.overrides.entries[entry.id])
    this.ownUpdates.add(candidate)
    if (restoringStoredOverride) this.ownUpdates.add(priorConfig)
    try {
      await entry.update(options)
      await settleEntry(entry)
    } finally {
      this.ownUpdates.delete(candidate)
      if (restoringStoredOverride) this.ownUpdates.delete(priorConfig)
    }
    this.applied.set(entry.id, { config: clone(candidate), disabled: desiredDisabled })
  }

  private async persist(entries: Record<string, StoredMcpOverride>, expectedRevision: number): Promise<void> {
    const settings = this.settings
    if (settings === undefined || this.entryId === undefined) throw new Error('settings unavailable')
    await settings.mutate(
      this.entryId,
      [{ op: 'set', path: ['entries'], value: entries }],
      expectedRevision,
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
}

/** Standalone configuration service; it does not import transport or process code. */
export default McpConfigurationGateway
