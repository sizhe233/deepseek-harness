/** Actual packed process-birth observations; the independent control owns only its explicitly spawned child. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { fixtureEnvironment, startChild } from './boundary-support.mjs'
import { ownerBinding } from './owner-observer.mjs'

const entry = process.argv[2]
test('packed process observations bind running and confirmed exited states to exact kernel birth', {
  skip: process.platform !== 'win32' || process.arch !== 'x64' ? 'Requires the actual Windows x64 packed provider' : false,
  timeout: 30_000,
}, async () => {
  assert.ok(entry && isAbsolute(entry))
  const binding = ownerBinding(entry)
  const storage = await import(pathToFileURL(entry).href)
  assert.equal(storage.capabilities().available, true)
  const k = createRequire(entry)('koffi')
  assert.equal(k.version, '3.1.1')
  const kernel = k.load('kernel32.dll')
  const open = kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32'])
  const current = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
  const birth = handle => {
    const created = Buffer.alloc(8)
    assert.notEqual(times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)), 0)
    return created.readBigUInt64LE().toString()
  }
  const self = storage.observeProcessBirth(process.pid)
  assert.equal(self.creationTime100ns, birth(current()))
  assert.equal(self.state, 'running'); assert.equal(self.observationOnly, true)
  const temporary = mkdtempSync(join(tmpdir(), 'owner-process-birth-'))
  const child = startChild(process.execPath, ['-e', "console.log(JSON.stringify({event:'ready',pid:process.pid}));process.stdin.once('data',()=>process.exit(0))"],
    fixtureEnvironment(temporary, temporary))
  let retained = null
  let primary
  try {
    const ready = await child.next(10_000)
    assert.equal(ready.event, 'ready'); assert.equal(ready.pid, child.child.pid)
    retained = open(0x101000, 0, ready.pid)
    assert.ok(retained !== null && retained !== 0n && retained !== 0xffffffffffffffffn)
    const expected = birth(retained), live = storage.observeProcessBirth(ready.pid)
    assert.equal(live.creationTime100ns, expected); assert.equal(live.state, 'running')
    assert.equal(wait(retained, 0), 258)
    child.resume(); await child.complete()
    assert.equal(wait(retained, 0), 0, 'The independently retained child process object must be signaled')
    const exited = storage.observeProcessBirth(ready.pid)
    assert.equal(exited.pid, ready.pid); assert.equal(exited.creationTime100ns, expected); assert.equal(exited.state, 'exited')
    assert.equal(exited.mechanism, 'GetProcessTimes+WaitForSingleObject')
    assert.deepEqual(ownerBinding(entry), binding)
  } catch (error) { primary = error; throw error }
  finally {
    const failures = []
    if (retained !== null) {
      const closing = retained; retained = null
      try { assert.notEqual(close(closing), 0) } catch (error) { failures.push(error) }
    }
    try { await child.kill() } catch (error) { failures.push(error) }
    if (child.settled) {
      try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], 'Owned process fixture cleanup failed')
  }
})
