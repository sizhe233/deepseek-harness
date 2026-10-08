/** Native opaque checkpoints and adjacent migration preserve historical bytes and identities. */

import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { releasedV5SessionFormatCodec, sessionFormatV4ToV5, restoreReleasedV5Artifact, assertReleasedV5Header } from '../src/index.ts'
import { mapCompactionContent } from '../src/content.ts'

const header: SessionFormatHeader = { version: 4, id: 'checkpoint', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const item = { type: 'compaction_summary', encrypted_content: 'opaque-ciphertext', metadata: { kept: [true, null, 987], type: 'plugin:compaction' } }
const checkpoint = { type: 'plugin:compaction', item }
const user = (content: SessionFormatJsonValue[]): SessionFormatEvent => ({
  type: 'user/message', seq: 0, time: 2, surfaceOp: 'append',
  data: { id: 'u', role: 'user', source: { kind: 'user' }, content },
})
const known = new Set(['user/message', 'session/end-seed', 'feedback/record', 'session-log-deepseek/delivery-accepted'])

function stage(sourceHeader = header, sourceInheritedEventCount?: number) {
  return sessionFormatV4ToV5.createStage({ sourceHeader, targetHeader: { ...sourceHeader, version: 5 }, sourceInheritedEventCount, sourceKind: 'decoded' })
}

function migrate(rows: readonly SessionFormatEvent[], sourceHeader = header, cut?: number) {
  const migration = stage(sourceHeader, cut)
  const out = new SessionFormatEventCollector()
  for (const row of rows) migration.transformEvent(row, out)
  return { header: sessionFormatV4ToV5.migrateHeader(sourceHeader), events: out.values, inheritedEventCount: migration.finish(out) }
}

function delivery(version: number, sessionId = header.id): SessionFormatEvent {
  return { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3, data: { sessionId, throughSeq: 0, sessionFormatVersion: version } }
}

describe('V4 to V5 checkpoint migration', () => {
  it.each(['compaction', 'compaction_summary'])('promotes the preserved %s item without changing metadata or source objects', (type) => {
    const original = user([{ ...checkpoint, item: { ...item, type } }])
    const saved = JSON.stringify(original)
    const result = migrate([original])
    expect(result.header).toEqual({ ...header, version: 5 })
    expect(result.events).toEqual([user([{ type: 'compaction', item: { ...item, type } }])])
    expect(JSON.stringify(original)).toBe(saved)
    expect(restoreReleasedV5Artifact(result, known)).toBe(result)
  })

  it('preserves ordinary and unrecognized extension values without interpreting nested JSON', () => {
    const values = [{ type: 'text', text: 'retained' }, { type: 'plugin:compaction', arbitrary: checkpoint },
      { type: 'plugin:compaction', item: { ...item, encrypted_content: '' } },
      { type: 'plugin:plugin:compaction', item }]
    const original = user(values)
    expect(migrate([original]).events[0]).toBe(original)
    const opaque = { type: 'external/event', seq: 0, time: 2, ignorable: true, data: { content: [checkpoint], message: { content: [checkpoint] } } }
    expect(migrate([opaque]).events[0]).toBe(opaque)
    expect(restoreReleasedV5Artifact(migrate([opaque]), known).events[0]).toBe(opaque)
    expect(() => { restoreReleasedV5Artifact(migrate([{ ...opaque, ignorable: false }]), known) }).toThrow(/unknown event type/)
  })

  it('maps summary, message, and complete stream slots while keeping unrelated metadata unchanged', () => {
    const summary: SessionFormatEvent = { type: 'compaction/summary', seq: 0, time: 2, data: { summary: [checkpoint], rawOutput: [checkpoint], metadata: checkpoint } }
    expect(mapCompactionContent(summary, true).data).toEqual({ summary: [{ type: 'compaction', item }], rawOutput: [{ type: 'compaction', item }], metadata: checkpoint })
    const raw = { type: 'assistant/attempt', seq: 0, time: 2, data: { stream: [
      { type: 'chunk', time: 2, chunk: { type: 'block-start', index: 0, blockType: 'plugin:compaction' } },
      { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: checkpoint } },
    ] } }
    expect(mapCompactionContent(raw, true).data).toMatchObject({ stream: [
      { chunk: { blockType: 'compaction' } }, { chunk: { block: { type: 'compaction', item } } },
    ] })
    expect(raw.data.stream[0]?.chunk.blockType).toBe('plugin:compaction')
  })

  it.each([
    'agent/inbox/spliced', 'session/title-llm-request',
  ])('promotes each declared message in %s without admitting a malformed container', (type) => {
    const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
    const value = user([checkpoint]).data
    const original: SessionFormatEvent = { type, seq: 0, time: 2, data: { [key]: [value] } }
    expect(mapCompactionContent(original, true).data).toMatchObject({ [key]: [{ content: [{ type: 'compaction', item }] }] })
    const malformed: SessionFormatEvent = { type, seq: 0, time: 2, data: { [key]: 'not an array' } }
    expect(mapCompactionContent(malformed, true)).toBe(malformed)
    const invalid = { header: { ...header, version: 5 }, events: [malformed], inheritedEventCount: 0 }
    expect(() => { restoreReleasedV5Artifact(invalid, new Set([type])) }).toThrow()
  })

  it('keeps interleaved stage state independent and derives unknown inherited cuts from markers', () => {
    const seeded = { ...header, isSeeded: true, parentSession: 'parent' }
    const a = stage(seeded)
    const b = stage()
    const left = new SessionFormatEventCollector()
    const right = new SessionFormatEventCollector()
    const row = user([checkpoint])
    a.transformRun({ runType: 'test', firstSeq: 0, eventCount: 1, * expand() { yield row } }, left)
    b.transformEvent(row, right)
    a.transformEvent({ type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }, left)
    expect(a.finish(left)).toBe(1)
    expect(b.finish(right)).toBe(0)
    expect(a.headerInheritedEventCount).toBeUndefined()
    expect(b.headerInheritedEventCount).toBe(0)
    expect(() => migrate([row], seeded)).toThrow(/inherited event count/)
    expect(() => migrate([...left.values], seeded, 0)).toThrow(/inherited cut/)
    expect(() => migrate([{ ...row, seq: 1 }])).toThrow(/dense/)
    expect(() => migrate([{ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } }])).toThrow(/unseeded/)
  })

  it('validates V4 delivery ownership before migration and rejects premature V5 activation', () => {
    const row = user([])
    expect(() => migrate([row, delivery(4, 'other')])).toThrow(/wrong Session/)
    expect(() => migrate([row, delivery(5)])).toThrow(/claims target format v5/)
    expect(() => migrate([row, delivery(4, 'parent')], { ...header, parentSession: 'parent' })).toThrow(/wrong Session/)
    const seeded = { ...header, isSeeded: true, parentSession: 'parent' }
    const seed: SessionFormatEvent = { type: 'session/end-seed', seq: 2, time: 4, data: { inherited: true } }
    expect(migrate([row, delivery(4, 'parent'), seed], seeded).inheritedEventCount).toBe(2)
    expect(() => migrate([row, delivery(4, 'parent'), seed, { ...delivery(4, 'parent'), seq: 3 }], seeded)).toThrow(/wrong Session/)
    const migrated = migrate([row, delivery(4)])
    expect(restoreReleasedV5Artifact(migrated, known)).toBe(migrated)
    expect(() => { restoreReleasedV5Artifact({ ...migrated, events: [row, delivery(5, 'other')] }, known) }).toThrow(/wrong Session/)
    expect(restoreReleasedV5Artifact({ ...migrated, events: [row, delivery(4, 'other')] }, known).events[1]).toEqual(delivery(4, 'other'))
  })
})

describe('V5 native codec', () => {
  it('rejects a mismatched native logical or physical header before decoding rows', () => {
    for (const invalid of [null, { ...header, version: 4 }]) {
      expect(() => { assertReleasedV5Header(invalid) }).toThrow(/expected format v5 header/)
      expect(() => releasedV5SessionFormatCodec.decodeHeader(invalid)).toThrow(/expected format v5 physical header/)
      expect(() => releasedV5SessionFormatCodec.createDecoder(invalid, 'recoverable')).toThrow(/expected format v5 physical header/)
    }
  })

  it.each(['strict', 'recoverable'] as const)('rejects malformed checkpoints before %s tail recovery', (recovery) => {
    const codec = releasedV5SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 5 }, recovery)
    const out = new SessionFormatEventCollector()
    expect(() => { codec.decodeRow(user([{ type: 'compaction', item: { ...item, encrypted_content: '' } }]), out) }).toThrow(/opaque encrypted/)
    expect(() => releasedV5SessionFormatCodec.encodeEvent(user([{ type: 'compaction', item: { ...item, type: 'future' } }]))).toThrow(/opaque encrypted/)
  })

  it('round trips an opaque native checkpoint without rewriting its encrypted item', () => {
    const row = user([{ type: 'compaction', item }])
    const physical = releasedV5SessionFormatCodec.encodeEvent(row)
    const logicalHeader = { ...header, version: 5 }
    const encodedHeader = releasedV5SessionFormatCodec.encodeHeader(logicalHeader, 0)
    const codec = releasedV5SessionFormatCodec.createDecoder(encodedHeader, 'strict')
    const out = new SessionFormatEventCollector()
    codec.decodeRow(physical, out)
    expect(codec.finish(out)).toBe(0)
    expect(codec.header).toEqual(logicalHeader)
    expect(out.values).toEqual([row])
    expect(releasedV5SessionFormatCodec.decodeHeader(encodedHeader)).toEqual(logicalHeader)
  })

  it('keeps the old V4 reader future-version refusal instead of implying downgrade support', () => {
    const future = { type: 'session', ...header, version: 5 }
    expect(() => releasedV4SessionFormatCodec.decodeHeader(future)).toThrow(/expected format v4 physical header/)
    expect(() => releasedV4SessionFormatCodec.createDecoder(future, 'strict')).toThrow(/expected format v4 physical header/)
  })
})
