/** Real portable process checks for the collector; these do not establish Windows native acceptance. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeMatrixEnvironment, runNativeMatrixProcess } from './private-storage-matrix-process.mjs'
import { collectNativeMatrices } from './private-storage-composite.mjs'

function fixture(t, source, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'storage-matrix-process-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = join(root, 'fixture.mjs'), reportPath = join(root, 'report.json'), logPath = join(root, 'output.log')
  writeFileSync(script, source)
  const config = { cwd: root, env: process.env, reportPath, logPath, timeoutMs: 5000, ...options }
  return { config, invoke: () => runNativeMatrixProcess(process.execPath, [script, reportPath], config) }
}

test('retains exact report bytes, blocked exit and ordinary pipe closure', async t => {
  const f = fixture(t, `import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'{"status":"blocked"}\\n');console.log('observed');process.exitCode=2`)
  const observed = await f.invoke()
  assert.equal(observed.exitCode, 2); assert.equal(observed.signal, null); assert.equal(observed.timedOut, false)
  assert.equal(observed.processExited, true); assert.equal(observed.streamClosed, true); assert.equal(observed.error, undefined)
  assert.equal(observed.rawReport, '{"status":"blocked"}\n')
  assert.match(readFileSync(f.config.logPath, 'utf8'), /stdout: observed/)
})

test('reports a missing report even when the matrix process exits zero', async t => {
  const observed = await fixture(t, '').invoke()
  assert.equal(observed.exitCode, 0); assert.equal(observed.rawReport, null)
  assert.match(observed.error, /report unavailable/)
})

test('refuses stale outputs before launching any process', async t => {
  for (const path of ['reportPath', 'logPath']) {
    const f = fixture(t, "throw Error('must not launch')")
    writeFileSync(f.config[path], 'stale')
    await assert.rejects(f.invoke(), /stale/)
  }
})

test('timeouts remain failed with actual process exit and uncertainty about descendants', async t => {
  const observed = await fixture(t, 'setInterval(()=>{},1000)', { timeoutMs: 100 }).invoke()
  assert.equal(observed.timedOut, true); assert.equal(observed.processExited, true)
  assert.equal(observed.descendantsAfterInterruption, 'unknown'); assert.equal(observed.rawReport, null)
  assert.match(observed.error, /deadline/)
})

test('oversized stdout is bounded, fails, and terminates the actual owned process', async t => {
  const observed = await fixture(t, "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)", { maxOutputBytes: 1024 }).invoke()
  assert.equal(observed.outputTruncated, true); assert.equal(observed.processExited, true)
  assert.match(observed.error, /output exceeded/)
  assert.ok(readFileSync(observed.logPath).length <= 1041)
})

test('non-UTF8 reports cannot be credited', async t => {
  const observed = await fixture(t, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],Buffer.from([0xff]))").invoke()
  assert.equal(observed.rawReport, null)
  assert.match(observed.error, /UTF-8/)
})

test('launch failure is retained and does not prevent a later independent matrix', async t => {
  const first = fixture(t, ''), next = fixture(t, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'{}')")
  const runs = await collectNativeMatrices([{ id: 'missing' }, { id: 'next' }], spec => spec.id === 'missing'
    ? runNativeMatrixProcess(join(first.config.cwd, 'absent-program'), [], first.config) : next.invoke())
  assert.match(runs[0].error, /process error/); assert.equal(runs[1].exitCode, 0); assert.equal(runs[1].rawReport, '{}')
})

test('credential values and module overrides are never inherited', () => {
  assert.deepEqual(nativeMatrixEnvironment({ ACCESS_TOKEN: 'secret', Password: 'secret', NODE_PATH: '/elsewhere', NODE_OPTIONS: '--import bad', NODE_TEST_CONTEXT: 'child', CANDIDATE_SHA: 'a', PATH: 'b' }),
    { CANDIDATE_SHA: 'a', PATH: 'b' })
})

test('a symbolic-link report is rejected before content admission', async t => {
  const observed = await fixture(t, "import{mkdirSync,writeFileSync,symlinkSync}from'node:fs';import{resolve}from'node:path';if(process.platform==='win32'){mkdirSync('target');symlinkSync(resolve('target'),process.argv[2],'junction')}else{writeFileSync('target','{}');symlinkSync('target',process.argv[2])}").invoke()
  assert.equal(observed.rawReport, null); assert.match(observed.error, /regular file/)
})

async function releasePipeHolder(directory) {
  writeFileSync(join(directory, 'release'), 'release')
  const pid = Number(readFileSync(join(directory, 'holder.pid'), 'utf8'))
  const deadline = Date.now() + 5000
  let stopped = false
  while (!stopped && Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux') stopped = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')
    } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') stopped = true; else throw error }
    if (!stopped) await delay(10)
  }
  assert.equal(stopped, true, 'Owned inherited-pipe fixture did not stop')
  assert.equal(existsSync(join(directory, 'released')), true)
}

test('an exited parent with inherited pipes cannot defeat the separate closure deadline', async t => {
  const holderSource = `const{existsSync,writeFileSync}=require('node:fs');const timer=setInterval(()=>{if(existsSync('release')){clearInterval(timer);writeFileSync('released','yes')}},10)`
  const f = fixture(t, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
const holder=spawn(process.execPath,['-e',${JSON.stringify(holderSource)}],{stdio:['ignore',process.stdout,process.stderr]});
writeFileSync('holder.pid',String(holder.pid));writeFileSync(process.argv[2],'{}');holder.unref();`, { closeTimeoutMs: 100 })
  try {
    const observed = await f.invoke()
    assert.equal(observed.exitCode, 0); assert.equal(observed.processExited, true)
    assert.equal(observed.streamClosed, false); assert.equal(observed.rawReport, null)
    assert.equal(observed.descendantsAfterInterruption, 'unknown'); assert.match(observed.error, /closure/)
  } finally {
    await releasePipeHolder(f.config.cwd)
  }
})

test('a deterministic name replacement between lstat and descriptor admission is rejected', async t => {
  const helper = new URL('./private-storage-matrix-process.mjs', import.meta.url).href
  const source = `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
const report=process.cwd()+'/inner.json';const original=fs.lstatSync;let swapped=false;
fs.lstatSync=(path,...args)=>{const value=original(path,...args);if(path===report&&!swapped){swapped=true;fs.renameSync(report,report+'.old');fs.writeFileSync(report,'alternate')}return value};syncBuiltinESMExports();
const{runNativeMatrixProcess}=await import(${JSON.stringify(helper)});
const result=await runNativeMatrixProcess(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'original')",report],{cwd:process.cwd(),env:process.env,reportPath:report,logPath:report+'.log',timeoutMs:5000});
fs.writeFileSync(process.argv[2],JSON.stringify({swapped,result}));`
  const observed = await fixture(t, source).invoke()
  assert.equal(observed.error, undefined)
  const { swapped, result } = JSON.parse(observed.rawReport)
  assert.equal(swapped, true); assert.equal(result.rawReport, null); assert.match(result.error, /report unavailable/)
})

test('raw output and stored framing have separate explicit bounds', async t => {
  const observed = await fixture(t, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'{}');process.stdout.write('x')", { maxOutputBytes: 1 }).invoke()
  assert.equal(observed.outputBytes, 1); assert.equal(observed.outputTruncated, false)
  assert.equal(observed.storedLogBytes, 18); assert.equal(observed.storedLogByteLimit, 18)
})
