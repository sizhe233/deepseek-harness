import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, relative } from 'node:path'
function once(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `unreviewed ${label} source shape`)
  return source.replace(before, after)
}

export function stageVisionRelayText(name, source) {
  if (name === 'dsh-api-session-controller') {
    const before = 'if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });'
    return once(source, before, 'if (model.inputModalities !== void 0 && !model.inputModalities.includes("image") && !await this.ctx.get("visionImageRelay")?.canAdmit(agent)) throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });', name)
  }
  if (name === 'dsh-agent-loop') {
    let result = once(source,
      '\t\tObject.freeze(boundaryMessages);\n\t\treturn markAgentLoopRequest(Object.freeze({',
      '\t\tObject.freeze(boundaryMessages);\n\t\tconst relay = this.loopCtx.get("visionImageRelay");\n\t\tconst modelMessages = this.session.header.origin !== "subagent" && preparedCall?.inputModalities !== void 0 && !preparedCall.inputModalities.includes("image") && relay ? relay.project(boundaryMessages) : boundaryMessages;\n\t\tif (modelMessages !== boundaryMessages) {\n\t\t\tfor (const message of modelMessages) deepFreeze(message);\n\t\t\tObject.freeze(modelMessages);\n\t\t}\n\t\treturn markAgentLoopRequest(Object.freeze({', name)
    result = once(result, '\t\t\tmessages: boundaryMessages,', '\t\t\tmessages: modelMessages,', name)
    return result
  }
  throw new Error('unsupported DSH bundle')
}

const candidates = {
  '@deepseek-ai/dsh-api-session-controller': {
    before: '\t\tprompt(request, signal) {\n\t\t\tsignal.throwIfAborted();\n\t\t\treturn this.commands.prompt(request);\n\t\t}',
    after: '\t\tprompt(request, signal) {\n\t\t\tsignal.throwIfAborted();\n\t\t\tconst gate = this.ctx.get("runtimeRestartAdmission");\n\t\t\tif (gate === void 0) return this.commands.prompt(request);\n\t\t\treturn gate.run(() => this.commands.prompt(request)).catch(error => {\n\t\t\t\tif (error?.message === "service-restarting") throw new RemoteError("session/agent-busy", "service is restarting", { reason: "service-restarting" });\n\t\t\t\tthrow error;\n\t\t\t});\n\t\t}',
  },
  '@deepseek-ai/dsh-agent-loop': {
    before: '\tsend(message, target, wakeup) {\n\t\tconst wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;',
    after: '\tsend(message, target, wakeup) {\n\t\tif (wakeup) this.loopCtx.get("runtimeRestartAdmission")?.assertWakeup();\n\t\tconst wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;',
  },
}

export function applySeams(name, source) {
  const gate = candidates['@deepseek-ai/' + name]
  assert.ok(gate, 'unsupported bundle')
  return stageVisionRelayText(name, once(source, gate.before, gate.after, name))
}
const root = fileURLToPath(new URL('../', import.meta.url))
export function applyBuiltSeams() {
  const manifest = JSON.parse(readFileSync(new URL('runtime-seams.json', import.meta.url), 'utf8'))
  // Validate every input before writing any file. Only this checkout's build outputs are accepted.
  const pending = manifest.files.map(spec => {
    const path = realpathSync(resolve(root, spec.path))
    assert.equal(relative(root, path), spec.path, 'bundle escaped this checkout')
    const before = readFileSync(path, 'utf8')
    const digest = createHash('sha256').update(before).digest('hex')
    if (digest === spec.afterSha256) return null
    assert.equal(digest, spec.beforeSha256, 'unreviewed build: ' + spec.path)
    const after = applySeams(spec.name, before)
    assert.equal(createHash('sha256').update(after).digest('hex'), spec.afterSha256)
    return { path, after }
  }).filter(Boolean)
  for (const { path, after } of pending) writeFileSync(path, after)
  console.log('Verified legacy runtime seams in ' + manifest.files.length + ' built bundles')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) applyBuiltSeams()
