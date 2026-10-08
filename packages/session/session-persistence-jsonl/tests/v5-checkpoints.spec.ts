/** Opaque checkpoint upgrades publish only a V5 successor and preserve every predecessor. */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalogOptions } from '@deepseek-ai/dsh-session-format-catalog/src/generated.ts'
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'

const roots: string[] = []
const contexts: Context[] = []
const item = { type: 'compaction_summary' as const, encrypted_content: 'opaque', metadata: { seq: 987, flags: [true, null] } }
const id = SessionId('native-checkpoint')
const header = { type: 'session', id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
const row = (type: string) => ({ type: 'user/message', seq: 0, time: 2, surfaceOp: 'append',
  data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type, item }] } })

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function observation(path: string) {
  const info = await stat(path, { bigint: true })
  return { bytes: await readFile(path), inode: info.ino, dev: info.dev, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs }
}

async function fixture(version: 3 | 4) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v5-checkpoint-'))
  roots.push(root)
  const predecessors: string[] = []
  for (const generation of version === 3 ? [3] : [3, 4]) {
    const path = generationLogPath(root, undefined, id, generation, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...header, version: generation }) + '\n' + JSON.stringify(row(generation === 3 ? 'compaction' : 'plugin:compaction')) + '\n')
    predecessors.push(path)
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { root, ctx, predecessors, target: generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none') }
}

describe('V5 checkpoint publication', () => {
  it.each([3, 4] as const)('reads V%i without publication, publishes V5 once, and reopens opaque data losslessly', async (version) => {
    expect(SESSION_FORMAT_VERSION).toBe(5)
    const f = await fixture(version)
    const originals = await Promise.all(f.predecessors.map(observation))
    const inspect = async (access: 'read' | 'write') => {
      const handle = await f.ctx.sessionPersistence.open(id, access)
      try {
        const read = await handle.read()
        const session = Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
        expect(handle.header.version).toBe(5)
        expect(session.deriveMessages()[0]?.content).toEqual([{ type: 'compaction', item }])
        if (access === 'write') await handle.flush()
      } finally { await handle.close() }
    }
    await inspect('read')
    await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    await inspect('write')
    const published = await observation(f.target)
    await inspect('read')
    await inspect('write')
    expect(await observation(f.target)).toEqual(published)
    expect(await Promise.all(f.predecessors.map(observation))).toEqual(originals)
    expect((await readdir(dirname(f.target))).filter(name => name.endsWith('.jsonl')).sort())
      .toEqual(version === 3 ? ['session.v3.jsonl', 'session.v5.jsonl'] : ['session.v3.jsonl', 'session.v4.jsonl', 'session.v5.jsonl'])
  })

  it('creates a native V5 writer and keeps an opaque checkpoint after reopen', async () => {
    const f = await fixture(3)
    const freshId = SessionId('fresh')
    const session = Session.create(freshId)
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'compaction', item }] }), { surfaceOp: 'append' })
    const writer = await f.ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    const reader = await f.ctx.sessionPersistence.open(freshId, 'read')
    try {
      expect(reader.header.version).toBe(5)
      const restored = await reader.read()
      expect(restored.events[0]?.data).toMatchObject({ content: [{ type: 'compaction', item }] })
    } finally { await reader.close() }
  })

  it('retains predecessor-only rollback material while an old reader rejects the selected V5 header', async () => {
    const f = await fixture(4)
    const original = await Promise.all(f.predecessors.map(observation))
    const writer = await f.ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    const old = createSessionFormatCatalog({ ...sessionFormatCatalogOptions, currentVersion: 4,
      codecs: sessionFormatCatalogOptions.codecs.filter(codec => codec.version <= 4),
      migrations: sessionFormatCatalogOptions.migrations.filter(edge => edge.toVersion <= 4), currentEncoder: releasedV4SessionFormatCodec,
      restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set(['user/message'])),
      restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set(['user/message'])),
      restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
    })
    const currentHeader: unknown = JSON.parse((await readFile(f.target, 'utf8')).split('\n')[0]!)
    expect(old.readHeader(currentHeader)).toMatchObject({ status: 'unsupported', storedVersion: 5, targetVersion: 4 })
    const prior = old.createRestore({ ...header, version: 4 }, { recovery: 'strict', validation: 'current' })
    prior.decodeRow(row('plugin:compaction'))
    expect(prior.finish().events[0]?.data).toMatchObject({ content: [{ type: 'plugin:compaction', item }] })
    expect(await Promise.all(f.predecessors.map(observation))).toEqual(original)
  })

  it('keeps V4 revision and prepared migration independent of changing child artifacts', async () => {
    const f = await fixture(4)
    const revision = (await f.ctx.sessionPersistence.stat(id))!.revision
    const reader = await f.ctx.sessionPersistence.open(id, 'read')
    await reader.read()
    await reader.close()
    const childId = SessionId('unrelated-child')
    const childPath = generationLogPath(f.root, undefined, childId, 3, 'none')
    await mkdir(dirname(childPath), { recursive: true })
    await writeFile(childPath, JSON.stringify({ ...header, id: childId, version: 3, origin: 'subagent', parentSession: id }) + '\n{broken child body\n')
    expect((await f.ctx.sessionPersistence.stat(id))!.revision).toBe(revision)
    expect((await f.ctx.sessionPersistence.list()).find(entry => entry.header.id === id)?.revision).toBe(revision)
    const changedChild = await observation(childPath)
    const writer = await f.ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    expect(await readFile(f.target, 'utf8')).toContain('opaque')
    expect(await observation(childPath)).toEqual(changedChild)
  })

  it('rejects a malformed native V5 checkpoint even after a corrupt JSON prefix', async () => {
    const f = await fixture(4)
    const invalid = row('compaction')
    invalid.data.content[0]!.item = { ...item, encrypted_content: '' }
    await writeFile(f.target, JSON.stringify({ ...header, version: 5 }) + '\n{broken prefix}\n' + JSON.stringify(invalid) + '\n')
    const paths = [...f.predecessors, f.target]
    const before = await Promise.all(paths.map(observation))
    await expect(f.ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(/opaque encrypted/)
    await expect(f.ctx.sessionPersistence.open(id, 'write')).rejects.toThrow(/opaque encrypted/)
    expect(await Promise.all(paths.map(observation))).toEqual(before)
  })

  it('refuses an invalid selected V4 checkpoint without publishing or falling back to V3', async () => {
    const f = await fixture(4)
    const path = f.predecessors[1]!
    const invalid = row('compaction')
    invalid.data.content[0]!.item = { ...item, encrypted_content: '' }
    await writeFile(path, JSON.stringify({ ...header, version: 4 }) + '\n' + JSON.stringify(invalid) + '\n')
    const original = await Promise.all(f.predecessors.map(observation))
    await expect(f.ctx.sessionPersistence.open(id, 'write')).rejects.toThrow(/opaque encrypted/)
    await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await Promise.all(f.predecessors.map(observation))).toEqual(original)
  })

  it('does not fall back to V4 when a future selected generation exists', async () => {
    const f = await fixture(4)
    const original = await Promise.all(f.predecessors.map(observation))
    const future = generationLogPath(f.root, undefined, id, SESSION_FORMAT_VERSION + 1, 'none')
    await writeFile(future, JSON.stringify({ ...header, version: SESSION_FORMAT_VERSION + 1 }) + '\n')
    await expect(f.ctx.sessionPersistence.open(id, 'read')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    expect(await Promise.all(f.predecessors.map(observation))).toEqual(original)
    expect(sessionFormatCatalog.currentVersion).toBe(5)
  })

  it('keeps strict V3→V4→V5 restoration deterministic without changing source rows', () => {
    const source = row('compaction')
    const saved = JSON.stringify(source)
    const restore = () => {
      const reader = createSessionFormatCatalogWithChildren([]).createRestore({ ...header, version: 3 }, { recovery: 'strict', validation: 'current' })
      reader.decodeRow(source)
      return reader.finish()
    }
    expect(restore()).toEqual(restore())
    expect(restore().events[0]?.data).toMatchObject({ content: [{ type: 'compaction', item }] })
    expect(JSON.stringify(source)).toBe(saved)
  })
})
