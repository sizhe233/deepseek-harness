/** Actual factory GC with test-only module interception; no native acceptance is inferred. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { FakeNative } from '../fake-native.ts'

class SourceFake extends FakeNative {
  inspectSource(handle) {
    const { ownerSid, daclProtected, ...facts } = this.inspect(handle)
    return { ...facts, securityDescriptorSha256: 'a'.repeat(64) }
  }
  admitSourceFilesystem() { return { filesystem: 'NTFS', flags: 8, deviceType: 7, deviceCharacteristics: 0 } }
}
const native = new SourceFake(), symbol = Symbol.for('dsh-storage-stream-gc-test')
globalThis[symbol] = native.asNative()
const nativeURL = new URL('../../src/native.ts', import.meta.url).href
const hook = registerHooks({ load(url, context, next) {
  if (url === nativeURL) return { format: 'module', shortCircuit: true,
    source: 'export function loadNativeStorage() { return globalThis[Symbol.for("dsh-storage-stream-gc-test")] }' }
  return next(url, context)
} })
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
const storage = await import('../../src/index.ts')
const digest = createHash('sha256').update('a').digest('hex')
function allocate(kind, close) {
  for (let i = 0; i < 100; i++) {
    if (kind === 'writer') {
      const parent = storage.openPrivateDirectory('C:\\private', { create: false })
      const writer = storage.createPrivateFileWriter(parent, `record-${i}`, {
        operationId: 'synthetic-gc', expectedBytes: 1, expectedSha256: digest, replace: false, executable: false,
      })
      parent.close()
      writer.append(Buffer.from('a'))
      if (close) writer.close()
    } else {
      const parent = storage.openSourceDirectory('C:\\private')
      const source = storage.inspectSourceFile(parent, 'source')
      const reader = storage.openSourceFileReader(parent, 'source', { expectedIdentity: source.identity, expectedBytes: 1, expectedSha256: digest })
      parent.close()
      reader.readChunk(1)
      if (close) reader.close()
    }
  }
}
const kind = process.argv[2]
assert.ok(kind === 'writer' || kind === 'source')
native.add(2n, 'source', 'file', Buffer.from('a'))
allocate(kind, true)
assert.equal(native.handles.size, 0)
allocate(kind, false)
assert.ok(native.handles.size >= 300)
const mutationCount = native.events.filter(event => event === 'rename' || event === 'remove').length
const deadline = performance.now() + 15_000
while (native.handles.size && performance.now() < deadline) { globalThis.gc(); await setImmediate() }
assert.equal(native.handles.size, 0, 'Actual stream resource finalizer must release all retained handles')
assert.equal(native.events.filter(event => event === 'rename' || event === 'remove').length, mutationCount)
hook.deregister(); delete globalThis[symbol]
console.log(JSON.stringify({ kind, explicitClose: true, collected: true, handles: 0, namespaceMutationByGc: false }))
