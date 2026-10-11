/** V5 restoration retains official attribution and mid-conversation updates beside opaque checkpoints. */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('v5-upstream-compatibility')
const item = { type: 'compaction_summary', encrypted_content: 'retained-ciphertext', metadata: { retained: [true, null] } }
const text = (value: string) => [{ type: 'text', text: value }]

function events(version: 4 | 5): SessionFormatEvent[] {
  const rows: (Pick<SessionFormatEvent, 'type' | 'data'> & SessionFormatJsonObject)[] = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
      id: 'system-head', role: 'system', source: { kind: 'system-prompt' }, content: text('Initial system prompt'),
    } } },
    { type: 'user/message', surfaceOp: 'append', data: {
      id: 'human', role: 'user', source: { kind: 'user' }, content: text('Continue in the selected directory'),
    } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'working-directory/change', data: { cwd: '/workspace/selected' } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 2, message: {
      id: 'system-update', role: 'system', source: { kind: 'system-prompt' }, content: text('Updated system prompt'),
    } } },
    { type: 'request/header', data: { reason: 'change', header: {
      config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Find a file', parameters: {} }],
    } } },
    { type: 'developer/message', surfaceOp: 'append', data: { turn: 1, step: 2, headerSeq: 8, message: {
      id: 'tool-update', role: 'developer', source: { kind: 'tool-registry' },
      content: [{ type: 'tool-removal', toolName: 'old' }, { type: 'tool-addition', toolName: 'search' }],
    } } },
    { type: 'user/message', surfaceOp: 'append', data: {
      id: 'directory-notice', role: 'user', source: { kind: 'working-directory', metadata: { retained: true } },
      content: text('The working directory changed to the selected directory.'),
    } },
    { type: 'user/message', surfaceOp: 'append', data: {
      id: 'checkpoint', role: 'user', source: { kind: 'user' },
      content: [{ type: version === 4 ? 'plugin:compaction' : 'compaction', item }],
    } },
    { type: 'external/audit', ignorable: true, data: {
      message: { content: [{ type: 'compaction', item: { type: 'unknown', encrypted_content: '' } }] },
      metadata: { retained: [null, true, 'opaque plugin record'] },
    } },
    { type: 'step/end', data: { turn: 1, step: 2 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'session/title-llm-request', data: {
      titleProvider: 'test', messageSeqs: [3], route: { provider: 'test', model: 'test' }, system: 'Summarize the request',
      messages: [{ id: 'title-input', role: 'user', source: { kind: 'dsh-session-title-llm' }, content: text('Continue in the selected directory') }],
      maxTokens: 32, reasoningEffort: 'low',
    } },
  ]
  return rows.map((row, seq) => ({ ...row, seq, time: seq + 2 }))
}

async function observation(path: string) {
  const info = await stat(path, { bigint: true })
  return { bytes: await readFile(path), inode: info.ino, dev: info.dev, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs }
}

describe('V5 mixed-feature persistence', () => {
  it.each([4, 5] as const)('preserves attribution, prompt/tool updates, title effort and opaque records from V%i through reopen', async (version) => {
    expect(SESSION_FORMAT_VERSION).toBe(5)
    const root = await mkdtemp(join(tmpdir(), 'dsh-v5-upstream-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    })
    const source = generationLogPath(root, undefined, id, version, 'none')
    const target = generationLogPath(root, undefined, id, 5, 'none')
    const header = { type: 'session', id, version, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, [header, ...events(version)].map(value => JSON.stringify(value) + '\n').join(''))
    const original = await observation(source)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    const inspect = async (access: 'read' | 'write') => {
      const handle = await ctx.sessionPersistence.open(id, access)
      try {
        const restored = await handle.read()
        expect(handle.header.version).toBe(5)
        expect(restored.events).toEqual(events(5))
        const session = Session.fromRestore(id, restored.events, handle.header, handle.inheritedEventCount, restored.eventState)
        const messages = session.deriveMessages()
        expect(messages.map(message => message.id)).toEqual([
          'system-head', 'human', 'system-update', 'tool-update', 'directory-notice', 'checkpoint',
        ])
        expect(messages[4]).toMatchObject({ source: { kind: 'working-directory', metadata: { retained: true } } })
        expect(messages[5]?.content).toEqual([{ type: 'compaction', item }])
        if (access === 'write') await handle.flush()
      } finally { await handle.close() }
    }

    await inspect('read')
    expect(await observation(source)).toEqual(original)
    if (version === 4) await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await inspect('write')
    const published = await observation(target)
    await inspect('read')
    await inspect('write')
    expect(await observation(target)).toEqual(published)
    expect(await observation(source)).toEqual(original)
  })
})
