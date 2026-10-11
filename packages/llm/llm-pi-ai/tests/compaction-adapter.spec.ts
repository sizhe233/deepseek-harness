import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeMockServers()
})

const item = { type: 'compaction' as const, encrypted_content: 'opaque', metadata: { flags: [true, null], seq: 7 } }
const options = { provider: 'openai', model: 'gpt-4.1', messages: [] }
function adapter(baseURL: string, profile: PiAiProviderProfile = {}, key: string | undefined = 'test-key') {
  return new PiAiAdapter({ profiles: () => resolveProfiles({ openai: { baseURL, ...profile } }),
    resolveApiKey: () => Promise.resolve(key), auth: memoryAuth() })
}
function imageMessage() {
  const attachment: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  return createUserMessage({ content: [{ type: 'image', attachment }], source: { kind: 'user' } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('native Responses compaction', () => {
  it('declines incompatible protocols and routes without a resolved key before sending history', async () => {
    const server = await mockServer([])
    await expect(adapter(server.url, { api: 'openai-completions' }).compact(options)).resolves.toBeUndefined()
    const noKey = new PiAiAdapter({ profiles: () => resolveProfiles({ openai: { baseURL: server.url } }),
      resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth() })
    await expect(noKey.compact(options)).resolves.toBeUndefined()
    expect(server.requests).toEqual([])
  })

  it('refuses unsupported images and missing attachment storage before sending history', async () => {
    const server = await mockServer([])
    const request = { ...options, messages: [imageMessage()] }
    const unsupported = adapter(server.url, { models: [{ id: 'gpt-4.1', input: ['text'] }] }).compact(request)
    await expect(unsupported).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(unsupported).rejects.toThrow('does not support image')
    const missingStorage = adapter(server.url).compact(request)
    await expect(missingStorage).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(missingStorage).rejects.toThrow('attachment service')
    expect(server.requests).toEqual([])
  })

  it.each([false, true])('projects durable images, tools and cancellation with access mapping %j', async (mapped) => {
    const server = await mockServer([{ body: JSON.stringify({ output: [item] }) }])
    const readImageRequest = vi.fn((attachment: ImageAttachmentRef) => Promise.resolve({
      variantId: ImageVariantId('variant'), attachment, data: Uint8Array.of(1), mediaType: 'image/png' as const,
      bytes: 1, width: 1, height: 1, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: true,
    }))
    class RequestImageStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImageBytes: 1, maxImagePixels: 1,
        maxImageDimension: 1, mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('unexpected image validation'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('unexpected image write'))
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return Promise.reject(new Error('unexpected original image read'))
      }

      override readImageRequest = readImageRequest
    }
    const ctx = new Context()
    const fiber = await ctx.plugin(RequestImageStore)
    onTestFinished(() => fiber.dispose())
    const store = ctx.attachments
    const resolveImageAccess = mapped ? () => ({ readonlyPath: '/model/image.png' }) : undefined
    const native = new PiAiAdapter({ profiles: () => resolveProfiles({ openai: { baseURL: server.url,
      requiresReasoningTextOnToolReplay: true } }), resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(), resolveAttachments: () => store,
    ...resolveImageAccess === undefined ? {} : { resolveImageAccess } })
    const signal = new AbortController().signal
    await expect(native.compact({ ...options, messages: [imageMessage()], signal,
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).resolves.toEqual({ item })
    expect(readImageRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), signal)
    expect(server.requests[0]).toMatchObject({ tools: [{ type: 'function', name: 'read' }] })
    expect(JSON.stringify(server.requests[0])).toContain('data:image/png;base64,AQ==')
    expect(JSON.stringify(server.requests[0]).includes('/model/image.png')).toBe(mapped)
  })

  it.each([405, 415, 501])('tries the unary endpoint after unsupported native HTTP %i', async (status) => {
    const server = await mockServer([{ status }, {
      body: JSON.stringify({ output: [item], usage: { input_tokens: 2, output_tokens: 1 } }),
    }])
    await expect(adapter(server.url).compact(options)).resolves.toEqual({ item, usage: { inputTokens: 2, outputTokens: 1 } })
    expect(server.paths).toEqual(['/responses', '/responses/compact'])
  })

  it.each(['native', 'legacy'] as const)('classifies fatal HTTP errors from the %s endpoint without retrying', async (endpoint) => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [503, 'SERVER'], [400, 'COMPACTION_FAILED']] as const) {
      const server = await mockServer([...(endpoint === 'legacy' ? [{ status: 404 }] : []),
        { status, body: 'invalid request' }])
      await expect(adapter(server.url).compact(options)).rejects.toMatchObject({ code, failure: { status } })
      expect(server.requests).toHaveLength(endpoint === 'legacy' ? 2 : 1)
    }
  })

  it.each([null, [], 'invalid', {}, { output: [null, [], 1, {}, { type: 'text' }, { type: 'compaction', encrypted_content: 4 }] },
    { type: 'response.output_item.done' }, { response: null }, { response: [] }])
  ('falls back from unusable native JSON %j without publishing a checkpoint', async (body) => {
    const server = await mockServer([{ body: JSON.stringify(body) }, { body: '{}' }])
    await expect(adapter(server.url).compact(options)).resolves.toBeUndefined()
    expect(server.paths).toEqual(['/responses', '/responses/compact'])
  })

  it.each([null, [], { input_tokens: -1, output_tokens: 1 }, { input_tokens: 2, output_tokens: 'invalid' },
    { input_tokens: 2, output_tokens: 1, input_tokens_details: [], output_tokens_details: null }])
  ('keeps opaque metadata while omitting invalid optional usage %j', async (usage) => {
    const server = await mockServer([{ body: JSON.stringify({ response: { output: [item], usage } }) }])
    const result = await adapter(server.url).compact(options)
    expect(result?.item).toEqual(item)
    if (usage !== null && !Array.isArray(usage) && usage.input_tokens === 2 && usage.output_tokens === 1) {
      expect(result?.usage).toEqual({ inputTokens: 2, outputTokens: 1 })
    } else expect(result).not.toHaveProperty('usage')
  })

  it.each(['response.failed', 'response.incomplete', 'error', 'unfinished'])
  ('rejects incomplete SSE checkpoints after %s', async (type) => {
    const server = await mockServer([{ rawEvents: [
      ': heartbeat', 'data: not-json', 'data: null', 'data: [DONE]',
      `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`,
      ...type === 'unfinished' ? [] : [`data: ${JSON.stringify({ type })}`, 'data: {"type":"response.completed"}'],
    ] }, { body: '{}' }])
    await expect(adapter(server.url).compact(options)).resolves.toBeUndefined()
    expect(server.paths).toEqual(['/responses', '/responses/compact'])
  })

  it('falls back from completed SSE without an item or usage', async () => {
    const server = await mockServer([{ events: ['{"type":"response.completed"}'] }, { body: JSON.stringify({ output: [item] }) }])
    await expect(adapter(server.url).compact(options)).resolves.toEqual({ item })
  })

  it('closes a stalled native compaction response at the configured timeout', async () => {
    const server = await mockServer([{ holdOpen: true }])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = adapter(server.url, { timeoutMs: 30 }).compact(options)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await server.requestReceived
    await vi.advanceTimersByTimeAsync(30)
    await rejected
    vi.useRealTimers()
    await server.responseClosed
    expect(server.closedResponses).toBe(1)
    expect(server.paths).toEqual(['/responses'])
  })

  it('reports caller cancellation and closes the pending response without fallback', async () => {
    const server = await mockServer([{ holdOpen: true }])
    const controller = new AbortController()
    const pending = adapter(server.url).compact({ ...options, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await server.requestReceived
    controller.abort('caller canceled')
    await rejected
    await server.responseClosed
    expect(server.paths).toEqual(['/responses'])
  })

  it('preserves transport failures without retrying the legacy endpoint', async () => {
    const failure = new TypeError('network unavailable')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure)
    await expect(adapter('https://provider.invalid').compact(options)).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([{ api: 'openai-completions', model: 'gpt-4.1' }, { api: 'openai-responses', model: 'other-model' }])
  ('refuses opaque checkpoint replay through $api/$model', async ({ api, model }) => {
    const server = await mockServer([])
    const native = adapter(server.url, { api, models: [{ id: model }] })
    await expect(collect(native.stream({ provider: 'openai', model,
      messages: [createUserMessage({ content: [{ type: 'compaction', item }], source: { kind: 'user' } })] })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_COMPACTION' })
    expect(server.requests).toEqual([])
  })
})
