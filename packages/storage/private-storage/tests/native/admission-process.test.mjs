/** Real portable subprocess tests; these results never count as Windows-native acceptance. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startAdmissionProcess } from './admission-process.mjs'

const fixture = fileURLToPath(new URL('admission-protocol-fixture.mjs', import.meta.url))
async function releaseDescendant(directory) {
  writeFileSync(join(directory, 'release'), 'release')
  const deadline = Date.now() + 5000
  while (!existsSync(join(directory, 'descendant-settled')) && Date.now() < deadline) await delay(10)
  assert.equal(existsSync(join(directory, 'descendant-settled')), true, 'Owned descendant did not acknowledge release')
  assert.equal(existsSync(join(directory, 'descendant-timeout')), false)
}

test('process exit waits for inherited pipes without killing the exited process', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-pipe-exit-'))
  let uncertainties = 0
  const child = startAdmissionProcess(process.execPath, [fixture, 'inherit-streams', directory], {
    gracefulTimeoutMs: 2000, forcedTimeoutMs: 1000, onUncertain: () => { uncertainties++ },
  })
  try {
    assert.equal((await child.next()).ready, true)
    assert.deepEqual(await child.processExit, { code: 0, signal: null })
    assert.equal(child.observation().streamClosed, false, 'Descendant must actually retain the pipes')
    await releaseDescendant(directory)
    await child.close()
    assert.equal(child.observation().processExited, true)
    assert.equal(child.observation().streamClosed, true)
    assert.equal(child.observation().uncertain, false)
    assert.equal(child.observation().killRequested, false)
    assert.equal(child.observation().protocolFailure, null)
    assert.equal(uncertainties, 0)
  } finally {
    await releaseDescendant(directory)
    await child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} overflow fails before parsing and terminates the owned fixture`, { timeout: 10_000 }, async () => {
    const observations = []
    const child = startAdmissionProcess(process.execPath, [fixture, `overflow-${stream}`], {
      maxOutputBytes: 4096, forcedTimeoutMs: 2000, onUncertain: observation => observations.push(observation),
    })
    try {
      await assert.rejects(child.next(), new RegExp(`${stream} byte limit exceeded`))
      await assert.rejects(child.close(), new RegExp(`${stream} byte limit exceeded`))
      await child.processExit
      assert.equal(child.observation().killRequested, true)
      assert.equal(child.observation().processExited, true)
      assert.equal(child.observation().streamClosed, true)
      assert.ok(child.observation()[`${stream}Bytes`] > 4096)
      assert.match(child.observation().protocolFailure, new RegExp(`${stream} byte limit exceeded`))
      assert.equal(child.observation().uncertain, false)
      assert.deepEqual(observations, [])
    } finally { await child.kill() }
  })
}

test('stdout overflow retains uncertainty when a descendant holds the pipes', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-overflow-deadline-'))
  const observations = []
  const child = startAdmissionProcess(process.execPath, [fixture, 'inherit-overflow', directory], {
    maxOutputBytes: 4096, forcedTimeoutMs: 60, onUncertain: observation => observations.push(observation),
  })
  try {
    await assert.rejects(child.next(), /stdout byte limit exceeded/)
    await assert.rejects(child.close(), /stdout byte limit exceeded.*forced-close deadline/)
    assert.equal(observations.length, 1)
    assert.equal(observations[0].uncertain, true)
    assert.equal(observations[0].streamClosed, false)
    assert.match(observations[0].protocolFailure, /stdout byte limit exceeded/)
    await releaseDescendant(directory)
    assert.equal(child.observation().uncertain, true)
  } finally {
    await releaseDescendant(directory)
    await child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('graceful deadline forces a still-running fixture and reports failure', { timeout: 10_000 }, async () => {
  let uncertainties = 0
  const child = startAdmissionProcess(process.execPath, [fixture, 'ignore-close'], {
    gracefulTimeoutMs: 40, forcedTimeoutMs: 2000, onUncertain: () => { uncertainties++ },
  })
  try {
    assert.equal((await child.next()).ready, true)
    await assert.rejects(child.close(), /graceful-exit deadline.*forced teardown/)
    const exit = await child.processExit
    assert.ok(exit.code !== 0 || exit.signal !== null)
    assert.equal(child.observation().killRequested, true)
    assert.equal(child.observation().processExited, true)
    assert.equal(child.observation().streamClosed, true)
    assert.equal(child.observation().uncertain, false)
    assert.equal(uncertainties, 0)
  } finally { await child.kill() }
})

test('forced stream-close deadline retains cleanup uncertainty after process exit', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-pipe-deadline-'))
  const observations = []
  const child = startAdmissionProcess(process.execPath, [fixture, 'inherit-streams', directory], {
    gracefulTimeoutMs: 40, forcedTimeoutMs: 40, onUncertain: value => observations.push(value),
  })
  try {
    assert.equal((await child.next()).ready, true)
    assert.deepEqual(await child.processExit, { code: 0, signal: null })
    assert.equal(child.observation().streamClosed, false)
    await assert.rejects(child.close(), /forced-close deadline/)
    assert.equal(observations.length, 1)
    assert.equal(observations[0].processExited, true)
    assert.equal(observations[0].streamClosed, false)
    assert.equal(observations[0].uncertain, true)
    assert.equal(observations[0].killRequested, false, 'An exited process must not be signaled again')
    await releaseDescendant(directory)
    assert.equal(child.observation().uncertain, true, 'Later stream disposal cannot erase cleanup uncertainty')
  } finally {
    await releaseDescendant(directory)
    await child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
})
