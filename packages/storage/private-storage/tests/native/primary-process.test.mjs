/** Portable actual-factory protocol regressions; no Windows-native acceptance claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startPrimaryProcess } from './primary-process.mjs'

const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|NODE_OPTIONS|NODE_PATH)/iu.test(name)))

test('primary reader keeps read and close lines while using bounded teardown', async () => {
  const script = "const r=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({ready:true}));r.on('line',line=>{if(line==='read')console.log(JSON.stringify({read:true}));else if(line==='close'){r.close();process.exit(0)}})"
  const child = startPrimaryProcess(process.execPath, ['-e', script], environment)
  try {
    assert.deepEqual(await child.next(), { ready: true })
    child.child.stdin.write('read\n')
    assert.deepEqual(await child.next(), { read: true })
    await child.close(); assert.equal(child.settled, true)
    await child.kill(); await child.kill()
  } finally { await child.kill() }
})

test('primary one-shot completion does not write after observed process exit', async () => {
  const child = startPrimaryProcess(process.execPath, ['-e', "console.log(JSON.stringify({ready:true}))"], environment)
  try {
    assert.deepEqual(await child.next(120_000), { ready: true })
    assert.deepEqual(await child.processExit, { code: 0, signal: null })
    await child.close(); assert.equal(child.settled, true)
  } finally { await child.kill() }
})

test('primary forced termination failure remains uncertain instead of enabling recursive cleanup', async () => {
  let uncertain = false
  const child = startPrimaryProcess(process.execPath, ['-e', "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)"], environment,
    { closeTimeoutMs: 30, onUncertain: () => { uncertain = true } })
  const original = child.child.kill.bind(child.child)
  try {
    assert.deepEqual(await child.next(), { ready: true })
    child.child.kill = () => false
    await assert.rejects(child.kill(), /teardown budget/)
    assert.equal(uncertain, true); assert.equal(child.settled, false)
  } finally {
    child.child.kill = original
    original('SIGKILL')
    let timer
    try { await Promise.race([child.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture did not stop')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  assert.equal(child.settled, true); assert.equal(uncertain, true)
})

test('primary nonzero execution rejects close after settled teardown without inventing uncertainty', async () => {
  let uncertain = false
  const child = startPrimaryProcess(process.execPath, ['-e', "console.log(JSON.stringify({ready:true}));process.exitCode=7"], environment,
    { onUncertain: () => { uncertain = true } })
  try {
    assert.deepEqual(await child.next(), { ready: true })
    await child.processExit
    await assert.rejects(child.close())
    assert.equal(child.settled, true); assert.equal(uncertain, false)
  } finally { await child.kill() }
})

async function releaseHolder(directory, pid) {
  writeFileSync(join(directory, 'release'), 'release')
  const deadline = Date.now() + 5000
  let stopped = false
  while (!stopped && Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux') stopped = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')
    } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') stopped = true; else throw error }
    if (!stopped) await delay(10)
  }
  assert.equal(stopped, true, 'Owned stream holder must stop before fixture cleanup')
  assert.equal(existsSync(join(directory, 'descendant-settled')), true)
  assert.equal(existsSync(join(directory, 'descendant-timeout')), false)
}

test('primary inherited-pipe timeout keeps uncertainty sticky after observed holder termination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'primary-pipe-teardown-'))
  const fixture = fileURLToPath(new URL('admission-protocol-fixture.mjs', import.meta.url))
  let uncertain = false, pid
  const child = startPrimaryProcess(process.execPath, [fixture, 'inherit-streams', directory], environment,
    { closeTimeoutMs: 30, onUncertain: () => { uncertain = true } })
  try {
    const ready = await child.next(); pid = ready.descendantPid
    assert.equal(ready.ready, true); assert.ok(Number.isSafeInteger(pid) && pid > 0)
    assert.deepEqual(await child.processExit, { code: 0, signal: null })
    await assert.rejects(child.close(), /teardown budget|forced termination/)
    assert.equal(uncertain, true)
  } finally {
    if (pid) await releaseHolder(directory, pid)
    await child.kill()
    assert.ok(pid, 'Unknown descendant identity withholds fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(uncertain, true); assert.equal(child.settled, true)
})
