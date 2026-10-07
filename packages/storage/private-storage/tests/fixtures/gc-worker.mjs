/** Test-only module interception exercises the actual public capability factories under V8 GC. */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { FakeNative } from '../fake-native.ts'

const native = new FakeNative()
const symbol = Symbol.for('dsh-private-storage-gc-test')
globalThis[symbol] = native.asNative()
const nativeURL = new URL('../../src/native.ts', import.meta.url).href
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === nativeURL) return { format: 'module', shortCircuit: true, source: 'export function loadNativeStorage() { return globalThis[Symbol.for("dsh-private-storage-gc-test")] }' }
    return nextLoad(url, context)
  },
})
const storage = await import('../../src/index.ts')
function allocate(kind, explicitClose) {
  for (let i = 0; i < 100; i++) {
    const root = storage.openPrivateDirectory('C:\\private', { create: false })
    if (kind === 'lease') {
      const lease = storage.acquirePrivateWriterLease(root, `writer-${i}.lock`)
      if (explicitClose) lease.release()
    }
    if (explicitClose) root.close()
  }
}
const kind = process.argv[2]
assert.ok(kind === 'directory' || kind === 'lease')
allocate(kind, true)
assert.equal(native.handles.size, 0, 'Explicit close must release every owned handle')
allocate(kind, false)
assert.ok(native.handles.size >= 200)
const mutations = native.events.filter(event => event === 'rename' || event === 'remove').length
const deadline = performance.now() + 15_000
while (native.handles.size && performance.now() < deadline) {
  globalThis.gc()
  await setImmediate()
}
assert.equal(native.handles.size, 0, 'Dropped capabilities must not be retained by finalizer holdings')
assert.equal(native.events.filter(event => event === 'rename' || event === 'remove').length, mutations, 'Finalizers must never mutate the namespace')
hook.deregister()
delete globalThis[symbol]
console.log(JSON.stringify({ kind, handles: native.handles.size, explicitClose: true, collected: true }))
