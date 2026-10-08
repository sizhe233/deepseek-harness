/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmCompactOptions,
  LlmCompactionResult,
  LlmJsonValue,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { compactionItemOf, injectCompactionItem, toPiContext } from './context.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'

const RESPONSES_APIS = new Set<Api>([
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
])
const OPENAI_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode'])

function isGptModel(model: string): boolean {
  return /^gpt(?:[-_.]|$)/i.test(model)
}

function isJsonValue(value: unknown): value is LlmJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function readCompactionItem(value: unknown): LlmCompactionResult['item'] | undefined {
  if (!isJsonValue(value) || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, LlmJsonValue>
  return (record.type === 'compaction' || record.type === 'compaction_summary') && typeof record.encrypted_content === 'string'
    ? record as LlmCompactionResult['item']
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function compactUsage(value: unknown): LlmCompactionResult['usage'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const inputTokens = positiveNumber(usage.input_tokens)
  const outputTokens = positiveNumber(usage.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = positiveNumber(usage.total_tokens)
  const inputDetails = usage.input_tokens_details
  const outputDetails = usage.output_tokens_details
  const cacheReadTokens = typeof inputDetails === 'object' && inputDetails !== null && !Array.isArray(inputDetails)
    ? positiveNumber((inputDetails as Record<string, unknown>).cached_tokens)
    : undefined
  const reasoningTokens = typeof outputDetails === 'object' && outputDetails !== null && !Array.isArray(outputDetails)
    ? positiveNumber((outputDetails as Record<string, unknown>).reasoning_tokens)
    : undefined
  return {
    inputTokens: cacheReadTokens === undefined ? inputTokens : Math.max(0, inputTokens - cacheReadTokens),
    outputTokens,
    ...totalTokens === undefined ? {} : { totalTokens },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

interface ParsedCompactResponse {
  item?: LlmCompactionResult['item']
  usage?: NonNullable<LlmCompactionResult['usage']>
}

function unsupportedCompactStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 405 || status === 415 || status === 501
}

function unsupportedCompactBody(status: number, body: string): boolean {
  if (!unsupportedCompactStatus(status)) return false
  if (status !== 400) return true
  const patterns = [
    'unsupported',
    'not support',
    'unknown endpoint',
    'model_not_found',
    'unknown provider for model',
    'compact.{0,24}(not found|unsupported|unavailable)',
    'method.{0,24}(not allowed|unsupported)',
  ]
  return new RegExp(patterns.join('|'), 'i').test(body)
}

function parsedCompactResponse(value: unknown): ParsedCompactResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const output = record.output
  const response = record.response
  const responseRecord = typeof response === 'object' && response !== null && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined
  const outputItems = Array.isArray(output) ? output
    : responseRecord !== undefined && Array.isArray(responseRecord.output) ? responseRecord.output
      : []
  const item = (record.type === 'response.output_item.done' ? readCompactionItem(record.item) : undefined)
    ?? outputItems.map(readCompactionItem).find((candidate): candidate is LlmCompactionResult['item'] => candidate !== undefined)
  const usage = compactUsage(record.usage ?? responseRecord?.usage)
  return { ...item === undefined ? {} : { item }, ...usage === undefined ? {} : { usage } }
}

function parseCompactResponseText(raw: string): ParsedCompactResponse {
  try {
    const value: unknown = JSON.parse(raw)
    return parsedCompactResponse(value)
  } catch {
    let item: LlmCompactionResult['item'] | undefined
    let usage: LlmCompactionResult['usage'] | undefined
    let completed = false
    let failed = false
    for (const block of raw.split(/\r?\n\s*\r?\n/)) {
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')
      if (data.length === 0 || data === '[DONE]') continue
      try {
        const value: unknown = JSON.parse(data)
        const parsed = parsedCompactResponse(value)
        item ??= parsed.item
        usage ??= parsed.usage
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const eventType = (value as Record<string, unknown>).type
          completed ||= eventType === 'response.completed'
          failed ||= eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'error'
        }
      } catch {
        // Ignore non-JSON SSE comments and continue looking for the terminal item.
      }
    }
    return completed && !failed
      ? { ...item === undefined ? {} : { item }, ...usage === undefined ? {} : { usage } }
      : {}
  }
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/**
 * Merge deployment headers, the optional per-session header, and Harness
 * attribution. Dynamic session values replace a same-named static entry;
 * attribution remains authoritative for its reserved names.
 */
function requestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  sessionHeader?: string,
  sessionId?: string,
): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  const dynamicName = sessionHeader?.toLowerCase()
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => {
      const normalized = name.toLowerCase()
      return !reserved.has(normalized) && normalized !== dynamicName
    })),
    ...sessionHeader !== undefined && sessionId !== undefined ? { [sessionHeader]: sessionId } : {},
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
      compact: options => this.compactWithSnapshot(options, snapshot),
    })
  }

  /**
   * Call the Codex remote-compaction wire for GPT Responses routes.
   * pi-ai preserves reasoning signatures but does not expose compaction, so
   * the adapter tries Sub2API's native V2 trigger first, then the legacy
   * `/responses/compact` endpoint used by CLIProxyAPI, and keeps the returned
   * item opaque for the next request.
   * @param options - selected GPT route and history span to compact.
   * @returns the opaque compaction item, or `undefined` for unsupported routes.
   */
  override compact(options: LlmCompactOptions): Promise<LlmCompactionResult | undefined> {
    return this.compactWithSnapshot(options, this.current())
  }

  private async compactWithSnapshot(options: LlmCompactOptions, snapshot: PiAiSnapshot): Promise<LlmCompactionResult | undefined> {
    if (!isGptModel(options.model)) return undefined
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    if (!RESPONSES_APIS.has(model.api)) return undefined
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    if (apiKey === undefined) return undefined

    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const compactOptions: GenerateOptions = {
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    }
    const replayPolicy = {
      api: model.api,
      ...profile.requiresReasoningTextOnToolReplay === undefined
        ? {}
        : { requiresReasoningTextOnToolReplay: profile.requiresReasoningTextOnToolReplay },
    }
    const context = attachments === undefined
      ? toPiContext(compactOptions, undefined, undefined, replayPolicy)
      : await toPiContext(compactOptions, {
        attachments,
        resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
        maxRequestImageBytes: profile.maxRequestImageBytes,
        requestImagePolicy: {
          maxPixels: profile.requestImagePixelBudget,
          maxBytes: profile.requestImageMaxBytes,
        },
      }, undefined, replayPolicy)
    const input = convertResponsesMessages(model, normalizeContext(context), OPENAI_TOOL_CALL_PROVIDERS, {
      includeSystemPrompt: false,
    })
    const compactionItem = compactionItemOf(compactOptions.messages)
    const replayedInput = compactionItem === undefined
      ? input
      : (injectCompactionItem({ input }, compactionItem) as { input: unknown[] }).input
    const body: Record<string, unknown> = {
      model: options.model,
      input: replayedInput,
      ...context.systemPrompt === undefined ? {} : { instructions: context.systemPrompt },
      ...context.tools === undefined || context.tools.length === 0 ? {} : {
        tools: convertResponsesTools(context.tools),
      },
    }
    const headers: Record<string, string> = {
      ...requestHeaders(
        profile.headers,
        profile.sessionHeader,
        options.sessionId === undefined ? undefined : String(options.sessionId),
      ),
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...options.sessionId === undefined ? {} : { 'session_id': String(options.sessionId) },
    }
    const timeoutMs = profile.timeoutMs ?? profile.streamIdleTimeoutMs
    const fetchCompact = async (
      path: string,
      payload: Record<string, unknown>,
      extraHeaders: Readonly<Record<string, string>> = {},
    ): Promise<{ response: Response; raw: string }> => {
      const controller = new AbortController()
      const requestSignal = options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal])
      const timeout = setTimeout(() => {
        controller.abort('LLM_COMPACTION_TIMEOUT')
      }, timeoutMs)
      try {
        const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'POST',
          headers: { ...headers, ...extraHeaders },
          body: JSON.stringify(payload),
          signal: requestSignal,
        })
        return { response, raw: await response.text() }
      } catch (error: unknown) {
        if (controller.signal.aborted && !options.signal?.aborted) {
          throw new LlmError(`OpenAI Responses compaction timed out after ${timeoutMs}ms`, 'TIMEOUT', { cause: error })
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }
    try {
      const nativeBody: Record<string, unknown> = {
        ...body,
        input: [...replayedInput, { type: 'compaction_trigger' }],
        stream: true,
        store: true,
        reasoning: { effort: 'max', context: 'all_turns' },
      }
      const native = await fetchCompact('/responses', nativeBody, {
        'x-codex-beta-features': 'remote_compaction_v2',
      })
      if (native.response.ok) {
        const parsed = parseCompactResponseText(native.raw)
        if (parsed.item !== undefined) return { item: parsed.item, ...parsed.usage === undefined ? {} : { usage: parsed.usage } }
      } else if (!unsupportedCompactBody(native.response.status, native.raw)) {
        throw new LlmError(
          `OpenAI Responses native compaction failed with HTTP ${native.response.status}: ${native.raw.slice(0, 500)}`,
          native.response.status === 429 ? 'RATE_LIMIT' : native.response.status >= 500 ? 'SERVER' : 'COMPACTION_FAILED',
          { status: native.response.status },
        )
      }

      // CLIProxyAPI and older Sub2API deployments implement the unary bridge.
      // It is intentionally tried after native V2 so Sub2API can select its
      // compact-capable account and preserve the Codex session protocol.
      const legacy = await fetchCompact('/responses/compact', body)
      if (legacy.response.ok) {
        const parsed = parseCompactResponseText(legacy.raw)
        if (parsed.item !== undefined) return { item: parsed.item, ...parsed.usage === undefined ? {} : { usage: parsed.usage } }
      } else if (!unsupportedCompactBody(legacy.response.status, legacy.raw)) {
        throw new LlmError(
          `OpenAI Responses legacy compaction failed with HTTP ${legacy.response.status}: ${legacy.raw.slice(0, 500)}`,
          legacy.response.status === 429 ? 'RATE_LIMIT' : legacy.response.status >= 500 ? 'SERVER' : 'COMPACTION_FAILED',
          { status: legacy.response.status },
        )
      }
      return undefined
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError('OpenAI Responses compaction was aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const compactionItem = compactionItemOf(options.messages)
      if (compactionItem !== undefined && (!isGptModel(options.model) || !RESPONSES_APIS.has(model.api))) {
        throw new LlmError(
          `provider route "${options.provider}/${options.model}" cannot replay an OpenAI Responses compaction item`,
          'UNSUPPORTED_COMPACTION',
        )
      }
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const replayPolicy = {
        api: model.api,
        ...profile.requiresReasoningTextOnToolReplay === undefined
          ? {}
          : { requiresReasoningTextOnToolReplay: profile.requiresReasoningTextOnToolReplay },
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade, replayPolicy)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade, replayPolicy)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(
          profile.headers,
          profile.sessionHeader,
          options.sessionId === undefined ? undefined : String(options.sessionId),
        ),
        ...compactionItem === undefined ? {} : {
          onPayload: (payload: unknown) => injectCompactionItem(payload, compactionItem),
        },
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
