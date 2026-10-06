import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply as applyBridge } from '../src/index.ts'
import { MCP_CLIENT_MODULE } from '../src/configuration.ts'
import { configurationFixture as harness } from './configuration-fixture.ts'

describe('McpConfigurationGateway', () => {
  it('keeps saved values live when the owning profile reapplies its base configuration', async () => {
    const { ctx, gateway, serverId } = await harness(2_500)
    await gateway.list()
    const entry = ctx.loader.resolve(serverId)
    const base = { ...(entry.options.config as Record<string, unknown>), toolCallTimeoutMs: 1_000 }
    await entry.update({ config: base })
    expect(entry.options.config).toMatchObject({ toolCallTimeoutMs: 1_000 })
    expect(entry.fiber?.config).toMatchObject({ toolCallTimeoutMs: 2_500 })
  })
  it('does not retry a rejected stored override from its own rollback status events', async () => {
    const observed: number[] = []
    const { gateway } = await harness(2_500, observed)
    await gateway.list()
    expect(observed.filter(timeout => timeout === 2_500)).toHaveLength(1)
  })
  it('applies overrides already present when the gateway is mounted', async () => {
    const { gateway, serverId } = await harness(2_500)
    const restored = (await gateway.list()).entries.find(entry => entry.entryId === serverId)
    expect(restored).toMatchObject({ toolCallTimeoutMs: 2_500, args: ['hello'] })
  })
  it('publishes direct list/update methods and excludes its control-plane row', async () => {
    const { gateway, serverId } = await harness()
    expect(remoteMethods(gateway)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'update', invocation: { kind: 'direct' } },
    ])

    const snapshot = await gateway.list()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[0]).toMatchObject({
      entryId: serverId,
      moduleName: MCP_CLIENT_MODULE,
      transport: 'stdio',
      serverName: 'fixture',
      command: 'echo',
      args: ['hello'],
      toolCallTimeoutMs: 1_000,
      env: [{ key: 'TOKEN', configured: true }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret-value')
  })

  it('persists a narrow patch and updates only the selected Loader entry', async () => {
    const { ctx, gateway, serverId, readPatch } = await harness()
    const first = await gateway.list()
    const entry = ctx.loader.resolve(serverId)
    const sibling = [...ctx.loader.entries()].find(candidate => candidate.id !== serverId
      && candidate.options.name === MCP_CLIENT_MODULE)!
    const siblingBefore: unknown = structuredClone(sibling.options.config)

    const next = await gateway.update(serverId, { toolCallTimeoutMs: 2_000 }, first.revision)
    expect(next.entries.find(item => item.entryId === serverId)?.toolCallTimeoutMs).toBe(2_000)
    expect(entry.options.config).toMatchObject({ toolCallTimeoutMs: 2_000 })
    expect(sibling.options.config).toEqual(siblingBefore)
    expect(await readPatch()).toContain('id: mcp-configuration')
    expect(await readPatch()).toContain('toolCallTimeoutMs: 2000')
    expect(await readPatch()).not.toContain('id: mcp-fixture')
  })

  it('keeps inherited arguments after asynchronous settings observers apply a narrow override', async () => {
    const { gateway, serverId } = await harness()
    const first = await gateway.list()
    await gateway.update(serverId, { toolCallTimeoutMs: 2_000 }, first.revision)
    const settled = await gateway.list()
    expect(settled.entries.find(entry => entry.entryId === serverId)?.args).toEqual(['hello'])
    await gateway.update(serverId, { toolCallTimeoutMs: 3_000 }, settled.revision)
    expect((await gateway.list()).entries.find(entry => entry.entryId === serverId)?.args).toEqual(['hello'])
  })

  it('accepts write-only secret updates without echoing their values', async () => {
    const { gateway, serverId } = await harness()
    const first = await gateway.list()
    const next = await gateway.update(serverId, { env: { set: { TOKEN: 'replacement' } } }, first.revision)
    expect(next.entries[0]?.env).toEqual([{ key: 'TOKEN', configured: true }])
    expect(JSON.stringify(next)).not.toContain('replacement')
  })

  it('rejects stale revisions and invalid transport values before applying them', async () => {
    const { gateway, serverId } = await harness()
    const first = await gateway.list()
    await expect(gateway.update(serverId, { toolCallTimeoutMs: 2_000 }, first.revision + 1))
      .rejects.toMatchObject({ code: 'mcp/conflict', details: { entryId: serverId } })
    await expect(gateway.update(serverId, { transport: 'invalid' } as never, first.revision))
      .rejects.toMatchObject({ code: 'mcp/bad-request' })
  })


  it('restores persisted overrides after restart and resets only explicitly named fields', async () => {
    const { ctx, gateway, serverId, start } = await harness()
    await gateway.update(serverId, { args: ['changed'], env: { set: { TOKEN: 'private-update' } } }, (await gateway.list()).revision)
    await ctx.fiber.dispose()
    const restored = await start()
    const first = await restored.gateway.list()
    expect(first.entries.find(entry => entry.entryId === serverId)?.args).toEqual(['changed'])
    const reset = await restored.gateway.update(serverId, { reset: ['args'] }, first.revision)
    expect(reset.entries.find(entry => entry.entryId === serverId)?.args).toEqual(['hello'])
    const raw: unknown = restored.ctx.loader.resolve(serverId).options.config
    expect(raw).toMatchObject({ env: { TOKEN: 'private-update' } })
    expect(JSON.stringify(restored.ctx.settings.describe({ redactSecrets: true }))).not.toContain('private-update')
  })

  it('imports legacy overrides and secrets into the configuration entry without exposing them', async () => {
    const { ctx, home, serverId, start, warnings, readPatch } = await harness()
    await ctx.fiber.dispose()
    const legacy = {
      'mcp-client': { entries: { [serverId]: { toolCallTimeoutMs: 3_456, env: { TOKEN: 'migrated-secret' } } } },
      'unknown-mcp-owner': { entry: 'unsupported' },
    }
    await writeFile(join(home, 'settings.yaml'), JSON.stringify(legacy))
    const restored = await start()
    await vi.waitFor(async () => {
      expect((await restored.gateway.list()).entries.find(entry => entry.entryId === serverId)?.toolCallTimeoutMs).toBe(3_456)
    })
    expect(await readPatch()).toContain('id: mcp-configuration')
    expect(await readPatch()).toContain('migrated-secret')
    expect(await readFile(join(home, 'settings.yaml.imported'), 'utf8')).toContain('unsupported')
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('unknown-mcp-owner'))).toBe(true)
    })
    expect(JSON.stringify(await restored.gateway.list())).not.toContain('migrated-secret')
    expect(JSON.stringify(restored.ctx.settings.describe({ redactSecrets: true }))).not.toContain('migrated-secret')
  })

  it('restores the original runtime configuration if profile persistence fails', async () => {
    const { ctx, gateway, serverId, readPatch } = await harness()
    const first = await gateway.list()
    const before = await readPatch()
    const entry = ctx.loader.resolve(serverId)
    const previous: unknown = structuredClone(entry.options.config)
    const mutate = vi.spyOn(ctx.settings, 'mutate').mockRejectedValueOnce(new Error('synthetic persistence failure'))
    try {
      await expect(gateway.update(serverId, { toolCallTimeoutMs: 9_000 }, first.revision))
        .rejects.toMatchObject({ code: 'mcp/write-failed' })
    } finally {
      mutate.mockRestore()
    }
    expect(entry.options.config).toEqual(previous)
    expect(await readPatch()).toBe(before)
    expect((await gateway.list()).entries.find(row => row.entryId === serverId)?.toolCallTimeoutMs).toBe(1_000)
  })


  it('migrates legacy control rows, keeps edits writable, and restores them after restart', async () => {
    const { ctx, gateway, serverId, start, readPatch } = await harness(undefined, undefined, true)
    const control = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-configuration')!
    expect(control.options.name).toBe(`${MCP_CLIENT_MODULE}/configuration`)
    expect(control.options.config).toEqual({ retained: 'unrelated' })
    const snapshot = await gateway.list()
    expect(snapshot.writable).toBe(true)
    await gateway.update(serverId, { toolCallTimeoutMs: 2_001, env: { set: { TOKEN: 'legacy-alias-secret' } } }, snapshot.revision)
    expect(await readPatch()).toContain(`${MCP_CLIENT_MODULE}/configuration`)
    await ctx.fiber.dispose()
    const restored = await start()
    const restoredEntry = (await restored.gateway.list()).entries.find(row => row.entryId === serverId)
    expect(restoredEntry?.toolCallTimeoutMs).toBe(2_001)
    expect(JSON.stringify(restoredEntry)).not.toContain('legacy-alias-secret')
    expect(restored.ctx.loader.resolve(serverId).options.config).toMatchObject({ env: { TOKEN: 'legacy-alias-secret' } })
  })


  it('gives raw Loader callers explicit migration guidance for the legacy control mode', async () => {
    const { ctx } = await harness()
    await expect(applyBridge(ctx, { mode: 'configuration' })).rejects.toThrow(
      'use @deepseek-ai/dsh-mcp-client/configuration and remove config.mode',
    )
  })

  it('restores enablement when a disabling edit cannot be persisted', async () => {
    const { ctx, gateway, serverId } = await harness()
    const first = await gateway.list()
    const mutate = vi.spyOn(ctx.settings, 'mutate').mockRejectedValueOnce(new Error('synthetic write refusal'))
    try {
      await expect(gateway.update(serverId, { enabled: false }, first.revision)).rejects.toMatchObject({ code: 'mcp/write-failed' })
    } finally {
      mutate.mockRestore()
    }
    expect(ctx.loader.resolve(serverId).disabled).toBe(false)
    expect((await gateway.list()).entries.find(row => row.entryId === serverId)?.enabled).toBe(true)
  })


  it('returns settled disabled state and resets enablement to the inherited profile value', async () => {
    const { ctx, gateway, serverId } = await harness()
    const first = await gateway.list()
    const disabled = await gateway.update(serverId, { enabled: false }, first.revision)
    expect(disabled.entries.find(row => row.entryId === serverId)?.enabled).toBe(false)
    expect(ctx.loader.resolve(serverId).disabled).toBe(true)
    const reset = await gateway.update(serverId, { reset: ['enabled'] }, disabled.revision)
    expect(reset.entries.find(row => row.entryId === serverId)?.enabled).toBe(true)
    expect(ctx.loader.resolve(serverId).disabled).toBe(false)
  })
})


describe('MCP configuration validation and reset', () => {
  it('merges transport, reconnect and write-only changes, then resets each supported field', async () => {
    const { ctx, gateway, serverId } = await harness()
    let value = await gateway.update(serverId, {
      serverName: 'changed', command: 'node', args: ['server.js'], cwd: '/workspace',
      toolCallTimeoutMs: 9_000, failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 700 },
      env: { set: { NEW: 'new-secret' }, unset: ['TOKEN'] },
      headers: { set: { Authorization: 'header-secret' } },
    }, (await gateway.list()).revision)
    expect(value.entries.find(row => row.entryId === serverId)).toMatchObject({
      serverName: 'changed', command: 'node', args: ['server.js'], cwd: '/workspace',
      reconnect: { enabled: false, initialDelayMs: 700, maxDelayMs: 30_000 },
      env: [{ key: 'NEW', configured: true }],
    })
    value = await gateway.update(serverId, { env: { unset: ['NEW'] }, headers: { unset: ['Authorization'] } }, value.revision)
    expect(value.entries.find(row => row.entryId === serverId)?.env).toEqual([])
    value = await gateway.update(serverId, {
      transport: 'streamable-http', url: 'https://example.test/mcp',
      headers: { set: { Authorization: 'replacement' } },
      env: { set: { TOKEN: 'replacement-env' } },
      reconnect: { maxDelayMs: 50_000 },
    }, value.revision)
    expect(value.entries.find(row => row.entryId === serverId)).toMatchObject({
      transport: 'streamable-http', url: 'https://example.test/mcp', headers: [{ key: 'Authorization', configured: true }],
    })
    expect(ctx.loader.resolve(serverId).options.config).not.toHaveProperty('command')
    expect(ctx.loader.resolve(serverId).options.config).not.toHaveProperty('env')
    expect(JSON.stringify(value)).not.toContain('replacement')
    value = await gateway.update(serverId, { reset: [
      'enabled', 'transport', 'serverName', 'command', 'args', 'cwd', 'url',
      'toolCallTimeoutMs', 'failOnStartupError', 'reconnect', 'env', 'headers',
    ] }, value.revision)
    expect(value.entries.find(row => row.entryId === serverId)).toMatchObject({
      transport: 'stdio', serverName: 'fixture', command: 'echo', args: ['hello'], cwd: '',
      toolCallTimeoutMs: 1_000, failOnStartupError: false, env: [{ key: 'TOKEN', configured: true }],
    })
  })

  it.each([
    { reset: ['not-a-field'] }, { unrecognized: true }, { env: { set: { 'bad-key': 'value' } } },
  ])('rejects unsupported wire patches before changing the profile: %j', async (patch) => {
    const { gateway, serverId, readPatch } = await harness()
    const before = await readPatch()
    await expect(gateway.update(serverId, patch as never, (await gateway.list()).revision))
      .rejects.toMatchObject({ code: 'mcp/bad-request' })
    expect(await readPatch()).toBe(before)
  })

  it('rejects removed entries and entries owned by other plugins', async () => {
    const { gateway } = await harness()
    const revision = (await gateway.list()).revision
    await expect(gateway.update('missing', {}, revision)).rejects.toMatchObject({ code: 'mcp/not-found' })
    await expect(gateway.update('include:settings', {}, revision)).rejects.toMatchObject({ code: 'mcp/not-found' })
  })

  it('projects dormant entries safely without echoing malformed or secret configuration values', async () => {
    const { ctx, gateway } = await harness()
    const options: EntryOptions = { id: 'dormant', name: MCP_CLIENT_MODULE, disabled: true, config: {
      transport: 'streamable-http', url: 'https://example.test/mcp', args: ['visible', 3],
      env: { TOKEN: 'secret', EMPTY: '', NIL: null, MISSING: undefined, EXPRESSION: {} },
      headers: { Authorization: 'secret-header' }, toolCallTimeoutMs: NaN,
    } }
    const id = await ctx.loader.create(options)
    const entry = (await gateway.list()).entries.find(row => row.entryId === id)
    expect(entry).toMatchObject({ enabled: false, fiberPhase: null, serverName: 'dormant',
      transport: 'streamable-http', args: ['visible'], toolCallTimeoutMs: 60_000, failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
      env: [{ key: 'TOKEN', configured: true }, { key: 'EMPTY', configured: false }, { key: 'EXPRESSION', configured: true }],
    })
    expect(JSON.stringify(entry)).not.toContain('secret')
    expect(entry).not.toHaveProperty('command')
    expect(entry).not.toHaveProperty('cwd')
    ctx.loader.remove(id)
  })

  it.each([
    { transport: 'unexpected' }, { serverName: undefined }, { serverName: 'bad name' },
    { command: undefined }, { command: ' ' }, { transport: 'streamable-http', url: undefined },
    { transport: 'streamable-http', url: 'file:///tmp/mcp' },
    { transport: 'streamable-http', url: 'not a URL' },
    { toolCallTimeoutMs: undefined }, { toolCallTimeoutMs: 0 }, { toolCallTimeoutMs: 1.5 },
    { reconnect: { initialDelayMs: 0 } },
  ])('rejects an invalid resolved dormant configuration before persisting: %j', async (invalid) => {
    const { ctx, gateway, readPatch } = await harness()
    const options: EntryOptions = { id: 'invalid', name: MCP_CLIENT_MODULE, disabled: true, config: {
      transport: 'stdio', serverName: 'fixture', command: 'echo', toolCallTimeoutMs: 1_000, ...invalid,
    } }
    const id = await ctx.loader.create(options)
    const before = await readPatch()
    await expect(gateway.update(id, {}, (await gateway.list()).revision)).rejects.toMatchObject({ code: 'mcp/bad-request' })
    expect(await readPatch()).toBe(before)
  })

  it('retains the last read revision and rejects writes when Settings disappears', async () => {
    const { ctx, gateway, serverId } = await harness()
    const first = await gateway.list()
    await ctx.loader.resolve('include:settings').update({ disabled: true })
    const next = await gateway.list()
    expect(next).toMatchObject({ writable: false, revision: first.revision })
    await expect(gateway.update(serverId, {}, next.revision)).rejects.toMatchObject({ code: 'mcp/read-only' })
  })
})

describe('MCP configuration lifecycle', () => {
  it('does not restart an already enabled failed connection for an unchanged saved override', async () => {
    const observed: number[] = []
    const { ctx, gateway, serverId } = await harness(2_500, observed)
    await ctx.loader.resolve('include:mcp-configuration').update({ config: {
      entries: { [serverId]: { enabled: true, toolCallTimeoutMs: 2_500 } },
    } })
    expect((await gateway.list()).entries.find(row => row.entryId === serverId))
      .toMatchObject({ enabled: true, fiberPhase: 'failed', toolCallTimeoutMs: 2_500 })
    expect(observed.filter(timeout => timeout === 2_500)).toHaveLength(1)
  })

  it('allows a failed connection to be disabled and persisted', async () => {
    const observed: number[] = []
    const { gateway, serverId, readPatch } = await harness(2_500, observed)
    const disabled = await gateway.update(serverId, { enabled: false }, (await gateway.list()).revision)
    expect(disabled.entries.find(row => row.entryId === serverId)?.enabled).toBe(false)
    expect(await readPatch()).toContain('enabled: false')
  })

  it('restores the previous running connection when replacement activation fails', async () => {
    const { ctx, gateway, serverId, readPatch } = await harness()
    const raw: unknown = structuredClone(ctx.loader.resolve(serverId).options.config)
    const observed: number[] = []
    const importer = vi.spyOn(ctx.loader.internal!, 'import').mockResolvedValueOnce({
      apply(_bridgeCtx: typeof ctx, config: { toolCallTimeoutMs: number }) {
        observed.push(config.toolCallTimeoutMs)
        if (config.toolCallTimeoutMs === 7_000) throw new Error('synthetic activation refusal')
      },
    })
    try {
      const options: EntryOptions = { id: 'rejecting', name: MCP_CLIENT_MODULE, config: raw }
      const id = await ctx.loader.create(options)
      await ctx.loader.resolve(id).fiber?.await()
      const first = await gateway.list()
      const before = await readPatch()
      await expect(gateway.update(id, { toolCallTimeoutMs: 7_000 }, first.revision))
        .rejects.toThrow('previous connection was restored')
      expect((await gateway.list()).entries.find(row => row.entryId === id))
        .toMatchObject({ fiberPhase: 'active', toolCallTimeoutMs: 1_000 })
      expect(observed).toContain(7_000)
      expect(observed.at(-1)).toBe(1_000)
      expect(await readPatch()).toBe(before)
    } finally {
      importer.mockRestore()
    }
  })

  it('reports pending, loading and unloading connections and rejects edits before activation', async () => {
    const { ctx, gateway, serverId } = await harness()
    const loading: PromiseWithResolvers<void> = Promise.withResolvers()
    const unloading: PromiseWithResolvers<void> = Promise.withResolvers()
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    const stopping: PromiseWithResolvers<void> = Promise.withResolvers()
    const bridge = {
      inject: ['mcpConfigurationTestReady'],
      async apply(bridgeCtx: typeof ctx) {
        bridgeCtx.effect(() => async () => { stopping.resolve(); await unloading.promise })
        started.resolve()
        await loading.promise
      },
    }
    const importer = vi.spyOn(ctx.loader.internal!, 'import').mockResolvedValueOnce(bridge)
    const raw: unknown = structuredClone(ctx.loader.resolve(serverId).options.config)
    try {
      const options: EntryOptions = { id: 'starting', name: MCP_CLIENT_MODULE, config: raw }
      const id = await ctx.loader.create(options)
      const first = await gateway.list()
      expect(first.entries.find(row => row.entryId === id)?.fiberPhase).toBe('pending')
      await expect(gateway.update(id, {}, first.revision)).rejects.toMatchObject({ code: 'mcp/conflict' })
      // A second read retains the still-present deferred entry.
      expect((await gateway.list()).entries.find(row => row.entryId === id)?.fiberPhase).toBe('pending')
      const removeReady = ctx.provide('mcpConfigurationTestReady', true)
      await started.promise
      const duringLoad = await gateway.list()
      expect(duringLoad.entries.find(row => row.entryId === id)?.fiberPhase).toBe('loading')
      await expect(gateway.update(id, {}, duringLoad.revision)).rejects.toMatchObject({ code: 'mcp/conflict' })
      loading.resolve()
      await ctx.loader.resolve(id).fiber?.await()
      expect((await gateway.list()).entries.find(row => row.entryId === id)?.fiberPhase).toBe('active')
      removeReady()
      await stopping.promise
      expect((await gateway.list()).entries.find(row => row.entryId === id)?.fiberPhase).toBe('unloading')
      unloading.resolve()
      await ctx.loader.resolve(id).fiber?.await()
      expect((await gateway.list()).entries.find(row => row.entryId === id)?.fiberPhase).toBe('pending')
      ctx.loader.remove(id)
      expect((await gateway.list()).entries.some(row => row.entryId === id)).toBe(false)
    } finally {
      loading.resolve()
      unloading.resolve()
      importer.mockRestore()
    }
  })

  it('rejects edits while the bridge module import is still in flight', async () => {
    const { ctx, gateway, serverId } = await harness()
    const importing = Promise.withResolvers<object>()
    const importer = vi.spyOn(ctx.loader.internal!, 'import').mockReturnValueOnce(importing.promise)
    const raw: unknown = structuredClone(ctx.loader.resolve(serverId).options.config)
    const options: EntryOptions = { id: 'importing', name: MCP_CLIENT_MODULE, config: raw }
    const creating = ctx.loader.create(options)
    try {
      const snapshot = await gateway.list()
      expect(snapshot.entries.find(row => row.entryId === 'importing')?.fiberPhase).toBeNull()
      await expect(gateway.update('importing', {}, snapshot.revision)).rejects.toMatchObject({ code: 'mcp/conflict' })
    } finally {
      importing.resolve({ apply() {} })
      await creating
      importer.mockRestore()
    }
  })

  it('honors stored secret removals without requiring replacement values', async () => {
    const { ctx, gateway, serverId } = await harness()
    const control = ctx.loader.resolve('include:mcp-configuration')
    await control.update({ config: { entries: { [serverId]: { envUnset: ['TOKEN'] } } } })
    expect((await gateway.list()).entries.find(row => row.entryId === serverId)?.env).toEqual([])
    expect(ctx.loader.resolve(serverId).options.config).toMatchObject({ env: {} })
  })

  it('settles queued reads without reapplying entries after the control plane is disposed', async () => {
    const { ctx, gateway, serverId } = await harness()
    await gateway.list()
    const entry = ctx.loader.resolve(serverId)
    const update = vi.spyOn(entry, 'update')
    const queued = gateway.list()
    await ctx.loader.resolve('include:mcp-configuration').fiber?.dispose()
    await queued
    await gateway.list()
    expect(update).not.toHaveBeenCalled()
    update.mockRestore()
  })

  it('reports a failed rollback instead of swallowing it after a persistence failure', async () => {
    const { ctx, gateway, serverId, readPatch } = await harness()
    const first = await gateway.list()
    const before = await readPatch()
    const entry = ctx.loader.resolve(serverId)
    const update = vi.spyOn(entry, 'update')
    const errors: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => {
      if (message.type === 'error') errors.push(message.args.map(String).join(' '))
    } })
    const mutate = vi.spyOn(ctx.settings, 'mutate').mockImplementationOnce(async () => {
      update.mockRejectedValueOnce(new Error('synthetic rollback refusal'))
      throw new Error('synthetic write refusal')
    })
    try {
      await expect(gateway.update(serverId, { toolCallTimeoutMs: 9_000 }, first.revision))
        .rejects.toThrow('could not be restored')
      expect(errors.some(message => message.includes('runtime rollback failed'))).toBe(true)
      expect(await readPatch()).toBe(before)
    } finally {
      mutate.mockRestore()
      update.mockRestore()
    }
  })

  it('rolls back if Settings disappears while the selected connection is being replaced', async () => {
    const { ctx, gateway, serverId, readPatch } = await harness()
    const first = await gateway.list()
    const before = await readPatch()
    const entry = ctx.loader.resolve(serverId)
    const update = entry.update.bind(entry)
    const spy = vi.spyOn(entry, 'update').mockImplementationOnce(async (options) => {
      await update(options)
      await ctx.loader.resolve('include:settings').fiber?.dispose()
    })
    try {
      await expect(gateway.update(serverId, { toolCallTimeoutMs: 9_000 }, first.revision))
        .rejects.toMatchObject({ code: 'mcp/write-failed' })
      expect(entry.options.config).toMatchObject({ toolCallTimeoutMs: 1_000 })
      expect(await readPatch()).toBe(before)
    } finally {
      spy.mockRestore()
    }
  })

  it('reconciles after the owning include schedules a configuration write', async () => {
    const { ctx, gateway, serverId } = await harness(2_500)
    const entry = ctx.loader.resolve(serverId)
    entry.parent.tree.write()
    expect((await gateway.list()).entries.find(row => row.entryId === serverId)?.toolCallTimeoutMs).toBe(2_500)
  })
})
