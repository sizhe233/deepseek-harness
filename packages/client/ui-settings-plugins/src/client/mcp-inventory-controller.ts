/**
 * Client-side state for the MCP configuration card.
 *
 * The Host returns a redacted projection and accepts narrow patches. Keeping
 * the Remote calls here leaves the React surface concerned only with drafts,
 * disclosure state, and validation; it never needs to know how the settings
 * document or Loader entry is stored.
 */

import type {
  McpConfigurationEntry, McpConfigurationPatch, McpConfigurationSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One MCP bridge Loader entry projected by the configuration Remote. */
export type McpInventoryEntry = McpConfigurationEntry

/** Read state for the optional MCP configuration request. */
export interface McpInventoryState {
  status: 'unavailable' | 'loading' | 'ready' | 'error'
  writable: boolean
  revision: number
  entries: readonly McpInventoryEntry[]
}

/** Component-facing injection returned by the controller. */
export interface McpInventoryFace {
  hooks: {
    mcpInventory: SnapshotStore<McpInventoryState>
  }
  retryMcp: () => void
  updateMcp: (entryId: string, patch: McpConfigurationPatch) => Promise<void>
}

/** Stable module identity of the generic MCP bridge. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Empty state retained by the controller when no configuration reader is mounted. */
const UNAVAILABLE: McpInventoryState = Object.freeze({
  status: 'unavailable', writable: false, revision: 0, entries: [],
})

/**
 * Whether a Loader inventory entry belongs to the generic MCP bridge.
 * @param entry - redacted Host inventory row.
 * @returns whether this row belongs to the editable MCP bridge.
 */
export function isMcpInventoryEntry(entry: McpInventoryEntry): boolean {
  return entry.moduleName === MCP_CLIENT_MODULE
}

type ListMcp = () => Promise<McpConfigurationSnapshot>
type UpdateMcp = (
  entryId: string,
  patch: McpConfigurationPatch,
  expectedRevision: number,
) => Promise<McpConfigurationSnapshot>

/** Convert a Host snapshot to the stable state consumed by React. */
function stateOf(snapshot: McpConfigurationSnapshot): McpInventoryState {
  return {
    status: 'ready',
    writable: snapshot.writable,
    revision: snapshot.revision,
    entries: snapshot.entries.filter(isMcpInventoryEntry),
  }
}

/**
 * Owns one safe MCP configuration snapshot and its retry generation. The
 * reader and writer are optional so compositions that omit the Host gateway
 * keep the ordinary plugin settings cards usable.
 */
export class McpInventoryController {
  private readonly store = createSnapshotStore<McpInventoryState>(UNAVAILABLE)
  private disposed = false
  private request = 0
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly list: ListMcp | undefined,
    private readonly update?: UpdateMcp,
  ) {
    if (list !== undefined) this.refresh()
  }

  /**
   * Build the narrow face consumed by the MCP tab.
   * @returns store and actions for the MCP cards.
   */
  inject(): McpInventoryFace {
    return {
      hooks: { mcpInventory: this.store },
      retryMcp: () => { this.refresh() },
      updateMcp: (entryId, patch) => this.updateEntry(entryId, patch),
    }
  }

  /** Start a new configuration read and invalidate any older result. */
  refresh(): void {
    if (this.disposed || this.list === undefined) return
    const request = ++this.request
    const previous = this.store.getSnapshot()
    // Keep a usable list visible while a refresh is in flight. This avoids a
    // full card collapse when a connection reset only briefly interrupts RPC.
    this.store.set({ ...previous, status: 'loading' })
    void this.load(request)
  }

  /** Stop publishing and ignore a result from an in-flight Remote call. */
  dispose(): void {
    this.disposed = true
    this.request += 1
  }

  private async load(request: number): Promise<void> {
    try {
      const snapshot = await (this.list as ListMcp)()
      if (this.disposed || request !== this.request) return
      this.store.set(stateOf(snapshot))
    } catch {
      if (this.disposed || request !== this.request) return
      const previous = this.store.getSnapshot()
      this.store.set({ ...previous, status: 'error' })
    }
  }

  private updateEntry(entryId: string, patch: McpConfigurationPatch): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MCP configuration is unavailable'))
    const update = this.update
    if (update === undefined) return Promise.reject(new Error('MCP configuration is read-only'))
    const operation = this.mutation.then(async () => {
      if (this.disposed) throw new Error('MCP configuration is unavailable')
      const state = this.store.getSnapshot()
      if (state.status !== 'ready' && state.status !== 'loading') {
        throw new Error('MCP configuration is not ready')
      }
      if (!state.writable) throw new Error('MCP configuration is read-only')
      const snapshot = await update(entryId, patch, state.revision)
      if (this.isDisposed()) return
      this.store.set(stateOf(snapshot))
    })
    // A failed write must not poison later saves from another entry.
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private isDisposed(): boolean {
    return this.disposed
  }
}
