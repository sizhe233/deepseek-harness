/** Public wire types for the MCP configuration control plane. */

/** Transport choices accepted by the MCP bridge. */
export type McpTransport = 'stdio' | 'streamable-http'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The MCP configuration patch or resolved entry shape is invalid. */
    'mcp/bad-request': { readonly entryId?: string }
    /** This deployment exposes the MCP inventory without a writable settings provider. */
    'mcp/read-only': {}
    /** The caller's settings revision is stale. */
    'mcp/conflict': { readonly entryId: string }
    /** The selected Loader entry no longer exists. */
    'mcp/not-found': { readonly entryId: string }
    /** Saving failed after the runtime was restored to its previous configuration. */
    'mcp/write-failed': { readonly entryId: string }
  }
}

/** Root Fiber phase projected by the configuration service. */
export type McpFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** A secret key's safe browser projection. */
export interface McpSecretKey {
  /** Environment or header key name; the value never crosses the Remote. */
  key: string
  /** Whether the key currently has a non-empty value. */
  configured: boolean
}

/** Resolved reconnect policy shown in the editor. */
export interface McpReconnectView {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

/** One MCP Loader entry and its redacted, editable configuration projection. */
export interface McpConfigurationEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: McpFiberPhase
  transport: McpTransport
  serverName: string
  command?: string
  args: string[]
  cwd?: string
  url?: string
  env: McpSecretKey[]
  headers: McpSecretKey[]
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect: McpReconnectView
  /** Settings revision the caller must send back on the next mutation. */
  revision: number
}

/** Point-in-time answer returned to the browser. */
export interface McpConfigurationSnapshot {
  writable: boolean
  revision: number
  entries: McpConfigurationEntry[]
}

/** Write-only environment/header patch. */
export interface McpSecretPatch {
  set?: Record<string, string>
  unset?: string[]
}

/** Reconnect fields accepted by one mutation. */
export interface McpReconnectPatch {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

/** One visual-editor mutation. Omitted fields remain unchanged. */
export interface McpConfigurationPatch {
  enabled?: boolean
  transport?: McpTransport
  serverName?: string
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: McpReconnectPatch
  env?: McpSecretPatch
  headers?: McpSecretPatch
  /** Clear named overrides so the profile's original value is inherited again. */
  reset?: string[]
}
