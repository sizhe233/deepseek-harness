/** Grouped MCP configuration card with one editor per Loader entry. */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconPlusOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  McpConfigurationEntry, McpConfigurationPatch, McpSecretKey, McpTransport,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './PluginCard.module.css'

/** Props for the grouped MCP card list. */
export interface McpCardsProps {
  /** MCP bridge entries from the Host configuration snapshot. */
  entries: readonly McpConfigurationEntry[]
  /** Settings section locale reader. */
  t: (key: PluginsSettingsLocaleKey) => string
  /** Whether the Host settings provider accepts writes. */
  writable?: boolean
  /** Persist one entry patch and wait for its runtime reload. */
  updateMcp?: (entryId: string, patch: McpConfigurationPatch) => Promise<void>
}

interface SecretDraft {
  id: string
  key: string
  value: string
  configured: boolean
  /** Set for a key that came from the Host projection. */
  originalKey?: string
}

interface McpDraft {
  enabled: boolean
  transport: McpTransport
  serverName: string
  command: string
  args: string
  cwd: string
  url: string
  toolCallTimeoutMs: string
  failOnStartupError: boolean
  reconnectEnabled: boolean
  initialDelayMs: string
  maxDelayMs: string
  maxAttempts: string
  env: SecretDraft[]
  headers: SecretDraft[]
}

interface McpEditorProps {
  entry: McpConfigurationEntry
  t: McpCardsProps['t']
  writable: boolean
  updateMcp?: McpCardsProps['updateMcp']
}

type SecretKind = 'env' | 'headers'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Keep an entry id readable without exposing an implementation prefix twice. */
function entryLabel(entryId: string): string {
  const separator = entryId.lastIndexOf(':')
  return separator === -1 ? entryId : entryId.slice(separator + 1)
}

/** Translate the exact root Fiber phase without exposing transport details. */
function phaseLabel(
  phase: McpConfigurationEntry['fiberPhase'],
  t: McpCardsProps['t'],
): string {
  switch (phase) {
    case null: return t('mcpUnobserved')
    case 'pending': return t('mcpPending')
    case 'loading': return t('mcpLoadingPhase')
    case 'active': return t('mcpMounted')
    case 'failed': return t('mcpFailed')
    case 'unloading': return t('mcpUnloading')
  }
}

function secretDrafts(keys: readonly McpSecretKey[] | undefined, prefix: string): SecretDraft[] {
  return (keys ?? []).map((item, index) => ({
    id: `${prefix}-${index}-${item.key}`,
    key: item.key,
    value: '',
    configured: item.configured,
    originalKey: item.key,
  }))
}

function draftOf(entry: McpConfigurationEntry, id: string): McpDraft {
  const reconnect = entry.reconnect
  return {
    enabled: entry.enabled,
    transport: entry.transport,
    serverName: entry.serverName,
    command: entry.command ?? '',
    args: entry.args.join('\n'),
    cwd: entry.cwd ?? '',
    url: entry.url ?? '',
    toolCallTimeoutMs: String(entry.toolCallTimeoutMs),
    failOnStartupError: entry.failOnStartupError,
    reconnectEnabled: reconnect.enabled,
    initialDelayMs: String(reconnect.initialDelayMs),
    maxDelayMs: String(reconnect.maxDelayMs),
    maxAttempts: String(reconnect.maxAttempts),
    env: secretDrafts(entry.env, `${id}-env`),
    headers: secretDrafts(entry.headers, `${id}-headers`),
  }
}

function parseArgs(value: string): string[] {
  const lines = value.replaceAll('\r', '').split('\n')
  while (lines.at(-1) === '') lines.pop()
  return lines
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateSecretRows(
  rows: readonly SecretDraft[],
  kind: SecretKind,
  t: McpCardsProps['t'],
): string | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '' && row.value === '') continue
    const valid = kind === 'env' ? ENV_KEY_PATTERN.test(key) : key.length > 0 && key.length <= 256
    if (!valid) return t('mcpInvalidSecretKey')
    if (seen.has(key)) return t('mcpDuplicateSecretKey')
    seen.add(key)
  }
  return undefined
}

/** Return one concise validation message; the Host repeats all checks at the wire boundary. */
function validateDraft(draft: McpDraft, t: McpCardsProps['t']): string | undefined {
  if (!SERVER_NAME_PATTERN.test(draft.serverName.trim())) return t('mcpInvalidServerName')
  if (draft.transport === 'stdio' && draft.command.trim() === '') return t('mcpCommandRequired')
  if (draft.transport === 'streamable-http') {
    try {
      const url = new URL(draft.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      return t('mcpUrlRequired')
    }
  }
  if (parsePositiveInteger(draft.toolCallTimeoutMs) === undefined) return t('mcpInvalidNumber')
  const initial = parsePositiveInteger(draft.initialDelayMs)
  const maximum = parsePositiveInteger(draft.maxDelayMs)
  if (initial === undefined || maximum === undefined || parsePositiveInteger(draft.maxAttempts) === undefined) {
    return t('mcpInvalidNumber')
  }
  if (initial > maximum) return t('mcpReconnectOrder')
  return validateSecretRows(draft.env, 'env', t) ?? validateSecretRows(draft.headers, 'headers', t)
}

function secretPatch(
  rows: readonly SecretDraft[],
  original: readonly McpSecretKey[] | undefined,
): { set?: Record<string, string>; unset?: string[] } | undefined {
  const set: Record<string, string> = {}
  const unset: string[] = []
  const currentOriginal = new Set(rows.flatMap(row => row.originalKey === undefined ? [] : [row.originalKey]))
  for (const item of original ?? []) {
    if (!currentOriginal.has(item.key)) unset.push(item.key)
  }
  for (const row of rows) {
    const key = (row.originalKey ?? row.key).trim()
    // Blank values deliberately preserve an existing secret. Removing the row
    // is the explicit clear action; this prevents accidental secret deletion
    // when a user opens an editor and saves an unrelated field.
    if (key !== '' && row.value !== '') set[key] = row.value
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return undefined
  return {
    ...Object.keys(set).length === 0 ? {} : { set },
    ...unset.length === 0 ? {} : { unset },
  }
}

function buildPatch(entry: McpConfigurationEntry, draft: McpDraft): McpConfigurationPatch {
  const patch: McpConfigurationPatch = {}
  const originalTransport = entry.transport
  if (draft.enabled !== entry.enabled) patch.enabled = draft.enabled
  if (draft.transport !== originalTransport) patch.transport = draft.transport
  if (draft.serverName !== entry.serverName) patch.serverName = draft.serverName
  if (draft.command !== (entry.command ?? '')) patch.command = draft.command
  const args = parseArgs(draft.args)
  if (!sameArray(args, entry.args)) patch.args = args
  if (draft.cwd !== (entry.cwd ?? '')) patch.cwd = draft.cwd
  if (draft.url !== (entry.url ?? '')) patch.url = draft.url
  const timeout = parsePositiveInteger(draft.toolCallTimeoutMs)
  if (timeout !== undefined && timeout !== entry.toolCallTimeoutMs) patch.toolCallTimeoutMs = timeout
  if (draft.failOnStartupError !== entry.failOnStartupError) patch.failOnStartupError = draft.failOnStartupError

  const reconnect = entry.reconnect
  const reconnectPatch: McpConfigurationPatch['reconnect'] = {}
  const reconnectEnabled = draft.reconnectEnabled
  const initialDelayMs = parsePositiveInteger(draft.initialDelayMs)
  const maxDelayMs = parsePositiveInteger(draft.maxDelayMs)
  const maxAttempts = parsePositiveInteger(draft.maxAttempts)
  if (reconnectEnabled !== reconnect.enabled) reconnectPatch.enabled = reconnectEnabled
  if (initialDelayMs !== undefined && initialDelayMs !== reconnect.initialDelayMs) reconnectPatch.initialDelayMs = initialDelayMs
  if (maxDelayMs !== undefined && maxDelayMs !== reconnect.maxDelayMs) reconnectPatch.maxDelayMs = maxDelayMs
  if (maxAttempts !== undefined && maxAttempts !== reconnect.maxAttempts) reconnectPatch.maxAttempts = maxAttempts
  if (Object.keys(reconnectPatch).length > 0) patch.reconnect = reconnectPatch

  const env = secretPatch(draft.env, entry.env)
  const headers = secretPatch(draft.headers, entry.headers)
  if (env !== undefined) patch.env = env
  if (headers !== undefined) patch.headers = headers
  return patch
}

function updateSecretRow(
  draft: McpDraft,
  kind: SecretKind,
  index: number,
  field: 'key' | 'value',
  value: string,
): McpDraft {
  return {
    ...draft,
    [kind]: draft[kind].map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row),
  }
}

interface SecretEditorProps {
  kind: SecretKind
  rows: readonly SecretDraft[]
  t: McpCardsProps['t']
  disabled: boolean
  onChange: (index: number, field: 'key' | 'value', value: string) => void
  onRemove: (index: number) => void
  onAdd: () => void
}

/** Write-only key/value rows. Existing values never enter React state. */
function SecretEditor(props: SecretEditorProps): ReactNode {
  const label = props.kind === 'env' ? props.t('mcpEnvironment') : props.t('mcpHeaders')
  return (
    <fieldset className={css.mcpFieldset}>
      <legend>{label}</legend>
      <p className={css.mcpFieldHint}>{props.t('mcpSecretHint')}</p>
      <div className={css.mcpSecretRows}>
        {props.rows.map((row, index) => (
          <div className={css.mcpSecretRow} key={row.id}>
            <input
              className={css.mcpInput}
              aria-label={`${props.t('mcpSecretKey')} ${index + 1}`}
              value={row.key}
              placeholder={props.t('mcpSecretKey')}
              readOnly={row.originalKey !== undefined}
              disabled={props.disabled}
              onChange={(event) => { props.onChange(index, 'key', event.target.value) }}
            />
            <input
              className={css.mcpInput}
              type="password"
              autoComplete="new-password"
              aria-label={`${props.t('mcpSecretValue')} ${index + 1}`}
              value={row.value}
              placeholder={row.configured ? props.t('mcpKeepSecret') : props.t('mcpSecretValue')}
              disabled={props.disabled}
              onChange={(event) => { props.onChange(index, 'value', event.target.value) }}
            />
            <button
              type="button"
              className={css.mcpIconButton}
              aria-label={`${props.t('mcpRemoveSecret')} ${row.key || index + 1}`}
              title={props.t('mcpRemoveSecret')}
              disabled={props.disabled}
              onClick={() => { props.onRemove(index) }}
            >
              <IconTrashOutline16 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className={css.mcpAddButton} disabled={props.disabled} onClick={props.onAdd}>
        <IconPlusOutline16 size={14} aria-hidden="true" />
        {props.t('mcpAddSecret')}
      </button>
    </fieldset>
  )
}

/** One independently editable MCP Loader entry. */
function McpEditor({ entry, t, writable, updateMcp }: McpEditorProps): ReactNode {
  const id = useId()
  const rowCounter = useRef(0)
  const [draft, setDraft] = useState(() => draftOf(entry, id))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const syncedRevision = useRef(entry.revision)
  const validation = validateDraft(draft, t)
  const patch = useMemo(() => buildPatch(entry, draft), [draft, entry])
  const dirty = Object.keys(patch).length > 0
  const disabled = !writable || updateMcp === undefined || saving

  // A successful Remote update changes the entry revision. Reset an untouched
  // draft from that authoritative projection; a user-edited draft is kept so
  // a concurrent update never destroys local work.
  useEffect(() => {
    if (entry.revision === syncedRevision.current) return
    syncedRevision.current = entry.revision
    if (!saving && !dirty) setDraft(draftOf(entry, id))
  }, [dirty, entry, id, saving])

  const edit = (change: Partial<McpDraft>) => {
    setDraft(previous => ({ ...previous, ...change }))
    setFailed(false)
    setSaved(false)
  }
  const addSecret = (kind: SecretKind) => {
    const row: SecretDraft = {
      id: `${id}-${kind}-new-${rowCounter.current++}`,
      key: '', value: '', configured: false,
    }
    setDraft(previous => ({ ...previous, [kind]: [...previous[kind], row] }))
    setFailed(false)
    setSaved(false)
  }
  const removeSecret = (kind: SecretKind, index: number) => {
    setDraft(previous => ({ ...previous, [kind]: previous[kind].filter((_row, rowIndex) => rowIndex !== index) }))
    setFailed(false)
    setSaved(false)
  }
  const save = async () => {
    const update = updateMcp
    if (!dirty || validation !== undefined || disabled || update === undefined) return
    setSaving(true)
    setFailed(false)
    setSaved(false)
    try {
      await update(entry.entryId, patch)
      // The Host never echoes secret values. Clear successful write-only
      // drafts immediately so they do not remain in the browser or keep the
      // editor dirty after the authoritative snapshot arrives.
      setDraft(previous => ({
        ...previous,
        env: previous.env.map(row => ({ ...row, value: '' })),
        headers: previous.headers.map(row => ({ ...row, value: '' })),
      }))
      setSaved(true)
    } catch {
      // The Host deliberately returns a generic failure to the browser. Keep
      // implementation details out of the settings surface and retain drafts.
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const discard = () => {
    setDraft(draftOf(entry, id))
    setFailed(false)
    setSaved(false)
  }

  return (
    <div className={css.mcpItemBody}>
      <code className={css.mcpEntry}>{entry.entryId}</code>
      <dl className={css.mcpDetails}>
        <div><dt>{t('mcpModule')}</dt><dd>{entry.moduleName}</dd></div>
        <div><dt>{t('mcpStatus')}</dt><dd>{phaseLabel(entry.fiberPhase, t)}</dd></div>
      </dl>
      {!writable ? <p className={css.mcpReadOnly} role="status">{t('readOnly')}</p> : null}
      <form
        className={css.mcpEditor}
        onSubmit={(event) => { event.preventDefault(); void save() }}
        noValidate
      >
        <div className={css.mcpGrid}>
          <label className={css.mcpField} htmlFor={`${id}-server-name`}>
            <span className={css.mcpLabel}>{t('mcpServerName')}</span>
            <input
              id={`${id}-server-name`}
              className={css.mcpInput}
              value={draft.serverName}
              disabled={disabled}
              onChange={(event) => { edit({ serverName: event.target.value }) }}
            />
          </label>
          <label className={css.mcpField} htmlFor={`${id}-transport`}>
            <span className={css.mcpLabel}>{t('mcpTransport')}</span>
            <select
              id={`${id}-transport`}
              className={css.mcpInput}
              value={draft.transport}
              disabled={disabled}
              onChange={(event) => { edit({ transport: event.target.value as McpTransport }) }}
            >
              <option value="stdio">{t('mcpStdio')}</option>
              <option value="streamable-http">{t('mcpHttp')}</option>
            </select>
          </label>
        </div>

        {draft.transport === 'stdio' ? (
          <>
            <label className={css.mcpField} htmlFor={`${id}-command`}>
              <span className={css.mcpLabel}>{t('mcpCommand')}</span>
              <input
                id={`${id}-command`}
                className={css.mcpInput}
                value={draft.command}
                disabled={disabled}
                onChange={(event) => { edit({ command: event.target.value }) }}
              />
            </label>
            <label className={css.mcpField} htmlFor={`${id}-args`}>
              <span className={css.mcpLabel}>{t('mcpArgs')}</span>
              <textarea
                id={`${id}-args`}
                className={css.mcpTextarea}
                rows={4}
                value={draft.args}
                disabled={disabled}
                onChange={(event) => { edit({ args: event.target.value }) }}
              />
              <span className={css.mcpFieldHint}>{t('mcpArgsHint')}</span>
            </label>
            <label className={css.mcpField} htmlFor={`${id}-cwd`}>
              <span className={css.mcpLabel}>{t('mcpCwd')}</span>
              <input
                id={`${id}-cwd`}
                className={css.mcpInput}
                value={draft.cwd}
                disabled={disabled}
                onChange={(event) => { edit({ cwd: event.target.value }) }}
              />
            </label>
            <SecretEditor
              kind="env"
              rows={draft.env}
              t={t}
              disabled={disabled}
              onChange={(index, field, value) => { setDraft(previous => updateSecretRow(previous, 'env', index, field, value)); setFailed(false); setSaved(false) }}
              onRemove={(index) => { removeSecret('env', index) }}
              onAdd={() => { addSecret('env') }}
            />
          </>
        ) : (
          <>
            <label className={css.mcpField} htmlFor={`${id}-url`}>
              <span className={css.mcpLabel}>{t('mcpUrl')}</span>
              <input
                id={`${id}-url`}
                className={css.mcpInput}
                type="url"
                value={draft.url}
                disabled={disabled}
                onChange={(event) => { edit({ url: event.target.value }) }}
              />
            </label>
            <SecretEditor
              kind="headers"
              rows={draft.headers}
              t={t}
              disabled={disabled}
              onChange={(index, field, value) => { setDraft(previous => updateSecretRow(previous, 'headers', index, field, value)); setFailed(false); setSaved(false) }}
              onRemove={(index) => { removeSecret('headers', index) }}
              onAdd={() => { addSecret('headers') }}
            />
          </>
        )}

        <div className={css.mcpGrid}>
          <label className={css.mcpField} htmlFor={`${id}-timeout`}>
            <span className={css.mcpLabel}>{t('mcpTimeout')}</span>
            <input
              id={`${id}-timeout`}
              className={css.mcpInput}
              type="number"
              min={1}
              step={1}
              value={draft.toolCallTimeoutMs}
              disabled={disabled}
              onChange={(event) => { edit({ toolCallTimeoutMs: event.target.value }) }}
            />
          </label>
          <label className={css.mcpToggle} htmlFor={`${id}-fail-startup`}>
            <input
              id={`${id}-fail-startup`}
              type="checkbox"
              checked={draft.failOnStartupError}
              disabled={disabled}
              onChange={(event) => { edit({ failOnStartupError: event.target.checked }) }}
            />
            <span>{t('mcpFailOnStartup')}</span>
          </label>
        </div>

        <details className={css.mcpAdvanced}>
          <summary>{t('mcpAdvanced')}</summary>
          <label className={css.mcpToggle} htmlFor={`${id}-reconnect`}>
            <input
              id={`${id}-reconnect`}
              type="checkbox"
              checked={draft.reconnectEnabled}
              disabled={disabled}
              onChange={(event) => { edit({ reconnectEnabled: event.target.checked }) }}
            />
            <span>{t('mcpReconnectEnabled')}</span>
          </label>
          <div className={css.mcpGrid}>
            <label className={css.mcpField} htmlFor={`${id}-initial-delay`}>
              <span className={css.mcpLabel}>{t('mcpInitialDelay')}</span>
              <input
                id={`${id}-initial-delay`}
                className={css.mcpInput}
                type="number"
                min={1}
                step={1}
                value={draft.initialDelayMs}
                disabled={disabled}
                onChange={(event) => { edit({ initialDelayMs: event.target.value }) }}
              />
            </label>
            <label className={css.mcpField} htmlFor={`${id}-max-delay`}>
              <span className={css.mcpLabel}>{t('mcpMaxDelay')}</span>
              <input
                id={`${id}-max-delay`}
                className={css.mcpInput}
                type="number"
                min={1}
                step={1}
                value={draft.maxDelayMs}
                disabled={disabled}
                onChange={(event) => { edit({ maxDelayMs: event.target.value }) }}
              />
            </label>
            <label className={css.mcpField} htmlFor={`${id}-max-attempts`}>
              <span className={css.mcpLabel}>{t('mcpMaxAttempts')}</span>
              <input
                id={`${id}-max-attempts`}
                className={css.mcpInput}
                type="number"
                min={1}
                step={1}
                value={draft.maxAttempts}
                disabled={disabled}
                onChange={(event) => { edit({ maxAttempts: event.target.value }) }}
              />
            </label>
          </div>
        </details>

        {validation !== undefined ? <p className={css.mcpValidation} role="alert">{validation}</p> : null}
        {failed ? <p className={css.mcpValidation} role="alert">{t('mcpSaveFailed')}</p> : null}
        {saved ? <p className={css.mcpSaved} role="status">{t('mcpReloaded')}</p> : null}
        <div className={css.mcpFooter}>
          <label className={css.mcpToggle} htmlFor={`${id}-enabled`}>
            <input
              id={`${id}-enabled`}
              type="checkbox"
              checked={draft.enabled}
              disabled={disabled}
              onChange={(event) => { edit({ enabled: event.target.checked }) }}
            />
            <span>{t('mcpEnabledToggle')}</span>
          </label>
          <span className={css.mcpFooterSpacer} />
          <button type="button" className={css.discard} disabled={!dirty || saving} onClick={discard}>
            {t('discard')}
          </button>
          <button type="submit" className={css.save} disabled={!dirty || validation !== undefined || disabled}>
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Render one MCP group card and one nested disclosure row per configured bridge. */
export function McpCards({ entries, t, writable = false, updateMcp }: McpCardsProps): ReactNode {
  const id = useId()
  const [groupOpen, setGroupOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  if (entries.length === 0) return null

  const groupDetailsId = `${id}-mcp-details`
  const configured = `${entries.length} ${t('mcpConfigured')}`
  return (
    <li
      className={groupOpen ? `${css.card} ${css.cardOpen}` : css.card}
      data-mcp-group="true"
      data-open={groupOpen ? 'true' : undefined}
    >
      <button
        type="button"
        className={css.header}
        aria-expanded={groupOpen}
        aria-controls={groupDetailsId}
        aria-label={`${t(groupOpen ? 'collapse' : 'expand')}: ${t('mcpTitle')}, ${configured}`}
        onClick={() => { setGroupOpen(open => !open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('mcpTitle')}</span>
          <span className={css.description}>{t('mcpDescription')}</span>
        </span>
        <span className={css.mcpCount}>{configured}</span>
        <IconChevronDownOutline14 className={groupOpen ? css.chevronOpen : css.chevron} aria-hidden="true" />
      </button>
      {groupOpen ? (
        <div className={css.mcpGroupBody} id={groupDetailsId}>
          <ul className={css.mcpList}>
            {entries.map((entry) => {
              const title = entryLabel(entry.entryId)
              const open = expanded === entry.entryId
              const status = entry.enabled ? t('mcpEnabled') : t('mcpDisabled')
              const phase = phaseLabel(entry.fiberPhase, t)
              const detailId = `${id}-${encodeURIComponent(entry.entryId)}`
              return (
                <li
                  className={css.mcpItem}
                  data-mcp-entry={entry.entryId}
                  data-open={open ? 'true' : undefined}
                  key={entry.entryId}
                >
                  <button
                    type="button"
                    className={css.mcpItemHeader}
                    aria-expanded={open}
                    aria-controls={detailId}
                    aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}, ${status}`}
                    onClick={() => { setExpanded(current => current === entry.entryId ? null : entry.entryId) }}
                  >
                    <span className={css.headText}>
                      <span className={css.name}>{title}</span>
                      <span className={css.description}>{t('mcpEntryDescription')}</span>
                    </span>
                    <span className={css.mcpStatus} data-enabled={entry.enabled ? 'true' : 'false'}>
                      <span className={css.mcpDot} data-phase={entry.fiberPhase ?? 'unobserved'} aria-hidden="true" />
                      {status}
                    </span>
                    <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} aria-hidden="true" />
                  </button>
                  {open ? <McpEditor entry={entry} t={t} writable={writable} updateMcp={updateMcp} /> : null}
                  {!open && entry.fiberPhase !== 'active' ? <span className={css.mcpPhaseHint}>{phase}</span> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </li>
  )
}
