/** Normalize the former MCP control-plane mode before profile patches reach Loader. */
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const BRIDGE = '@deepseek-ai/dsh-mcp-client'
const CONFIGURATION = `${BRIDGE}/configuration`

function configuration(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/**
 * Migrate exact legacy control rows and their name guards without changing source files.
 * Normal bridge rows and unrelated fields retain their original values.
 * @param patches - ordered profile layers, including inserts and named overrides.
 * @returns detached patches targeting the standalone configuration module.
 */
export function migrateLegacyMcpConfiguration(patches: readonly PatchOptions[]): PatchOptions[] {
  const detached = structuredClone(patches) as PatchOptions[]
  // A saved standalone guard cannot match the legacy bundle until its insertion
  // is normalized. The discovery pass only identifies effective legacy rows;
  // the caller's actual composition still owns skipped-patch diagnostics.
  const insertedLegacyIds = new Set(flatten(detached.flatMap(patch => patch.insert ?? []))
    .filter(row => row.name === BRIDGE && configuration(row.config)?.mode === 'configuration').map(row => row.id))
  if (insertedLegacyIds.size === 0 && !detached.some(patch => patch.insert === undefined
    && configuration(patch.config)?.mode === 'configuration')) return detached
  const legacyIds = new Set(flatten(applyEntryPatches([], structuredClone(detached), () => {}))
    .filter((row) => {
      const config = configuration(row.config)
      return !row.group && row.name === BRIDGE && (config?.mode === 'configuration'
        || insertedLegacyIds.has(row.id) && config?.transport === undefined)
    }).map(row => row.id))
  const migrate = (row: Partial<EntryOptions>): void => {
    if (row.id !== undefined && legacyIds.has(row.id)
      && (row.name === undefined || row.name === BRIDGE || row.name === CONFIGURATION)) {
      if (row.name === BRIDGE) row.name = CONFIGURATION
      const config = configuration(row.config)
      if (config?.mode === 'configuration') {
        const { mode: _mode, ...rest } = config
        row.config = rest
      }
    }
    if (row.group && Array.isArray(row.config)) {
      for (const child of row.config as EntryOptions[]) migrate(child)
    }
  }
  for (const patch of detached) {
    if (patch.insert !== undefined) {
      for (const row of patch.insert) migrate(row)
    } else {
      migrate(patch)
    }
  }
  return detached
}
