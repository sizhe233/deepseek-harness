/** Editable MCP configuration contributed to the shared Plugins section. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { McpCards } from './McpCards.tsx'
import type { McpInventoryFace } from './mcp-inventory-controller.ts'
import css from './PluginsSettingsSection.module.css'

/** Props bound by the MCP tab registration. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpInventoryFace>

/**
 * Render the configured MCP entries and retain them beside retryable read errors.
 * @param props - localized copy, configuration snapshot, and write/retry actions.
 * @returns MCP editors, a loading state, or the configuration empty state.
 */
export function McpSettingsTab({ t, useMcpInventory, retryMcp, updateMcp }: McpSettingsTabProps) {
  const mcp = useMcpInventory(snapshot => snapshot)
  const hasEntries = mcp.entries.length > 0
  return (
    <div className={css.mcpTab}>
      {hasEntries ? (
        <ul className={css.cards}>
          <McpCards entries={mcp.entries} t={t} writable={mcp.writable} updateMcp={updateMcp} />
        </ul>
      ) : mcp.status === 'loading' ? (
        <div className={css.loading} role="status" aria-label={t('mcpLoading')}><StateDot state="ongoing" /></div>
      ) : mcp.status === 'ready' ? <p className={css.empty}>{t('mcpEmpty')}</p> : null}
      {mcp.status === 'error' ? (
        <div className={css.mcpNotice}>
          <p role="status">{t('mcpLoadFailed')}</p>
          <button type="button" onClick={retryMcp}>{t('mcpRetry')}</button>
        </div>
      ) : null}
    </div>
  )
}
