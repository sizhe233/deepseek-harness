/** Test-only coarse-owner interception; every forwarded method executes the actual admitted native owner. */
import assert from 'node:assert/strict'
import { readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installOwnerObserver } from './owner-observer.mjs'

const [entry, rootPath, scenario, targetName] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
const events = [], labels = new WeakMap()
let labelCount = 0, active = false, source, parent, sourceIdentity, faultInjected = false
let renameSucceeded = false, flushes = 0, directory, result
const label = file => {
  if (!labels.has(file)) labels.set(file, `capability-${++labelCount}`)
  return labels.get(file)
}
const identity = value => {
  const bytes = Buffer.from(value)
  assert.equal(bytes.length, 24)
  return { volumeSerial: bytes.readBigUInt64LE().toString(16).padStart(16, '0'), fileId: bytes.subarray(8).toString('hex') }
}
const fail = (event, message, fields = {}) => {
  event.injected = true; faultInjected = true
  throw Object.assign(new Error(message), fields)
}
const observer = installOwnerObserver(entry, (name, args, invoke, owner) => {
  if (!active) return invoke()
  assert.ok(events.length < 2000, 'Coarse native trace exceeded its fixed bound')
  const event = { name, forwarded: false, ...(typeof args[0] === 'object' && args[0] !== null ? { capability: label(args[0]) } : {}) }
  events.push(event)
  const isSource = source !== undefined && args[0] === source
  if (name === 'query') { event.informationClass = args[1]; event.volume = args[3] }
  if (name === 'open' && renameSucceeded && scenario === 'rename-return-lost-unqueryable') {
    fail(event, 'Injected final-binding inspection failure', { nativeStatus: 0xc0000022 })
  }
  if (name === 'write' && isSource) {
    event.requestedBytes = args[1].byteLength
    if (scenario === 'write-failure' && !faultInjected) fail(event, 'Injected write refusal', { win32Code: 29 })
    if (scenario === 'short-write' && !faultInjected && args[1].byteLength > 1) {
      args[1] = args[1].subarray(0, Math.floor(args[1].byteLength / 2))
      event.shortWriteRequested = args[1].byteLength; event.injected = 'short-request-forwarded'; faultInjected = true
    }
  }
  if (name === 'flush' && isSource) {
    event.flushNumber = ++flushes
    if ((scenario === 'pre-flush-failure' && flushes === 1) || (scenario === 'post-flush-failure' && flushes === 2)) {
      fail(event, 'Injected flush refusal', { win32Code: 29 })
    }
  }
  if (name === 'rename' && isSource) {
    event.targetParent = label(args[1]); event.targetName = args[2]; event.replace = args[3]
    event.relativeToAdmittedParent = args[1] === parent
    if (scenario === 'rename-failure') fail(event, 'Injected rename refusal', { nativeStatus: 0xc0000001 })
  }
  if (name === 'fileId' && renameSucceeded && scenario === 'verification-failure' && !faultInjected) {
    fail(event, 'Injected identity query refusal', { win32Code: 31 })
  }
  event.forwarded = true
  const returned = invoke()
  event.completed = true
  if (typeof returned === 'number') event.returned = returned
  if (name === 'open' && args[3] === 'create') {
    source = returned; parent = args[0]
    event.sourceCapability = label(source); event.sourceName = args[1]; event.sourceParent = label(parent)
    event.requestedKind = args[2]; event.requestedMode = args[3]
    sourceIdentity = identity(owner.fileId(source))
    const mode = Buffer.from(owner.query(source, 16, 4, false))
    assert.equal(mode.length, 4)
    event.actualMode = mode.readUInt32LE(); event.actualModeScope = 'retained-source-handle'
    if (scenario === 'creation-barrier') {
      writeSync(1, `${JSON.stringify({ event: 'created-before-write', path: join(rootPath, args[1]), sourceCapability: label(source) })}\n`)
      if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('Creation barrier controller disappeared')
    }
  }
  if (name === 'fileId' && isSource) { sourceIdentity = identity(returned); event.identity = sourceIdentity }
  if (name === 'query' && isSource && args[1] === 16) event.mode = Buffer.from(returned).readUInt32LE()
  if (name === 'rename' && isSource) {
    renameSucceeded = true
    if (scenario === 'rename-return-lost' || scenario === 'rename-return-lost-unqueryable') {
      fail(event, 'Injected lost return after successful native rename', { nativeStatus: 0xc0000001 })
    }
  }
  if (name === 'close' && isSource && renameSucceeded && scenario === 'close-failure' && !faultInjected) {
    event.actuallyReleased = true
    fail(event, 'Injected lost return after successful native close', { win32Code: 6, cleanupFailed: true })
  }
  return returned
})
try {
  const storage = await import(pathToFileURL(entry).href)
  directory = storage.openPrivateDirectory(rootPath, { create: false })
  if (scenario === 'root-guard-barrier') {
    writeSync(1, `${JSON.stringify({ event: 'root-guard-retained', path: rootPath })}\n`)
    if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('Root guard controller disappeared')
  }
  active = true
  result = { ok: true, receipt: storage.replacePrivateFile(directory, targetName, Buffer.from('synthetic fault-worker new record\n')) }
} catch (error) {
  result = { ok: false, name: error.name, code: error.code ?? null, nativeStatus: error.nativeStatus ?? null,
    win32Code: error.win32Code ?? null, cleanupFailed: error.cleanupFailed === true, receipt: error.receipt ?? null, reason: error.message }
} finally {
  active = false
  try { directory?.close() } catch (error) { result.closeFailure = error.message }
  observer.restore()
}
writeSync(1, `${JSON.stringify({ event: 'result', nativeCallsForwarded: true, observationLayer: 'opaque-native-owner-methods',
  ownerBinding: observer.binding, scenario, faultInjected, sourceIdentity,
  sourceCapability: source === undefined ? null : label(source), events, result })}\n`)
