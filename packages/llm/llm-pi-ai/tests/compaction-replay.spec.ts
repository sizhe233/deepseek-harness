import { describe, expect, it } from 'vitest'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { toPiAssistant } from '../src/replay.ts'

const tool: ContentBlock = { type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '{}' }
const required = { provider: 'gateway', model: 'gpt-test', requiresReasoningTextOnToolReplay: true }
const validSignature = JSON.stringify({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'original' }] })

function message(signatures: readonly (string | undefined)[], toolFirst = false) {
  const reasoning: ContentBlock[] = signatures.map(() => ({ type: 'reasoning', text: 'saved thought' }))
  const blocks = signatures.map(signature => ({ type: 'reasoning',
    ...signature === undefined ? {} : { thinkingSignature: signature } }))
  return createAssistantMessage({
    content: toolFirst ? [tool, ...reasoning] : [...reasoning, tool],
    source: { provider: 'gateway', model: 'gpt-test', replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: 'gateway', model: 'gpt-test',
        responseModel: 'dated-model', responseId: 'linked-response', stopReason: 'toolUse' },
      blocks: toolFirst ? [{ type: 'tool-call' }, ...blocks] : [...blocks, { type: 'tool-call' }],
    } },
  })
}

describe('required reasoning text on tool replay', () => {
  it('leaves tool-free history and usable native reasoning unchanged', () => {
    const plain = createAssistantMessage({ content: [{ type: 'text', text: 'answer' }],
      source: { provider: 'gateway', model: 'gpt-test' } })
    expect(toPiAssistant(plain, required).content).toEqual([{ type: 'text', text: 'answer' }])
    const source = message([validSignature])
    expect(toPiAssistant(source, required)).toMatchObject({ responseId: 'linked-response', responseModel: 'dated-model',
      content: [{ type: 'thinking', thinkingSignature: validSignature }, { type: 'toolCall' }] })
  })

  it.each([undefined, 'not-json', 'null', '{}', '{"type":"text","content":[]}',
    '{"type":"reasoning","content":{}}', '{"type":"reasoning","content":[null,1,{}, {"type":"text"}]}'])
  ('replaces unusable reasoning signature %j with an unlinked transient item', (signature) => {
    const source = message([signature])
    const before = JSON.stringify(source)
    const replayed = toPiAssistant(source, required)
    expect(replayed.api).toBe('openai-responses')
    expect(replayed).not.toHaveProperty('responseId')
    expect(replayed).not.toHaveProperty('responseModel')
    expect(replayed.content.map(block => block.type)).toEqual(['thinking', 'thinking', 'toolCall'])
    expect(replayed.content[0]).toEqual({ type: 'thinking', thinking: 'saved thought' })
    const inserted = replayed.content[1]
    expect(inserted?.type).toBe('thinking')
    if (inserted?.type !== 'thinking') throw new Error('missing transient reasoning')
    expect(JSON.parse(inserted.thinkingSignature!)).toEqual({ type: 'reasoning', summary: [],
      content: [{ type: 'reasoning_text', text: '[reasoning unavailable after model failover]' }] })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('preserves usable reasoning after a tool while inserting the required preceding item', () => {
    const source = message([validSignature], true)
    const replayed = toPiAssistant(source, { ...required, api: 'openai-codex-responses' })
    expect(replayed.api).toBe('openai-codex-responses')
    expect(replayed.content.map(block => block.type)).toEqual(['thinking', 'toolCall', 'thinking'])
    expect(replayed.content[2]).toMatchObject({ thinkingSignature: validSignature })
  })
})
