import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  MCP_CLIENT_MODULE, McpConfigurationGateway,
} from '../src/configuration.ts'

class MemorySettings extends SettingsProvider {
  readonly writes: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  private readonly stored: Record<string, unknown>

  constructor(ctx: Context) {
    super(ctx)
    this.stored = {}
  }

  override get writable(): boolean {
    return true
  }

  seed(document: Record<string, unknown>): void {
    this.publish(document)
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.writes.push({ ns, section: structuredClone(section) })
    this.stored[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(savedTimeout?: number, observedTimeouts?: number[]): Promise<{
  ctx: Context
  gateway: McpConfigurationGateway
  serverId: string
  settings: MemorySettings
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(Loader).await()
  // The test entries are real Loader fibers, but their module is a no-op. The
  // configuration gateway still exercises the same Entry.update path used in
  // production, without starting an external MCP process.
  let rejected = 0
  ctx.loader.builtins.mcp = (_ctx: Context, config: { toolCallTimeoutMs?: number }) => {
    if (typeof config.toolCallTimeoutMs === 'number') observedTimeouts?.push(config.toolCallTimeoutMs)
    if (observedTimeouts !== undefined && config.toolCallTimeoutMs === savedTimeout && rejected++ < 2) {
      throw new Error('synthetic reload refusal')
    }
  }
  const serverId = await ctx.loader.create({
    name: 'cordis:mcp',
    config: {
      transport: 'stdio',
      serverName: 'fixture',
      command: 'echo',
      args: ['hello'],
      env: { TOKEN: 'secret-value' },
      cwd: '',
      toolCallTimeoutMs: 1_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    },
  })
  // Loader's builtin resolver only handles the `cordis:` namespace. Re-label
  // the already-running fixture so the gateway sees the exact production
  // module specifier while retaining the no-op runtime callback.
  ctx.loader.resolve(serverId).options.name = MCP_CLIENT_MODULE
  const controlId = await ctx.loader.create({
    name: 'cordis:mcp',
    config: { mode: 'configuration' },
  })
  ctx.loader.resolve(controlId).options.name = MCP_CLIENT_MODULE
  if (savedTimeout !== undefined) {
    const settings = ctx.settings as unknown as MemorySettings
    settings.seed({ 'mcp-client': { entries: { [serverId]: { toolCallTimeoutMs: savedTimeout } } } })
  }
  await ctx.plugin(McpConfigurationGateway).await()
  return {
    ctx,
    gateway: ctx.get('mcpConfiguration') as McpConfigurationGateway,
    serverId,
    settings: ctx.get('settings') as unknown as MemorySettings,
  }
}

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
    await harness(2_500, observed)
    await new Promise<void>(resolve => setImmediate(resolve))
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
    expect(snapshot.entries).toHaveLength(1)
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
    const { ctx, gateway, serverId, settings } = await harness()
    const first = await gateway.list()
    const entry = ctx.loader.resolve(serverId)
    const sibling = [...ctx.loader.entries()].find(candidate => candidate.id !== serverId
      && candidate.options.name === MCP_CLIENT_MODULE)!
    const siblingBefore: unknown = structuredClone(sibling.options.config)

    const next = await gateway.update(serverId, { toolCallTimeoutMs: 2_000 }, first.revision)
    expect(next.entries.find(item => item.entryId === serverId)?.toolCallTimeoutMs).toBe(2_000)
    expect(entry.options.config).toMatchObject({ toolCallTimeoutMs: 2_000 })
    expect(sibling.options.config).toEqual(siblingBefore)
    expect(settings.writes.at(-1)).toMatchObject({
      ns: 'mcp-client',
      section: { entries: { [serverId]: { toolCallTimeoutMs: 2_000 } } },
    })
  })

  it('keeps inherited arguments after asynchronous settings observers apply a narrow override', async () => {
    const { gateway, serverId } = await harness()
    const first = await gateway.list()
    await gateway.update(serverId, { toolCallTimeoutMs: 2_000 }, first.revision)
    await new Promise<void>(resolve => setImmediate(resolve))
    const settled = await gateway.list()
    expect(settled.entries.find(entry => entry.entryId === serverId)?.args).toEqual(['hello'])
    await gateway.update(serverId, { toolCallTimeoutMs: 3_000 }, settled.revision)
    await new Promise<void>(resolve => setImmediate(resolve))
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
})
