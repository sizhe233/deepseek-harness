/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, LlmCompactionItem, Message, RequestMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Api, Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'
import type { PiReplayTarget } from './replay.ts'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from './config.ts'

/** Marker converted to one temporary user item before pi-ai payload rewriting. */
export const COMPACTION_ITEM_SENTINEL = '\uE000dsh-compaction-item\uE001'

/** Join the text blocks of a harness message. */
function flattenText(message: RequestMessage): string {
  return message.content
    .flatMap(block => block.type === 'text'
      ? [block.text]
      : block.type === 'compaction' ? [COMPACTION_ITEM_SENTINEL] : [])
    .join('')
}


/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(
  message: Extract<Message, { role: 'tool' }>,
  toolNames: Map<ToolCallId, string>,
  content: string | (TextContent | ImageContent)[],
): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string'
      ? [{ type: 'text', text: content || '(no output)' }]
      : content,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/**
 * Find the one provider-native compaction item embedded in durable history.
 * @param messages - durable conversation history.
 * @returns the opaque item, or undefined when the history has no compaction.
 */
export function compactionItemOf(messages: readonly RequestMessage[]): LlmCompactionItem | undefined {
  let found: LlmCompactionItem | undefined
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'compaction') {
        if (found !== undefined) throw new LlmError('a request may contain only one compaction item', 'INVALID_COMPACTION_ITEM')
        found = block.item
      }
    }
  }
  return found
}

function containsCompactionSentinel(value: unknown): boolean {
  if (value === COMPACTION_ITEM_SENTINEL) return true
  if (Array.isArray(value)) return value.some(containsCompactionSentinel)
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(containsCompactionSentinel)
}

/**
 * Replace the temporary marker in pi-ai's Responses payload with the opaque item.
 * @param payload - the prepared Responses request body.
 * @param item - the original opaque provider item.
 * @returns the request body with its validated marker replaced.
 */
export function injectCompactionItem(payload: unknown, item: LlmCompactionItem): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new LlmError('pi-ai Responses payload is not an object', 'INVALID_COMPACTION_PAYLOAD')
  }
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.input)) {
    throw new LlmError('pi-ai Responses payload has no input array for compaction replay', 'INVALID_COMPACTION_PAYLOAD')
  }
  const indexes = body.input
    .map((entry, index) => containsCompactionSentinel(entry) ? index : -1)
    .filter(index => index >= 0)
  if (indexes.length !== 1) {
    throw new LlmError(
      `pi-ai Responses payload contains ${indexes.length} compaction markers; expected exactly one`,
      'INVALID_COMPACTION_PAYLOAD',
    )
  }
  const input = [...(body.input as unknown[])]
  input[indexes[0] as number] = item
  return { ...body, input }
}

/** Reject unsupported roles, tool-change blocks, and image roles before replay or image offloading. */
function assertSupportedHistory(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    // Developer history is persisted for V4; provider serialization is intentionally deferred.
    if (message.role === 'developer') throw new LlmError('Developer messages are not supported yet', 'UNSUPPORTED_CONTENT')
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): string | (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      case 'compaction':
        content.push({ type: 'text', text: COMPACTION_ITEM_SENTINEL })
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function collectImageRefs(
  blocks: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      if (block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
}

async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  budget: PiImageRequestBudget,
  signal?: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal),
  ))
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  for (const [index, ref] of orderedRefs.entries()) {
    versions.set(ref.attachmentId, prepared[index] as RequestImageAttachment)
  }
  return versions
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  // Deferred definitions are persisted for V4; provider loading is intentionally deferred.
  if (options.tools?.some(tool => tool.deferLoading === true)) {
    throw new LlmError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')
  }
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** The request split into pi-ai's single `systemPrompt` slot and the history that converts to `messages`. */
interface SystemPromptSplit {
  /** Text for pi-ai's `systemPrompt`; `undefined` sends no system prompt. */
  systemPrompt: string | undefined
  /** History messages that convert to pi-ai `messages`. */
  messages: readonly RequestMessage[]
}

/**
 * Select the pi-ai `systemPrompt` source shared by both conversion paths.
 * `options.system` wins when defined and every history message converts,
 * including a leading `system` message, which then folds into a `user`
 * message. Otherwise a leading `system` history message supplies the prompt
 * and leaves the converted history; empty leading text sends no prompt.
 */
function splitSystemPrompt(options: GenerateOptions): SystemPromptSplit {
  if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt: string | undefined, options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...systemPrompt !== undefined ? { systemPrompt } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

/** Exact target-route requirements used while preparing foreign tool history. */
export interface PiReplayPolicy {
  api?: Api
  requiresReasoningTextOnToolReplay?: boolean
}

function replayTarget(options: GenerateOptions, policy?: PiReplayPolicy): PiReplayTarget {
  return {
    ...policy?.api === undefined ? {} : { api: policy.api },
    provider: options.provider,
    model: options.model,
    ...policy?.requiresReasoningTextOnToolReplay === undefined
      ? {}
      : { requiresReasoningTextOnToolReplay: policy.requiresReasoningTextOnToolReplay },
  }
}

function appendAssistant(
  message: Extract<Message, { role: 'assistant' }>,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  options: GenerateOptions,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): void {
  const assistant = toPiAssistant(message, replayTarget(options, replayPolicy), onReplayDegrade)
  for (const block of assistant.content) {
    if (block.type === 'toolCall') toolNames.set(brandString<ToolCallId>(block.id), block.name)
  }
  messages.push(assistant)
}

/** Append the system and assistant roles both context builders treat identically; true when consumed. */
function appendSystemOrAssistant(
  message: RequestMessage,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  options: GenerateOptions,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): boolean {
  if (message.role === 'system') {
    // pi-ai has a single systemPrompt slot; a system message that did not
    // supply it folds into a user message to preserve order.
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    return true
  }
  if (message.role === 'assistant') {
    appendAssistant(message, messages, toolNames, options, onReplayDegrade, replayPolicy)
    return true
  }
  return false
}

function textOnlyContext(options: GenerateOptions, onReplayDegrade?: (reason: string) => void, replayPolicy?: PiReplayPolicy): PiContext {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (appendSystemOrAssistant(message, messages, toolNames, options, onReplayDegrade, replayPolicy)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, flattenText(message)))
      continue
    }
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

/** Inputs that bind deterministic request images to one current tool execution world. */
export interface PiImageRequestContext {
  /** Durable provider that resolves request-image bytes and provider-owned host objects. */
  attachments: AttachmentStore
  /** Resolve current tool access separately from deterministic request-image versions. */
  resolveImageAccess: ImageAttachmentAccessResolver
  /** Request-level bound on the base64-encoded payload of retained images; omission leaves the bound unchecked. */
  maxRequestImageBytes?: number
  /** Route pixel and raw encoded-byte budgets. */
  requestImagePolicy?: PiImageRequestBudget
}

/** Per-route budgets from which each request image's target is derived. */
export interface PiImageRequestBudget {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Encoded-byte target for one request image. */
  maxBytes: number
}

/** Deterministic request target for one source under the route budgets. */
function requestImageTarget(ref: ImageAttachmentRef, budget: PiImageRequestBudget): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes }
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system`, else a leading `system` message, maps to pi-ai's single `systemPrompt` slot.
 * @param images - absent; selects the synchronous conversion.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @param replayPolicy - target-route protocol and reasoning-text requirements.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for images in any history role, including a leading system message.
 */
export function toPiContext(
  options: GenerateOptions,
  images?: undefined,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls. Image
 * occurrences the surface marks offloaded become text placeholders; when the
 * retained occurrences' exact base64 payload still exceeds
 * `maxRequestImageBytes`, the call fails with `IMAGE_OFFLOAD_REQUIRED` naming
 * how many more oldest occurrences must be offloaded.
 * @param options - the harness request; `options.system`, else a leading `system` message, maps to pi-ai's single `systemPrompt` slot.
 * @param images - attachment provider, current path resolver, and request limits.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @param replayPolicy - target-route protocol and reasoning-text requirements.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  images: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  images?: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): PiContext | Promise<PiContext> {
  return images === undefined
    ? textOnlyContext(options, onReplayDegrade, replayPolicy)
    : toPiContextWithImages(options, images, onReplayDegrade, replayPolicy)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  images: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
  replayPolicy?: PiReplayPolicy,
): Promise<PiContext> {
  const { attachments, resolveImageAccess, maxRequestImageBytes } = images
  const requestImagePolicy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal)
  if (maxRequestImageBytes !== undefined) {
    const offloadImages = requiredImageOffload(
      split.messages,
      { representation: 'base64', maxBytes: maxRequestImageBytes },
      block => (requestImages.get(block.attachment.attachmentId) as RequestImageAttachment).bytes,
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `pi-ai request images exceed the ${maxRequestImageBytes}-byte base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }
  const exactMessages = projectOffloadedImages(
    split.messages,
    ref => offloadedImageText(ref, resolveImageAccess(ref)),
  )
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []

  for (const message of exactMessages) {
    if (appendSystemOrAssistant(message, messages, toolNames, options, onReplayDegrade, replayPolicy)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)))
      continue
    }
    const content = userContent(message.content, requestImages, resolveImageAccess)
    messages.push({ role: 'user', content, timestamp: 0 })
  }

  return piContext(split.systemPrompt, options, messages)
}
