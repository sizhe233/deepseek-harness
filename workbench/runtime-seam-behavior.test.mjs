import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applySeams } from './apply-runtime-seams.mjs'
import { deepFreeze } from '../packages/util/values/lib/index.js'

const controller = applySeams('dsh-api-session-controller', readFileSync(new URL('../packages/api/session-controller/lib/index.js', import.meta.url), 'utf8'))
const loop = applySeams('dsh-agent-loop', readFileSync(new URL('../packages/core/agent-loop/lib/index.js', import.meta.url), 'utf8'))
function extract(source, start, end) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, 'reviewed runtime entry is missing')
  const to = source.indexOf(end, from)
  assert.ok(to > from, 'reviewed runtime entry end is missing')
  return source.slice(from, to + end.length)
}
class RemoteError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details }
}

// Evaluate only the inspected methods from the actual candidate bundle, not a rewritten stand-in.
const prompt = new Function('RemoteError', `return ({${extract(controller, '\t\tprompt(request, signal) {', '\n\t\t}')}}).prompt`)(RemoteError)
const send = new Function(`return ({${extract(loop, '\tsend(message, target, wakeup) {', '\n\t}')}}).send`)()

test('restart admission preserves native calls and rejects new work before the inbox', async () => {
  let prompts = 0
  let queued = 0
  let draining = false
  const gate = {
    async run(action) { if (draining) throw new Error('service-restarting'); return action() },
    assertWakeup() { if (draining) throw new Error('service-restarting') },
  }
  const native = { ctx: { get: () => undefined }, commands: { prompt: async () => { prompts++; return { accepted: true } } } }
  const signal = { throwIfAborted() {} }
  assert.deepEqual(await prompt.call(native, {}, signal), { accepted: true })
  const guarded = { ...native, ctx: { get: key => { assert.equal(key, 'runtimeRestartAdmission'); return gate } } }
  assert.deepEqual(await prompt.call(guarded, {}, signal), { accepted: true })
  const agent = { loopCtx: guarded.ctx, phase: { kind: 'idle' }, inbox: { splice() { queued++ } }, wakeDriver() {} }
  send.call(agent, {}, 'next-turn', true)
  draining = true
  await assert.rejects(prompt.call(guarded, {}, signal), error => error.code === 'session/agent-busy' && error.details.reason === 'service-restarting')
  assert.throws(() => send.call(agent, {}, 'next-turn', true), /service-restarting/)
  send.call(agent, {}, 'next-step', false)
  assert.equal(prompts, 2)
  assert.equal(queued, 2)
  const failure = new Error('unrelated command failure')
  await assert.rejects(prompt.call({ ...native, ctx: { get: () => ({ run: async () => { throw failure } }) } }, {}, signal), error => error === failure)
  assert.throws(() => prompt.call(native, {}, { throwIfAborted() { throw new Error('already aborted') } }), /already aborted/)
})

test('text-model image admission requires a viable optional relay and preserves native image routes', async () => {
  const statement = controller.match(/if \(model\.inputModalities[^;]+;/)?.[0]
  assert.ok(statement?.includes('visionImageRelay'), 'image admission bridge is missing')
  const admit = new Function('RemoteError', `return async function(model, current, agent) { ${statement} return true }`)(RemoteError)
  const current = { model: 'test-model' }
  const owner = { id: 'synthetic-session' }
  const text = { inputModalities: ['text'] }
  await assert.rejects(admit.call({ ctx: { get: () => undefined } }, text, current, owner), error => error.code === 'session/attachment-invalid')
  await assert.rejects(admit.call({ ctx: { get: () => ({ canAdmit: async () => false }) } }, text, current, owner), error => error.code === 'session/attachment-invalid')
  let calls = 0
  const allowed = { ctx: { get: () => ({ canAdmit: async agent => { assert.equal(agent, owner); calls++; return true } }) } }
  assert.equal(await admit.call(allowed, text, current, owner), true)
  assert.equal(await admit.call(allowed, { inputModalities: ['text', 'image'] }, current, owner), true)
  assert.equal(await admit.call(allowed, {}, current, owner), true)
  assert.equal(calls, 1)
})

test('relay projection is limited to root text-only requests and freezes replacement messages', () => {
  const from = loop.indexOf('\t\tconst relay = this.loopCtx.get("visionImageRelay");')
  const to = loop.indexOf('\t\treturn markAgentLoopRequest', from)
  assert.ok(from >= 0 && to > from, 'request projection bridge is missing')
  const project = new Function('deepFreeze', `return function(boundaryMessages, preparedCall) { ${loop.slice(from, to)} return modelMessages }`)(deepFreeze)
  const original = Object.freeze([deepFreeze({ role: 'user', content: [{ type: 'image', id: 'original-attachment' }] })])
  const projected = [{ role: 'user', content: [{ type: 'text', text: 'synthetic image handle' }] }]
  let calls = 0
  const make = (origin, relay) => ({ session: { header: { origin } }, loopCtx: { get: () => relay } })
  const relay = { project(messages) { assert.equal(messages, original); calls++; return projected } }
  assert.equal(project.call(make('user', relay), original, { inputModalities: ['text'] }), projected)
  assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected[0].content[0]))
  assert.equal(original[0].content[0].id, 'original-attachment')
  assert.equal(project.call(make('subagent', relay), original, { inputModalities: ['text'] }), original)
  assert.equal(project.call(make('user', relay), original, { inputModalities: ['image'] }), original)
  assert.equal(project.call(make('user', relay), original, undefined), original)
  assert.equal(project.call(make('user', undefined), original, { inputModalities: ['text'] }), original)
  assert.equal(calls, 1)
})
