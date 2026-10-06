// @vitest-environment jsdom
/** MCP-only tabs retain loaded entries across refreshes and retry read failures. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { McpConfigurationEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { McpSettingsTab, type McpSettingsTabProps } from '../src/client/McpSettingsTab.tsx'
import type { McpInventoryState } from '../src/client/mcp-inventory-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const entry: McpConfigurationEntry = {
  entryId: 'include:mcp-fixture', moduleName: '@deepseek-ai/dsh-mcp-client',
  enabled: true, fiberPhase: 'active', transport: 'stdio', serverName: 'fixture',
  command: 'node', args: [], env: [], headers: [], toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  revision: 0,
}

function renderTab(state: Partial<McpInventoryState> = {}) {
  const store = createSnapshotStore<McpInventoryState>({
    status: 'ready', writable: true, revision: 0, entries: [], ...state,
  })
  const retryMcp = vi.fn()
  const updateMcp = vi.fn<McpSettingsTabProps['updateMcp']>().mockResolvedValue()
  const props = {
    t: (key: keyof typeof en) => en[key],
    useMcpInventory: bindSnapshotSelector(store), retryMcp, updateMcp,
  } as McpSettingsTabProps
  render(<McpSettingsTab {...props} />)
  return { store, retryMcp, updateMcp }
}

describe('McpSettingsTab', () => {
  it('shows the empty state only after an authoritative empty response', () => {
    renderTab()
    expect(screen.getByText(en.mcpEmpty)).toBeTruthy()
  })

  it('withholds the empty state while the gateway is unavailable', () => {
    renderTab({ status: 'unavailable' })
    expect(screen.queryByText(en.mcpEmpty)).toBeNull()
  })

  it('announces loading without prematurely reporting no configured entries', () => {
    renderTab({ status: 'loading' })
    expect(screen.getByRole('status', { name: en.mcpLoading })).toBeTruthy()
    expect(screen.queryByText(en.mcpEmpty)).toBeNull()
  })

  it.each(['ready', 'loading', 'error'] as const)('keeps configured entries visible while %s', (status) => {
    renderTab({ status, entries: [entry] })
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}` }))
    expect(screen.getByRole('button', { name: `${en.expand}: mcp-fixture, ${en.mcpEnabled}` })).toBeTruthy()
    expect(screen.queryByRole('status', { name: en.mcpLoading })).toBeNull()
    expect(screen.queryByText(en.mcpEmpty)).toBeNull()
  })

  it.each([{ entries: [] }, { entries: [entry] }])('offers retry after a failed read without clearing existing cards', ({ entries }) => {
    const { retryMcp } = renderTab({ status: 'error', entries })
    expect(screen.getByRole('status').textContent).toBe(en.mcpLoadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.mcpRetry }))
    expect(retryMcp).toHaveBeenCalledOnce()
  })
})
