/**
 * Configurable Host plugins and the editable MCP configuration contributed to the
 * shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * Editable cards arrive through `settings.plugin.item` keyed by the namespace
 * they edit, while the MCP controller appends a safe Loader projection and
 * per-entry editor after
 * those cards. A plugin that ships a browser half owns its own editable card;
 * this tab only decides which keys to dispatch and where the MCP projection
 * appears.
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import { McpCards } from './McpCards.tsx'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the configurable tab. */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace>

/**
 * Render cards registered by plugins that expose editable settings, followed
 * by configured MCP bridge entries.
 * @param props - locale copy, slot rendering, and the namespaces to dispatch.
 * @returns the card list, or the empty line once the Host has answered.
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot, retryMcp, updateMcp } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  const mcp = props.useMcpInventory(snapshot => snapshot)
  const hasMcpCards = mcp.entries.length > 0
  const hasCards = namespaces.length > 0 || hasMcpCards
  if (hasCards) {
    return (
      <>
        <ul className={css.cards}>
          {namespaces.map(ns => (
            // One dispatch per namespace, so the list identity is the namespace
            // rather than a position that shifts as cards arrive.
            <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
          ))}
          {hasMcpCards ? (
            <McpCards
              entries={mcp.entries}
              t={t}
              writable={mcp.writable}
              updateMcp={updateMcp}
            />
          ) : null}
        </ul>
        {mcp.status === 'error' ? (
          <div className={css.mcpNotice}>
            <p role="status">{t('mcpLoadFailed')}</p>
            <button type="button" onClick={retryMcp}>{t('mcpRetry')}</button>
          </div>
        ) : null}
      </>
    )
  }
  if (mcp.status === 'loading') return <p className={css.empty}>{t('mcpLoading')}</p>
  if (mcp.status === 'error') {
    return (
      <div className={css.mcpNotice}>
        <p role="status">{t('mcpLoadFailed')}</p>
        <button type="button" onClick={retryMcp}>{t('mcpRetry')}</button>
      </div>
    )
  }
  return loaded ? <p className={css.empty}>{t('empty')}</p> : null
}
