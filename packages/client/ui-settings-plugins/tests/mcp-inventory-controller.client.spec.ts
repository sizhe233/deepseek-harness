import { describe, expect, it, vi } from 'vitest'
import type { McpConfigurationSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { McpConfigurationPatch } from '@deepseek-ai/dsh-api-remotes/client'
import {
  isMcpInventoryEntry,
  McpInventoryController,
  type McpInventoryState,
} from '../src/client/mcp-inventory-controller.ts'

type Snapshot = McpConfigurationSnapshot

const MCP = {
  entryId: 'include:mcp-browser',
  moduleName: '@deepseek-ai/dsh-mcp-client',
  enabled: true,
  fiberPhase: 'active',
} as const

const OTHER = {
  entryId: 'include:ordinary',
  moduleName: '@fixture/ordinary',
  enabled: true,
  fiberPhase: 'active',
} as const

function snapshot(entries: Snapshot['entries'] = [MCP, OTHER] as never): Snapshot {
  return { writable: true, revision: 0, entries }
}

function state(controller: McpInventoryController): McpInventoryState {
  return controller.inject().hooks.mcpInventory.getSnapshot()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('mcp inventory controller', () => {
  it('keeps the unavailable state when no Host inventory reader exists', () => {
    const controller = new McpInventoryController(undefined)
    expect(state(controller)).toEqual({ status: 'unavailable', writable: false, revision: 0, entries: [] })
    controller.inject().retryMcp()
    expect(state(controller)).toEqual({ status: 'unavailable', writable: false, revision: 0, entries: [] })
    controller.dispose()
    controller.refresh()
    expect(state(controller)).toEqual({ status: 'unavailable', writable: false, revision: 0, entries: [] })
  })

  it('filters the Host snapshot and retries a successful read', async () => {
    const list = vi.fn<() => Promise<Snapshot>>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([MCP] as never))
    const controller = new McpInventoryController(list)

    expect(state(controller).status).toBe('loading')
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    expect(state(controller).entries).toEqual([MCP])
    expect(isMcpInventoryEntry(MCP as never)).toBe(true)
    expect(isMcpInventoryEntry(OTHER as never)).toBe(false)

    controller.inject().retryMcp()
    expect(state(controller).status).toBe('loading')
    await vi.waitFor(() => { expect(state(controller).entries).toEqual([MCP]) })
    expect(list).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('publishes a generic error and recovers through retry', async () => {
    const list = vi.fn<() => Promise<Snapshot>>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(snapshot([MCP] as never))
    const controller = new McpInventoryController(list)

    await vi.waitFor(() => { expect(state(controller).status).toBe('error') })
    expect(state(controller).entries).toEqual([])
    controller.inject().retryMcp()
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    expect(state(controller).entries).toEqual([MCP])
    controller.dispose()
  })

  it('ignores a stale result after a newer refresh wins', async () => {
    const first = deferred<Snapshot>()
    const second = deferred<Snapshot>()
    const list = vi.fn<() => Promise<Snapshot>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = new McpInventoryController(list)

    controller.refresh()
    second.resolve(snapshot([MCP] as never))
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    first.resolve(snapshot([OTHER] as never))
    await Promise.resolve()
    expect(state(controller).entries).toEqual([MCP])
    controller.dispose()
  })

  it('ignores a pending result after disposal', async () => {
    const pending = deferred<Snapshot>()
    const list = vi.fn<() => Promise<Snapshot>>().mockReturnValue(pending.promise)
    const controller = new McpInventoryController(list)
    controller.dispose()
    pending.resolve(snapshot([MCP] as never))
    await Promise.resolve()
    expect(state(controller).status).toBe('loading')
  })

  it('ignores a stale failure after a newer request succeeds', async () => {
    const first = deferred<Snapshot>()
    const second = deferred<Snapshot>()
    const list = vi.fn<() => Promise<Snapshot>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = new McpInventoryController(list)

    controller.refresh()
    second.resolve(snapshot([MCP] as never))
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    first.reject(new Error('late failure'))
    await Promise.resolve()
    expect(state(controller).status).toBe('ready')
    controller.dispose()
  })

  it('serializes updates with the current snapshot revision', async () => {
    const list = vi.fn<() => Promise<Snapshot>>().mockResolvedValue(snapshot([MCP] as never))
    const update = vi.fn<(
      entryId: string,
      patch: McpConfigurationPatch,
      expectedRevision: number,
    ) => Promise<Snapshot>>().mockResolvedValue({
      writable: true,
      revision: 1,
      entries: [MCP] as never,
    })
    const controller = new McpInventoryController(list, update)
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })

    await controller.inject().updateMcp('include:mcp-browser', { toolCallTimeoutMs: 61_000 })
    expect(update).toHaveBeenCalledWith('include:mcp-browser', { toolCallTimeoutMs: 61_000 }, 0)
    expect(state(controller).revision).toBe(1)
    controller.dispose()
  })
})


describe('MCP inventory mutation lifecycle', () => {
  it('rejects unavailable writers, unready reads, and read-only snapshots', async () => {
    const update = vi.fn<() => Promise<Snapshot>>().mockResolvedValue(snapshot())
    const unavailable = new McpInventoryController(undefined, update)
    await expect(unavailable.inject().updateMcp('entry', {})).rejects.toThrow('not ready')
    unavailable.dispose()
    await expect(unavailable.inject().updateMcp('entry', {})).rejects.toThrow('unavailable')
    const noWriter = new McpInventoryController(undefined)
    await expect(noWriter.inject().updateMcp('entry', {})).rejects.toThrow('read-only')
    noWriter.dispose()
    const readOnly = new McpInventoryController(async () => ({ ...snapshot(), writable: false }), update)
    await vi.waitFor(() => { expect(state(readOnly).status).toBe('ready') })
    await expect(readOnly.inject().updateMcp('entry', {})).rejects.toThrow('read-only')
    expect(update).not.toHaveBeenCalled()
    readOnly.dispose()
  })

  it('permits a save against the retained writable revision while a refresh is in flight', async () => {
    const read = deferred<Snapshot>()
    const list = vi.fn<() => Promise<Snapshot>>().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(read.promise)
    const update = vi.fn<(...args: [string, McpConfigurationPatch, number]) => Promise<Snapshot>>()
      .mockResolvedValue({ ...snapshot(), revision: 1 })
    const controller = new McpInventoryController(list, update)
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    controller.refresh()
    await controller.inject().updateMcp('entry', { enabled: false })
    expect(update).toHaveBeenCalledWith('entry', { enabled: false }, 0)
    expect(state(controller).revision).toBe(1)
    controller.dispose()
    read.resolve(snapshot())
    await read.promise
    expect(state(controller).revision).toBe(1)
  })

  it('contains an in-flight write and rejects queued writes after disposal', async () => {
    const writing = deferred<Snapshot>()
    const update = vi.fn<() => Promise<Snapshot>>().mockReturnValue(writing.promise)
    const controller = new McpInventoryController(async () => snapshot(), update)
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    const first = controller.inject().updateMcp('first', { enabled: false })
    await vi.waitFor(() => { expect(update).toHaveBeenCalledOnce() })
    const second = controller.inject().updateMcp('second', { enabled: false })
    const rejected = expect(second).rejects.toThrow('unavailable')
    controller.dispose()
    writing.resolve({ ...snapshot(), revision: 1 })
    await first
    await rejected
    expect(update).toHaveBeenCalledOnce()
    expect(state(controller).revision).toBe(0)
  })

  it('allows later writes after a failed mutation without advancing the failed revision', async () => {
    const update = vi.fn<(...args: [string, McpConfigurationPatch, number]) => Promise<Snapshot>>()
      .mockRejectedValueOnce(new Error('rejected write'))
      .mockResolvedValueOnce({ ...snapshot(), revision: 1 })
    const controller = new McpInventoryController(async () => snapshot(), update)
    await vi.waitFor(() => { expect(state(controller).status).toBe('ready') })
    await expect(controller.inject().updateMcp('first', {})).rejects.toThrow('rejected write')
    await controller.inject().updateMcp('second', {})
    expect(update).toHaveBeenLastCalledWith('second', {}, 0)
    expect(state(controller).revision).toBe(1)
    controller.dispose()
  })

  it('ignores a pending read failure after disposal', async () => {
    const reading = deferred<Snapshot>()
    const controller = new McpInventoryController(() => reading.promise)
    controller.dispose()
    reading.reject(new Error('late transport failure'))
    await Promise.resolve()
    expect(state(controller).status).toBe('loading')
  })
})
