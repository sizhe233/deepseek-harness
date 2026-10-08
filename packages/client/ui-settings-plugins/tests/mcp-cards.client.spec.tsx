// @vitest-environment jsdom
/** Editable MCP cards preserve redaction and submit only changed configuration. */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpConfigurationEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { McpCards, type McpCardsProps } from '../src/client/McpCards.tsx'
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


function editor(entry: McpConfigurationEntry = mcpFixture({})) {
  const updateMcp = vi.fn<NonNullable<McpCardsProps['updateMcp']>>().mockResolvedValue()
  let props: McpCardsProps = { t, entries: [entry], writable: true, updateMcp }
  const view = render(<ul><McpCards {...props} /></ul>)
  fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.mcpTitle}, 1 ${en.mcpConfigured}` }))
  fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${entry.entryId}, ${entry.enabled ? en.mcpEnabled : en.mcpDisabled}` }))
  const rerender = (next: Partial<McpCardsProps>) => {
    props = { ...props, ...next }
    view.rerender(<ul><McpCards {...props} /></ul>)
  }
  return { updateMcp, rerender, submit: () => fireEvent.submit(view.container.querySelector('form')!),
    withdrawWriter: () => { delete props.updateMcp; view.rerender(<ul><McpCards {...props} /></ul>) } }
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('MCP editor drafts and validation', () => {
  it.each([
    ['mcpServerName', 'bad name', 'mcpInvalidServerName'],
    ['mcpCommand', ' ', 'mcpCommandRequired'],
    ['mcpTimeout', '', 'mcpInvalidNumber'],
    ['mcpTimeout', '0', 'mcpInvalidNumber'],
    ['mcpTimeout', '9007199254740992', 'mcpInvalidNumber'],
    ['mcpInitialDelay', '', 'mcpInvalidNumber'],
    ['mcpMaxDelay', '', 'mcpInvalidNumber'],
    ['mcpMaxAttempts', '', 'mcpInvalidNumber'],
    ['mcpInitialDelay', '30001', 'mcpReconnectOrder'],
  ] as const)('blocks invalid %s without dropping the staged value', (field, value, error) => {
    const ui = editor()
    change(en[field], value)
    expect(screen.getByRole('alert').textContent).toBe(en[error])
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    ui.submit()
    expect(ui.updateMcp).not.toHaveBeenCalled()
  })

  it.each(['not a URL', 'file:///tmp/server'])('refuses HTTP endpoint %s', (url) => {
    const ui = editor(mcpFixture({ transport: 'streamable-http', url: 'https://example.test/mcp' }))
    change(en.mcpUrl, url)
    expect(screen.getByRole('alert').textContent).toBe(en.mcpUrlRequired)
    ui.submit()
    expect(ui.updateMcp).not.toHaveBeenCalled()
  })

  it('submits all changed scalar and reconnect controls while preserving argument boundaries', async () => {
    const { updateMcp } = editor(mcpFixture({ args: ['old', 'value'] }))
    change(en.mcpServerName, 'renamed')
    change(en.mcpCommand, 'python')
    fireEvent.change(screen.getByRole('textbox', { name: /^Arguments/ }), { target: { value: '--label\r\nnew value\n\n' } })
    change(en.mcpCwd, '/workspace/project')
    change(en.mcpTimeout, '61000')
    change(en.mcpInitialDelay, '600')
    change(en.mcpMaxDelay, '40000')
    change(en.mcpMaxAttempts, '12')
    fireEvent.click(screen.getByLabelText(en.mcpFailOnStartup))
    fireEvent.click(screen.getByLabelText(en.mcpReconnectEnabled))
    fireEvent.click(screen.getByLabelText(en.mcpEnabledToggle))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(updateMcp).toHaveBeenCalledWith('mcp-fixture', {
        serverName: 'renamed', command: 'python', args: ['--label', 'new value'], cwd: '/workspace/project',
        toolCallTimeoutMs: 61000, enabled: false, failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 600, maxDelayMs: 40000, maxAttempts: 12 },
      })
    })
    expect(screen.getByText(en.mcpReloaded)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${en.collapse}: ${en.mcpTitle}, 1 ${en.mcpConfigured}` }))
    expect(screen.queryByLabelText(en.mcpCommand)).toBeNull()
  })

  it('stages transport changes and leaves validation local until a valid endpoint is saved', async () => {
    const { updateMcp } = editor()
    change(en.mcpTransport, 'streamable-http')
    expect(screen.getByRole('alert').textContent).toBe(en.mcpUrlRequired)
    expect(screen.queryByLabelText(en.mcpCommand)).toBeNull()
    change(en.mcpUrl, 'https://example.test/mcp')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(updateMcp).toHaveBeenCalledWith('mcp-fixture', {
        transport: 'streamable-http', url: 'https://example.test/mcp',
      })
    })
  })

  it.each(['stdio', 'streamable-http'] as const)('edits write-only %s keys without leaking prior values', async (transport) => {
    const kind = transport === 'stdio' ? 'env' : 'headers'
    const { updateMcp } = editor(mcpFixture({ transport, url: 'https://example.test/mcp',
      [kind]: [{ key: 'TOKEN', configured: true }, { key: 'EMPTY', configured: false }],
    }))
    fireEvent.click(screen.getByRole('button', { name: en.mcpAddSecret }))
    expect(screen.queryByRole('alert')).toBeNull()
    change(`${en.mcpSecretValue} 3`, 'new-secret')
    expect(screen.getByRole('alert').textContent).toBe(en.mcpInvalidSecretKey)
    change(`${en.mcpSecretKey} 3`, 'TOKEN')
    expect(screen.getByRole('alert').textContent).toBe(en.mcpDuplicateSecretKey)
    change(`${en.mcpSecretKey} 3`, transport === 'stdio' ? 'bad-key' : 'X'.repeat(257))
    expect(screen.getByRole('alert').textContent).toBe(en.mcpInvalidSecretKey)
    change(`${en.mcpSecretKey} 3`, 'NEW_TOKEN')
    change(`${en.mcpSecretValue} 1`, 'replacement')
    fireEvent.click(screen.getByRole('button', { name: `${en.mcpRemoveSecret} EMPTY` }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(updateMcp).toHaveBeenCalledWith('mcp-fixture', {
        [kind]: { set: { TOKEN: 'replacement', NEW_TOKEN: 'new-secret' }, unset: ['EMPTY'] },
      })
    })
    expect(screen.getByLabelText<HTMLInputElement>(`${en.mcpSecretValue} 1`).value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.mcpSecretValue} 2`).value).toBe('')
  })

  it('discards failed writes and preserves drafts across unrelated revisions', async () => {
    const entry = mcpFixture({})
    const ui = editor(entry)
    ui.submit()
    expect(ui.updateMcp).not.toHaveBeenCalled()
    change(en.mcpTimeout, '61000')
    ui.rerender({ entries: [{ ...entry, revision: 1 }] })
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpTimeout).value).toBe('61000')
    ui.updateMcp.mockRejectedValueOnce(new Error('write rejected'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.mcpSaveFailed) })
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpTimeout).value).toBe('61000')
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpTimeout).value).toBe('60000')
    expect(screen.queryByRole('alert')).toBeNull()
    ui.rerender({ entries: [{ ...entry, revision: 2 }] })
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('blocks repeated submission and retains a pending draft across a revision', async () => {
    const done: PromiseWithResolvers<void> = Promise.withResolvers()
    const entry = mcpFixture({})
    const ui = editor(entry)
    ui.updateMcp.mockReturnValueOnce(done.promise)
    change(en.mcpTimeout, '61000')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    ui.rerender({ entries: [{ ...entry, revision: 1 }] })
    ui.submit()
    expect(ui.updateMcp).toHaveBeenCalledOnce()
    await act(async () => { done.resolve(); await done.promise })
    expect(screen.getByText(en.mcpReloaded)).toBeTruthy()
    change(en.mcpTimeout, '62000')
    expect(screen.queryByText(en.mcpReloaded)).toBeNull()
  })

  it('prevents writes when write permission or the writer disappears during an edit', () => {
    const ui = editor()
    change(en.mcpTimeout, '61000')
    ui.rerender({ writable: false })
    ui.submit()
    expect(ui.updateMcp).not.toHaveBeenCalled()
    ui.rerender({ writable: true })
    ui.withdrawWriter()
    ui.submit()
    expect(ui.updateMcp).not.toHaveBeenCalled()
  })
})
