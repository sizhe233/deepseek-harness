/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { PluginsSettingsSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { McpConfigurationSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { McpInventoryFace } from '../src/client/mcp-inventory-controller.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** The Settings shell's section slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one Built-in plugins section and declares its tab slot, contributing no tab of its own', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('内置插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('injects a live tab projection ordered by the contributions', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as () => Pick<PluginsSettingsSectionInjected, 'hooks'>)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const unsubscribe = sectionFace.hooks.tabs.subscribe(vi.fn())
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    slots.register({ name: 'settings.plugins.tab', id: 'first', order: -1 } as never, () => null)
    // Tabs follow their contribution's order, whatever order they registered in.
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'first', order: -1, label: '' },
      { id: 'plain', order: 0, label: '' },
    ])
    unsubscribe()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses the section on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})

/** Mount only the MCP namespace, independently of generic plugin settings. */
async function mcpBench() {
  const { ctx, slots } = await bench()
  const empty: McpConfigurationSnapshot = { writable: true, revision: 4, entries: [] }
  type Reply = { ok: true; value: McpConfigurationSnapshot } | { ok: false; error: RemoteError }
  const listMcp = vi.fn<() => Promise<Reply>>().mockResolvedValue({ ok: true, value: empty })
  const updateMcp = vi.fn<(...args: Parameters<McpInventoryFace['updateMcp']>) => Promise<Reply>>()
    .mockResolvedValue({ ok: true, value: { ...empty, revision: 5 } })
  new TestRemote(ctx, { mcpConfiguration: { list: listMcp, update: updateMcp } })
  declareRoot(slots)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await vi.waitFor(() => { expect(slots.entries('settings.plugins.tab')).toHaveLength(1) })
  const tab = slots.entries('settings.plugins.tab')[0]!
  const face = (tab.inject as () => Pick<McpInventoryFace, keyof McpInventoryFace>)()
  return { ctx, slots, listMcp, updateMcp, fiber, tab, face }
}

describe('ui-settings-plugins MCP tab', () => {
  it('loads configuration and forwards revision-fenced edits through its own tab', async () => {
    const { tab, face, listMcp, updateMcp } = await mcpBench()
    expect(tab.options).toMatchObject({ id: 'mcp', order: 0 })
    expect(resolveSlotLabel(tab.options.label)).toBe('MCP')
    await vi.waitFor(() => { expect(face.hooks.mcpInventory.getSnapshot().status).toBe('ready') })
    expect(listMcp).toHaveBeenCalledOnce()
    await face.updateMcp('include:mcp-fixture', { enabled: false })
    expect(updateMcp).toHaveBeenCalledWith('include:mcp-fixture', { enabled: false }, 4)
    expect(face.hooks.mcpInventory.getSnapshot().revision).toBe(5)
  })

  it('refreshes after reconnect and removes its tab and listener with the fiber', async () => {
    const { ctx, slots, listMcp, fiber } = await mcpBench()
    await vi.waitFor(() => { expect(listMcp).toHaveBeenCalledOnce() })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(listMcp).toHaveBeenCalledTimes(2) })
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    ctx.emit('connection/reset')
    expect(listMcp).toHaveBeenCalledTimes(2)
  })

  it('reports read errors and recovers through the retry action', async () => {
    const { face, listMcp } = await mcpBench()
    await vi.waitFor(() => { expect(face.hooks.mcpInventory.getSnapshot().status).toBe('ready') })
    listMcp.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    face.retryMcp()
    await vi.waitFor(() => { expect(face.hooks.mcpInventory.getSnapshot().status).toBe('error') })
    face.retryMcp()
    await vi.waitFor(() => { expect(face.hooks.mcpInventory.getSnapshot().status).toBe('ready') })
  })

  it('rejects a failed mutation and keeps the last confirmed snapshot', async () => {
    const { face, updateMcp } = await mcpBench()
    await vi.waitFor(() => { expect(face.hooks.mcpInventory.getSnapshot().status).toBe('ready') })
    updateMcp.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'read-only', {}) })
    await expect(face.updateMcp('include:mcp-fixture', { enabled: false })).rejects.toThrow('read-only')
    expect(face.hooks.mcpInventory.getSnapshot().revision).toBe(4)
  })
})
