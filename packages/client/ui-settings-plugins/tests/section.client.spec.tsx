// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { ConfigurablePluginsTab } from '../src/client/ConfigurablePluginsTab.tsx'
import type { ConfigurablePluginsTabProps } from '../src/client/ConfigurablePluginsTab.tsx'
import { McpCards } from '../src/client/McpCards.tsx'
import type { McpCardsProps } from '../src/client/McpCards.tsx'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import { SubagentModelSelectionCard } from '../src/client/SubagentModelSelectionCard.tsx'
import type { SubagentModelSelectionCardProps } from '../src/client/SubagentModelSelectionCard.tsx'
import { WebSearchCard } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { ConfigurablePluginsTabState } from '../src/client/tab-store.ts'
import type { McpInventoryState } from '../src/client/mcp-inventory-controller.ts'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import type { McpConfigurationEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const DEFAULT_RECONNECT_FIXTURE = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
}

function mcpFixture(overrides: Partial<McpConfigurationEntry>): McpConfigurationEntry {
  return {
    entryId: 'mcp-fixture',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    enabled: true,
    fiberPhase: 'active',
    transport: 'stdio',
    serverName: 'fixture',
    command: 'node',
    args: [],
    cwd: '',
    env: [],
    headers: [],
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { ...DEFAULT_RECONNECT_FIXTURE },
    revision: 0,
    ...overrides,
  }
}

const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const props = {
    t,
    useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
    renderSlot: (_name: string, _owner: unknown, options: { only?: string }) => (
      <span>{options.only}</span>
    ),
  } as unknown as PluginsSettingsSectionProps
  render(<PluginsSettingsSection {...props} />)
}

function renderConfigurable(
  namespaces: string[],
  cards: Record<string, string> = {},
  loaded = true,
  mcp: McpInventoryState = { status: 'unavailable', writable: false, revision: 0, entries: [] },
) {
  const store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded, namespaces })
  const mcpStore = createSnapshotStore<McpInventoryState>(mcp)
  const retryMcp = vi.fn()
  const updateMcp = vi.fn<NonNullable<ConfigurablePluginsTabProps['updateMcp']>>().mockResolvedValue()
  const props = {
    t,
    useConfigurablePlugins: bindSnapshotSelector(store),
    useMcpInventory: bindSnapshotSelector(mcpStore),
    retryMcp,
    updateMcp,
    renderSlot: (_name: string, _owner: object, opts?: { entryKey?: string }) => {
      const card = opts?.entryKey === undefined ? undefined : cards[opts.entryKey]
      return card === undefined ? null : <li>{card}</li>
    },
  } as unknown as ConfigurablePluginsTabProps
  render(<ConfigurablePluginsTab {...props} />)
  return { retryMcp, updateMcp }
}

function renderBashCard(state: Partial<BashCardState> = {}) {
  const store = createSnapshotStore<BashCardState>({
    ...settled,
    timeoutMs: field('60000'),
    maxOutputBytes: field('64000'),
    ...state,
  })
  const actions = cardActions()
  const props = { ...actions, t, useBashCard: bindSnapshotSelector(store) } as unknown as BashCardProps
  render(<BashCard {...props} />)
  return { actions, store }
}

function renderBash(state: Partial<BashCardState> = {}) {
  return renderBashCard(state).actions
}

function renderSubagentModelSelection(state: Partial<SubagentModelSelectionCardState> = {}) {
  const store = createSnapshotStore<SubagentModelSelectionCardState>({
    ...settled,
    enabled: false,
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    conflicted: false,
    ...state,
  })
  const actions = {
    toggleEnabled: vi.fn(),
    toggleModel: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = {
    ...actions,
    t,
    useSubagentModelSelectionCard: bindSnapshotSelector(store),
  } as unknown as SubagentModelSelectionCardProps
  render(<SubagentModelSelectionCard {...props} />)
  return actions
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a tab', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('configurable')).toBeTruthy()
    expect(screen.queryByText('all')).toBeNull()

    fireEvent.click(all)
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all')).toBeTruthy()
    expect(screen.getByText('configurable').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('leads with its own heading and intro', () => {
    renderSection([{ id: 'configurable', order: 0, label: en.configurableTab }])

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
      { id: 'diagnostics', order: 20, label: 'Diagnostics' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' })
    expect(configurable.getAttribute('tabindex')).toBe('0')
    expect(all.getAttribute('tabindex')).toBe('-1')

    configurable.focus()
    fireEvent.keyDown(configurable, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(all)
    expect(all.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(configurable)
    fireEvent.keyDown(configurable, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'Home' })
    expect(document.activeElement).toBe(configurable)

    fireEvent.keyDown(configurable, { key: 'Escape' })
    expect(document.activeElement).toBe(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ConfigurablePluginsTab', () => {
  it('says so when no plugin contributed a card', () => {
    renderConfigurable([], { bash: 'shell' })

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('shell')).toBeNull()
  })

  it('withholds the empty line until the Host has answered once', () => {
    // An unanswered read is not the statement that this deployment configures
    // no plugin; saying it anyway would flash a wrong answer on every open.
    renderConfigurable([], { bash: 'shell' }, false)

    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('dispatches one card per namespace, keyed by it', () => {
    renderConfigurable(['bash', 'agent-loop'], { bash: 'shell', 'agent-loop': 'loop' })

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['shell', 'loop'])
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('appends one MCP group card after ordinary plugin cards', () => {
    const { retryMcp } = renderConfigurable(
      ['web-search-deepseek'],
      { 'web-search-deepseek': 'web search' },
      true,
      {
        status: 'ready', writable: false, revision: 0,
        entries: [
          mcpFixture({ entryId: 'include:mcp-js-reverse', serverName: 'js-reverse' }),
          mcpFixture({ entryId: 'include:mcp-chrome-devtools', serverName: 'chrome-devtools' }),
        ],
      },
    )

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'web search',
      `${en.mcpTitle}${en.mcpDescription}2 ${en.mcpConfigured}`,
    ])
    const group = document.querySelector('[data-mcp-group]') as HTMLElement
    expect(group).toBeTruthy()
    expect(group.querySelectorAll('[data-mcp-entry]')).toHaveLength(0)
    const groupButton = screen.getByRole('button', {
      name: `${en.expand}: ${en.mcpTitle}, 2 ${en.mcpConfigured}`,
    })
    fireEvent.click(groupButton)
    expect(group.querySelectorAll('[data-mcp-entry]')).toHaveLength(2)
    expect(Array.from(group.querySelectorAll('[data-mcp-entry]')).map(item => item.getAttribute('data-mcp-entry'))).toEqual([
      'include:mcp-js-reverse', 'include:mcp-chrome-devtools',
    ])
    const chromeButton = screen.getByRole('button', { name: `${en.expand}: mcp-chrome-devtools, ${en.mcpEnabled}` })
    fireEvent.click(chromeButton)
    expect(screen.getByText('include:mcp-chrome-devtools')).toBeTruthy()
    expect(retryMcp).not.toHaveBeenCalled()
  })

  it('shows a retryable MCP status when the inventory read fails', () => {
    const { retryMcp } = renderConfigurable([], {}, true, {
      status: 'error', writable: false, revision: 0, entries: [],
    })

    expect(screen.getByRole('status').textContent).toBe(en.mcpLoadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.mcpRetry }))
    expect(retryMcp).toHaveBeenCalledOnce()
  })

  it('keeps ordinary cards visible while an MCP inventory read is pending', () => {
    renderConfigurable(['web-search-deepseek'], { 'web-search-deepseek': 'web search' }, true, {
      status: 'loading', writable: false, revision: 0, entries: [],
    })

    expect(screen.getByText('web search')).toBeTruthy()
    expect(screen.queryByText(en.mcpLoading)).toBeNull()
  })

  it('shows the MCP loading state when no ordinary cards are available yet', () => {
    renderConfigurable([], {}, false, { status: 'loading', writable: false, revision: 0, entries: [] })

    expect(screen.getByText(en.mcpLoading)).toBeTruthy()
  })

  it('shows a retryable MCP notice below ordinary cards after a failed read', () => {
    const { retryMcp } = renderConfigurable(['web-search-deepseek'], { 'web-search-deepseek': 'web search' }, true, {
      status: 'error', writable: false, revision: 0, entries: [],
    })

    expect(screen.getByText('web search')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.mcpLoadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.mcpRetry }))
    expect(retryMcp).toHaveBeenCalledOnce()
  })
})

describe('McpCards', () => {
  it('reveals editable transport fields without returning secret values', () => {
    const updateMcp = vi.fn<NonNullable<McpCardsProps['updateMcp']>>().mockResolvedValue()
    const props: McpCardsProps = {
      t,
      writable: true,
      updateMcp,
      entries: [{
        entryId: 'include:mcp-chrome-devtools',
        moduleName: '@deepseek-ai/dsh-mcp-client',
        enabled: true,
        fiberPhase: 'active',
        transport: 'streamable-http',
        serverName: 'chrome-devtools',
        url: 'http://127.0.0.1:9222/mcp',
        headers: [{ key: 'Authorization', configured: true }],
        env: [],
        args: [],
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
        reconnect: { ...DEFAULT_RECONNECT_FIXTURE },
        revision: 3,
      }],
    }
    render(<ul><McpCards {...props} /></ul>)

    fireEvent.click(screen.getByRole('button', {
      name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}`,
    }))
    const card = screen.getByRole('button', { name: `${en.expand}: mcp-chrome-devtools, ${en.mcpEnabled}` })
    fireEvent.click(card)
    expect(screen.getByText('include:mcp-chrome-devtools')).toBeTruthy()
    expect(screen.getByText('@deepseek-ai/dsh-mcp-client')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpUrl).value).toBe('http://127.0.0.1:9222/mcp')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.mcpSecretValue} 1`).value).toBe('')
    expect(screen.queryByDisplayValue('super-secret')).toBeNull()
  })

  it('submits a narrow patch and keeps the entry open after a live reload', async () => {
    const updateMcp = vi.fn<NonNullable<McpCardsProps['updateMcp']>>().mockResolvedValue()
    render(<ul><McpCards
      t={t}
      writable
      updateMcp={updateMcp}
      entries={[{
        entryId: 'mcp-js-reverse',
        moduleName: '@deepseek-ai/dsh-mcp-client',
        enabled: true,
        fiberPhase: 'active',
        transport: 'stdio',
        serverName: 'js-reverse',
        command: 'node',
        args: ['server.js'],
        cwd: '/tmp',
        env: [{ key: 'TOKEN', configured: true }],
        headers: [],
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
        reconnect: { ...DEFAULT_RECONNECT_FIXTURE },
        revision: 4,
      }]}
    /></ul>)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}` }))
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: mcp-js-reverse, ${en.mcpEnabled}` }))
    fireEvent.change(screen.getByLabelText(en.mcpTimeout), { target: { value: '60001' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(updateMcp).toHaveBeenCalledWith('mcp-js-reverse', { toolCallTimeoutMs: 60001 }) })
    expect(screen.getByText(en.mcpReloaded)).toBeTruthy()
  })

  it('clears a write-only key only when its row is explicitly removed', async () => {
    const updateMcp = vi.fn<NonNullable<McpCardsProps['updateMcp']>>().mockResolvedValue()
    render(<ul><McpCards
      t={t}
      writable
      updateMcp={updateMcp}
      entries={[mcpFixture({
        entryId: 'mcp-secret',
        env: [{ key: 'TOKEN', configured: true }],
      })]}
    /></ul>)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}` }))
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: mcp-secret, ${en.mcpEnabled}` }))
    fireEvent.click(screen.getByRole('button', { name: `${en.mcpRemoveSecret} TOKEN` }))
    fireEvent.change(screen.getByLabelText(en.mcpTimeout), { target: { value: '60001' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(updateMcp).toHaveBeenCalledWith('mcp-secret', {
        toolCallTimeoutMs: 60001,
        env: { unset: ['TOKEN'] },
      })
    })
  })

  it('renders disabled and unobserved entries and collapses an open card', () => {
    const props: McpCardsProps = {
      t,
      entries: [mcpFixture({ entryId: 'mcp-disabled', enabled: false, fiberPhase: null })],
    }
    render(<ul><McpCards {...props} /></ul>)

    fireEvent.click(screen.getByRole('button', {
      name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}`,
    }))
    const card = screen.getByRole('button', { name: `${en.expand}: mcp-disabled, ${en.mcpDisabled}` })
    expect(screen.getByText(en.mcpDisabled)).toBeTruthy()
    fireEvent.click(card)
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.mcpUnobserved)).toBeTruthy()
    fireEvent.click(card)
    expect(card.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders no nodes for an empty entry set', () => {
    const { container } = render(<ul><McpCards t={t} entries={[]} /></ul>)
    expect(container.querySelector('[data-mcp-entry]')).toBeNull()
  })

  it('labels every observed Fiber phase in the nested details', () => {
    const phases = [
      ['mcp-pending', 'pending', 'mcpPending'],
      ['mcp-loading', 'loading', 'mcpLoadingPhase'],
      ['mcp-active', 'active', 'mcpMounted'],
      ['mcp-failed', 'failed', 'mcpFailed'],
      ['mcp-unloading', 'unloading', 'mcpUnloading'],
      ['mcp-unobserved', null, 'mcpUnobserved'],
    ] as const
    render(<ul><McpCards t={t} entries={phases.map(([entryId, fiberPhase]) => (
      mcpFixture({ entryId, fiberPhase })
    ))} /></ul>)

    fireEvent.click(screen.getByRole('button', {
      name: `${en.expand}: ${en.mcpTitle}, 6 ${en.mcpConfigured}`,
    }))
    for (const [entryId, _fiberPhase, key] of phases) {
      fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${entryId}, ${en.mcpEnabled}` }))
      expect(screen.getByText(en[key])).toBeTruthy()
    }
  })
})

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderBash()
    expect(screen.getByText(en.bashTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.bashMaxOutputBytes)).toBeTruthy()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashTimeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('addresses each of its two fields separately', () => {
    const actions = renderBash({ maxOutputBytes: field('64000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashMaxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
  })

  it('keeps save and discard inert until something is staged', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes the staged edits when saved, and drops them when discarded', () => {
    const actions = renderBash({ dirty: true, timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('marks a card holding unsaved edits, collapsed or not', () => {
    renderBash({ dirty: true })

    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('blocks the save while a draft is invalid, and says why', () => {
    renderBash({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('reports a save in flight and refuses another', () => {
    renderBash({ dirty: true, saving: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('reports a save the deployment did not accept', () => {
    renderBash({ dirty: true, failed: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })

  it('collapses again on a second click', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))
    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })

  it('collapses after a successful save settles', () => {
    const { actions, store } = renderBashCard({ dirty: true })
    fireEvent.click(screen.getByText(en.bashTitle))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()

    act(() => { store.set({ ...store.getSnapshot(), saving: true }) })
    act(() => { store.set({ ...store.getSnapshot(), dirty: false, saving: false }) })

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })

  it('keeps a failed save open', () => {
    const { store } = renderBashCard({ dirty: true })
    fireEvent.click(screen.getByText(en.bashTitle))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    act(() => { store.set({ ...store.getSnapshot(), saving: true }) })
    act(() => { store.set({ ...store.getSnapshot(), failed: true, saving: false }) })

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })
})

describe('SubagentModelSelectionCard', () => {
  it('renders the default-off preference in its staged plugin card', () => {
    const actions = renderSubagentModelSelection()
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))

    const control = screen.getByRole('switch', { name: en.subagentModelSelectionToggle })
    expect(control.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(control)

    expect(actions.toggleEnabled).toHaveBeenCalledOnce()
  })

  it('groups available adapter candidates by provider', () => {
    const actions = renderSubagentModelSelection({
      enabled: true,
      candidates: [
        {
          key: 'alpha\0fast',
          provider: 'alpha',
          model: 'fast',
          providerName: 'Alpha API',
          modelName: 'Fast',
          available: true,
          selected: true,
        },
        {
          key: 'alpha\0deep',
          provider: 'alpha',
          model: 'deep',
          providerName: 'Alpha API',
          modelName: 'Deep',
          available: true,
          selected: false,
        },
      ],
      catalogStatus: 'ready',
    })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))

    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Alpha API', { exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Deep/ }))
    expect(actions.toggleModel).toHaveBeenCalledWith('alpha\0fast')
    expect(actions.toggleModel).toHaveBeenCalledWith('alpha\0deep')
  })

  it('renders directory progress, failures, unavailable routes, and validation', () => {
    renderSubagentModelSelection({ enabled: true, catalogStatus: 'loading', invalid: true })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    expect(screen.getByText(en.subagentModelSelectionLoading)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionRequired)).toBeTruthy()

    cleanup()
    const errorActions = renderSubagentModelSelection({ enabled: true, catalogStatus: 'error' })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    fireEvent.click(screen.getByRole('button', { name: en.subagentModelSelectionRetry }))
    expect(errorActions.retryCatalog).toHaveBeenCalledOnce()

    cleanup()
    renderSubagentModelSelection({
      enabled: true,
      catalogStatus: 'ready',
      catalogPartial: true,
      candidates: [{
        key: 'legacy\0old',
        provider: 'legacy',
        model: 'old',
        providerName: 'legacy',
        modelName: 'old',
        available: false,
        selected: true,
      }],
    })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    expect(screen.getByText(en.subagentModelSelectionPartial)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionUnavailable)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionUnavailableGroup)).toBeTruthy()

    cleanup()
    renderSubagentModelSelection({ enabled: true, catalogStatus: 'ready' })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    expect(screen.getByText(en.subagentModelSelectionEmpty)).toBeTruthy()
  })

  it('distinguishes a stale draft from a rejected save', () => {
    renderSubagentModelSelection({ dirty: true, conflicted: true })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))

    expect(screen.getByText(en.subagentModelSelectionConflict)).toBeTruthy()
    expect(screen.queryByText(en.saveFailed)).toBeNull()
  })

  it('stays hidden when unavailable and disables writes when read-only', () => {
    renderSubagentModelSelection({ available: false })
    expect(screen.queryByText(en.subagentModelSelectionTitle)).toBeNull()

    cleanup()
    const actions = renderSubagentModelSelection({ writable: false })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    const control = screen.getByRole('switch') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    fireEvent.click(control)
    expect(actions.toggleEnabled).not.toHaveBeenCalled()
  })
})

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      dirty: true,
      maxParallelToolCalls: field('10'),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      maxParallelToolCalls: field('2', { overridden: true }),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })
})

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      baseURL: field(''),
      maxUses: field('5'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, t, useWebSearchCard: bindSnapshotSelector(store) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByText(en.webSearchApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const key = screen.getByLabelText(en.webSearchApiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    fireEvent.change(screen.getByLabelText(en.webSearchBaseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.webSearchMaxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})
