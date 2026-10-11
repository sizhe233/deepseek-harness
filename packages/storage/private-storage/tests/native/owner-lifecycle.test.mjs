/** Run with: node owner-lifecycle.test.mjs <absolute Windows windows-private-owner.node path>. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

const native = process.platform === 'win32' && process.arch === 'x64'
const addonPath = process.argv[2]
const workerUrl = new URL('owner-lifecycle-worker.mjs', import.meta.url)

function start(rootPath, mode) {
  const worker = new Worker(workerUrl, { workerData: { addonPath, rootPath, mode } })
  const messages = []
  let failure
  let waiting
  let exited = false
  worker.on('message', message => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(message) }
    else messages.push(message)
  })
  worker.on('error', error => { failure = error; if (waiting) { waiting(undefined); waiting = undefined } })
  worker.on('exit', () => { exited = true; if (waiting) { waiting(undefined); waiting = undefined } })
  const exit = once(worker, 'exit')
  // Own rejection immediately; next()/finished() still report the original worker failure.
  exit.catch(() => {})
  return {
    worker,
    async next() {
      if (failure) throw failure
      assert.ok(!exited || messages.length, 'Native owner worker exited before its required report')
      const message = messages.length ? messages.shift() : await new Promise(resolve => { waiting = resolve })
      if (failure) throw failure
      assert.ok(message, 'Native owner worker must deliver its readiness or result')
      return message
    },
    async finished(expected = 0) {
      const [code] = await exit
      if (failure) throw failure
      assert.equal(code, expected)
    },
    async terminate() { await worker.terminate(); await exit },
  }
}

test('native owner closes live directory and lease on explicit close and Worker.terminate',
  { skip: !native && 'Requires actual Windows x64 and built Node-API owner', timeout: 120_000 }, async () => {
    assert.ok(addonPath && isAbsolute(addonPath), 'Supply the actual built Windows windows-private-owner.node as argv[2]')
    const { createOwner } = createRequire(import.meta.url)(addonPath)
    const observer = createOwner()
    const baseline = observer.statistics()
    assert.deepEqual({ ...baseline, heapBlocks: 0 }, {
      owners: 1, fileRecords: 0, openProcesses: 0, openFiles: 0, openTokens: 0, localAllocBlocks: 0, heapBlocks: 0, pendingContexts: 0, unconfirmedReleases: 0,
    })
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-native-owner-'))
    const workers = new Set()
    const owned = (path, mode) => { const worker = start(path, mode); workers.add(worker); return worker }
    try {
      for (const mode of ['normal-close', 'abrupt-termination']) {
        const rootPath = join(temporary, mode)
        mkdirSync(rootPath)
        writeFileSync(join(rootPath, 'owner.lock'), '')
        const live = owned(rootPath, 'hold')
        const ready = await live.next()
        assert.equal(ready.event, 'ready')
        assert.equal(observer.statistics().openFiles, 2)
        const blocked = owned(rootPath, 'probe')
        const collision = await blocked.next()
        assert.equal(collision.event, 'probe')
        assert.equal(collision.acquired, false, 'A live Worker must hold an actual kernel byte-range lease')
        assert.equal(collision.refusal.code, 'busy')
        assert.equal(collision.refusal.win32Code, 33)
        await blocked.finished()
        workers.delete(blocked)
        const relocated = `${rootPath}-relocated`
        assert.throws(() => renameSync(rootPath, relocated), 'Live native directory ownership must prevent root relocation')
        if (mode === 'normal-close') {
          live.worker.postMessage('close')
          assert.equal((await live.next()).event, 'closed')
          assert.equal(observer.statistics().openFiles, 0)
          live.worker.postMessage('exit')
          await live.finished()
        } else {
          assert.equal(await live.worker.terminate(), 1)
          await live.finished(1)
        }
        workers.delete(live)
        assert.deepEqual(observer.statistics(), baseline, 'Worker exit must retire all native resources and metadata')
        const recovered = owned(rootPath, 'probe')
        const reacquired = await recovered.next()
        assert.equal(reacquired.acquired, true, 'The real lease must be immediately available after Worker exit')
        assert.equal(reacquired.directoryIdentity, ready.directoryIdentity)
        assert.equal(reacquired.leaseIdentity, ready.leaseIdentity)
        await recovered.finished()
        workers.delete(recovered)
        assert.deepEqual(observer.statistics(), baseline)
        renameSync(rootPath, relocated)
        renameSync(relocated, rootPath)
      }
      const limitPath = join(temporary, 'resource-limits')
      mkdirSync(limitPath); writeFileSync(join(limitPath, 'owner.lock'), '')
      const limited = owned(limitPath, 'resource-limits')
      const limitResult = await limited.next()
      assert.equal(limitResult.event, 'resource-limits')
      assert.equal(limitResult.sequential, 16384 + 32)
      assert.equal(limitResult.simultaneousLimit, 16384)
      await limited.finished(); workers.delete(limited)
      assert.deepEqual(observer.statistics(), baseline, 'Closed stale capabilities must not consume live admission budget')
      const partialPath = join(temporary, 'partial-rollback')
      mkdirSync(partialPath)
      const partial = owned(partialPath, 'rollback')
      const result = await partial.next()
      assert.equal(result.event, 'rollback')
      assert.equal(result.repetitions, 128)
      await partial.finished()
      workers.delete(partial)
      assert.deepEqual(observer.statistics(), baseline, 'Partial acquisitions must leave no native resources after Worker exit')
    } finally {
      await Promise.all([...workers].map(worker => worker.terminate()))
      rmSync(temporary, { recursive: true, force: true })
    }
  })
