/** Temporary profile with real persistence and a transport-free MCP bridge fixture. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { Config } from '../src/index.ts'
import { MCP_CLIENT_MODULE, McpConfigurationGateway } from '../src/configuration.ts'

export async function configurationFixture(savedTimeout?: number, observedTimeouts?: number[], legacy = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mcp-settings-profile-')))
  const contexts: Context[] = []
  const warnings: string[] = []
  onTestFinished(async () => {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const bridge = {
    transport: 'stdio', serverName: 'fixture', command: 'echo', args: ['hello'],
    env: { TOKEN: 'secret-value' }, cwd: '', toolCallTimeoutMs: 1_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'mcp-fixture', name: MCP_CLIENT_MODULE, config: bridge },
    { id: 'mcp-sibling', name: MCP_CLIENT_MODULE, config: { ...bridge, serverName: 'sibling' } },
    { id: 'mcp-configuration', name: legacy ? MCP_CLIENT_MODULE : 'cordis:configuration',
      ...legacy ? { config: { mode: 'configuration', retained: 'unrelated' } } : {} },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  if (savedTimeout !== undefined) {
    await writeFile(profile.patchPath, JSON.stringify([{
      id: 'mcp-configuration', config: { entries: { 'include:mcp-fixture': { toolCallTimeoutMs: savedTimeout } } },
    }]))
  }
  let rejected = 0
  const transportFixture = {
    Config,
    apply(_ctx: Context, config: { toolCallTimeoutMs: number }) {
      observedTimeouts?.push(config.toolCallTimeoutMs)
      if (observedTimeouts !== undefined && config.toolCallTimeoutMs === savedTimeout && rejected++ < 2) {
        throw new Error('synthetic connection refusal')
      }
    },
  }
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => {
        if (message.type === 'warn') warnings.push(message.args.map(String).join(' '))
      } })
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, configuration: McpConfigurationGateway })
      ctx.loader.internal = {
        version: 'v2',
        loadCache: new Map(),
        register() { throw new Error('Fixture imports do not register module hooks') },
        async getOrCreateModuleJob() { throw new Error('Fixture imports do not expose module jobs') },
        resolveSync() { throw new Error('Fixture imports resolve only known modules') },
        async load() { throw new Error('Fixture imports do not load source text') },
        async import(specifier: string) {
          if (specifier === `${MCP_CLIENT_MODULE}/configuration`) return McpConfigurationGateway
          if (specifier !== MCP_CLIENT_MODULE) throw new Error(`unexpected Loader import: ${specifier}`)
          return transportFixture
        },
      }
    })
    contexts.push(ctx)
    const gateway = ctx.get('mcpConfiguration') as McpConfigurationGateway
    return { ctx, gateway }
  }
  const { ctx, gateway } = await start()
  return {
    ctx, gateway, serverId: 'include:mcp-fixture', siblingId: 'include:mcp-sibling',
    profile, home, start, warnings, readPatch: () => readFile(profile.patchPath, 'utf8'),
  }
}
