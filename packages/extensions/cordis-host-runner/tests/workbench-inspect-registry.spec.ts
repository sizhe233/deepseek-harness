import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { CordisInspectProviderManifest, CordisInspectQueryRequest } from '../src/types.ts'

const MANIFEST: CordisInspectProviderManifest = {
  id: 'Slots',
  description: 'Client slot inspection.',
  methods: [{
    name: 'listSubTree',
    description: 'List the live slot tree.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
  }],
}

const CHILD_ID = 'child-session' as SessionId
const CHILD_AGENT = { id: CHILD_ID } as Agent

afterEach(() => {
  vi.useRealTimers()
})

describe('Client Cordis inspect routing', () => {
  it('accepts a subagent Session identity without resolving it as an Agent', async () => {
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx, 100)
    registry.syncClientManifest([MANIFEST])
    ctx.on('cordis/inspect-query', (request) => {
      expect(registry.resolveClientQuery(request.agentId, request.requestId, {
        ok: true,
        data: { slots: ['composer'] },
      })).toEqual({ accepted: true })
    })

    await expect(registry.query(
      'client', 'Slots', 'listSubTree', {}, CHILD_AGENT, new AbortController().signal,
    )).resolves.toEqual({ slots: ['composer'] })
  })

  it('fails and closes the request when no browser page returns a valid response', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const registry = new CordisInspectRegistryService(ctx, 30)
    registry.syncClientManifest([MANIFEST])
    let request: CordisInspectQueryRequest | undefined
    const resolved: string[] = []
    ctx.on('cordis/inspect-query', (value) => { request = value })
    ctx.on('cordis/inspect-query-resolved', value => resolved.push(value.requestId))

    const pending = registry.query(
      'client', 'Slots', 'listSubTree', {}, CHILD_AGENT, new AbortController().signal,
    )
    const rejection = expect(pending).rejects.toThrow(
      'Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 30ms',
    )
    await vi.advanceTimersByTimeAsync(30)

    await rejection
    expect(request).toBeDefined()
    expect(resolved).toEqual([request?.requestId])
    expect(registry.resolveClientQuery(CHILD_ID, request!.requestId, { ok: true, data: {} }))
      .toEqual({ accepted: false })
  })
})
