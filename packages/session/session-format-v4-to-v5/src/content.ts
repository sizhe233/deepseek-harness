/** V5 opaque checkpoint admission and promotion of the preserved V3 extension tag. */

import { isSessionFormatJsonObject, SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

function validCheckpoint(value: Readonly<Record<string, unknown>>): boolean {
  const item = value['item']
  return Object.keys(value).every(key => key === 'type' || key === 'item')
    && isSessionFormatJsonObject(item)
    && (item['type'] === 'compaction' || item['type'] === 'compaction_summary')
    && typeof item['encrypted_content'] === 'string' && item['encrypted_content'].length > 0
}

function block(value: SessionFormatJsonValue, promote: boolean): SessionFormatJsonValue {
  if (!isSessionFormatJsonObject(value)) return value
  if (value['type'] === 'compaction' && !validCheckpoint(value)) {
    throw new SessionFormatError('format v5 compaction requires an opaque encrypted compaction item')
  }
  return promote && value['type'] === 'plugin:compaction' && validCheckpoint(value)
    ? { ...value, type: 'compaction' } : value
}

function content(value: SessionFormatJsonValue | undefined, promote: boolean): SessionFormatJsonValue | undefined {
  if (!Array.isArray(value)) return value
  const values = value as SessionFormatJsonValue[]
  const mapped = values.map(item => block(item, promote))
  return mapped.every((item, index) => item === values[index]) ? values : mapped
}

function message(value: SessionFormatJsonValue | undefined, promote: boolean): SessionFormatJsonValue | undefined {
  if (!isSessionFormatJsonObject(value)) return value
  const mapped = content(value['content'], promote)
  return mapped === value['content'] ? value : { ...value, content: mapped as SessionFormatJsonValue }
}

/**
 * Validate native opaque checkpoints and optionally promote the audited historical extension.
 * Only declared content slots are interpreted; nested extension values remain opaque.
 * @param event - logical event or physical row with an object payload.
 * @param promote - whether a valid historical plugin:compaction block becomes native compaction.
 * @returns the original event unless a declared checkpoint tag changes.
 */
export function mapCompactionContent(event: SessionFormatEvent, promote: boolean): SessionFormatEvent {
  if (!isSessionFormatJsonObject(event.data)) return event
  let data = event.data
  const set = (key: string, value: SessionFormatJsonValue | undefined): void => {
    if (value !== data[key]) data = { ...data, [key]: value as SessionFormatJsonValue }
  }
  switch (event.type) {
    case 'user/message': {
      const mapped = message(data, promote)
      if (mapped !== data) data = mapped as SessionFormatJsonObject
      break
    }
    case 'system/message': case 'developer/message': case 'assistant/message': case 'tool/result': case 'team/message/queued':
      set('message', message(data['message'], promote))
      break
    case 'agent/inbox/spliced': case 'session/title-llm-request': {
      const key = event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      const values = data[key]
      if (Array.isArray(values)) {
        const messages = values as readonly SessionFormatJsonValue[]
        const mapped = messages.map(value => message(value, promote) as SessionFormatJsonValue)
        if (mapped.some((value, index) => value !== messages[index])) set(key, mapped)
      }
      break
    }
    case 'compaction/summary':
      set('summary', content(data['summary'], promote))
      set('rawOutput', content(data['rawOutput'], promote))
      break
    case 'tool/ptc-dispatch':
      set('content', content(data['content'], promote))
      break
  }
  if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(data['stream'])) {
    const stream = data['stream'] as readonly SessionFormatJsonValue[]
    const promoted = new Set<SessionFormatJsonValue>()
    if (promote) {
      for (const entry of stream) {
        const chunk = isSessionFormatJsonObject(entry) && entry['type'] === 'chunk' ? entry['chunk'] : undefined
        if (!isSessionFormatJsonObject(chunk) || chunk['type'] !== 'block-end') continue
        const value = chunk['block']
        if (isSessionFormatJsonObject(value) && value['type'] === 'plugin:compaction' && validCheckpoint(value)) {
          promoted.add(chunk['index'] as SessionFormatJsonValue)
        }
      }
    }
    const mapped = stream.map((entry) => {
      if (!isSessionFormatJsonObject(entry) || entry['type'] !== 'chunk' || !isSessionFormatJsonObject(entry['chunk'])) return entry
      const chunk = entry['chunk']
      if (chunk['type'] === 'block-end') {
        const value = block(chunk['block'] as SessionFormatJsonValue, promote)
        return value === chunk['block'] ? entry : { ...entry, chunk: { ...chunk, block: value } }
      }
      return chunk['type'] === 'block-start' && chunk['blockType'] === 'plugin:compaction'
        && promoted.has(chunk['index'] as SessionFormatJsonValue)
        ? { ...entry, chunk: { ...chunk, blockType: 'compaction' } } : entry
    })
    if (mapped.some((entry, index) => entry !== stream[index])) set('stream', mapped)
  }
  return data === event.data ? event : { ...event, data }
}
