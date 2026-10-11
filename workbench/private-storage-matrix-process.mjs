/** Bounded test-only process collector. Exit, pipe closure and report bytes remain distinct observations. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs'

/** Remove ambient credentials and executable module overrides from native fixture environments. */
export function nativeMatrixEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)
    && !['NODE_PATH', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(name.toUpperCase())))
}

/** Collect one owned matrix without turning failed or blocked exits into successful execution. */
export async function runNativeMatrixProcess(command, args, {
  cwd, env, reportPath, logPath, timeoutMs, closeTimeoutMs = 5000, maxOutputBytes = 8 * 1024 * 1024,
}) {
  for (const value of [timeoutMs, closeTimeoutMs, maxOutputBytes]) assert.ok(Number.isSafeInteger(value) && value > 0)
  assert.ok(maxOutputBytes <= 16 * 1024 * 1024 && closeTimeoutMs <= 30_000)
  assert.equal(existsSync(reportPath), false, 'A matrix cannot reuse a stale report')
  assert.equal(existsSync(logPath), false, 'A matrix cannot reuse a stale log')
  assert.notEqual(reportPath, logPath)
  let child
  let timeout, closeDeadline, finished = false, timedOut = false, processExited = false, streamClosed = false
  let exitCode = null, signal = null, outputBytes = 0, outputTruncated = false, failure
  const chunks = { stdout: [], stderr: [] }
  const outcome = await new Promise(resolveOutcome => {
    const finish = () => {
      if (finished) return
      finished = true; clearTimeout(timeout); clearTimeout(closeDeadline)
      resolveOutcome({ exitCode, signal, timedOut, processExited, streamClosed,
        outputBytes, outputTruncated, ...(failure === undefined ? {} : { error: failure }) })
    }
    const boundClosure = () => {
      if (closeDeadline || finished) return
      closeDeadline = setTimeout(() => {
        failure ??= 'Owned matrix did not reach pipe closure within its bounded teardown interval'
        child.stdout.destroy(); child.stderr.destroy(); child.unref()
        finish()
      }, closeTimeoutMs)
    }
    const stop = () => {
      if (!processExited && child.pid !== undefined) {
        try { child.kill('SIGKILL') } catch (error) { failure ??= `Owned matrix termination failed: ${error.message}` }
      }
      boundClosure()
    }
    const append = (kind, bytes) => {
      outputBytes += bytes.length
      if (outputBytes > maxOutputBytes) {
        outputTruncated = true; failure ??= 'Matrix output exceeded its declared byte bound'; stop(); return
      }
      chunks[kind].push(bytes)
    }
    child = spawn(command, args, { cwd, env: nativeMatrixEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => append('stdout', bytes))
    child.stderr.on('data', bytes => append('stderr', bytes))
    child.once('error', error => { failure ??= `Matrix process error: ${error.message}`; boundClosure() })
    child.once('exit', (code, stoppedBy) => {
      processExited = true; exitCode = code; signal = stoppedBy; boundClosure()
    })
    child.once('close', (code, stoppedBy) => {
      streamClosed = true; exitCode = code; signal = stoppedBy; finish()
    })
    timeout = setTimeout(() => { timedOut = true; failure ??= 'Matrix execution deadline exceeded'; stop() }, timeoutMs)
  })
  let rawReport = null, descriptor
  try {
    assert.equal(outcome.timedOut, false, 'Interrupted matrix report is retained without opening')
    assert.equal(outcome.streamClosed, true, 'Unsettled matrix report is retained without opening')
    assert.equal(outcome.outputTruncated, false, 'Overflowed matrix report is retained without opening')
    const named = lstatSync(reportPath, { bigint: true })
    assert.ok(named.isFile() && !named.isSymbolicLink(), 'Matrix report must be a regular file')
    // Windows does not expose these POSIX flags. Its report path is in the trusted, owned CI fixture directory.
    descriptor = openSync(reportPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(descriptor, { bigint: true })
    assert.ok(before.isFile(), 'Opened matrix report must be a regular file')
    assert.equal(before.dev, named.dev); assert.equal(before.ino, named.ino)
    assert.ok(before.size > 0n && before.size <= 8n * 1024n * 1024n, 'Matrix report exceeds its byte bound')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let count = 0
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, count)
      if (read === 0) break
      count += read
    }
    const after = fstatSync(descriptor, { bigint: true })
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], 'Matrix report changed during the bounded read')
    assert.equal(BigInt(count), before.size, 'Matrix report length changed during the bounded read')
    const raw = bytes.subarray(0, count), text = raw.toString('utf8')
    assert.equal(Buffer.from(text, 'utf8').compare(raw), 0, 'Matrix report must contain exact UTF-8 bytes')
    rawReport = text
  } catch (error) { outcome.error ??= `Matrix report unavailable: ${error.message}` }
  finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch (error) { outcome.error ??= `Matrix report descriptor close failed: ${error.message}` }
    }
  }
  const storedLog = Buffer.concat([Buffer.from('stdout: '), ...chunks.stdout, Buffer.from('\nstderr: '), ...chunks.stderr])
  writeFileSync(logPath, storedLog, { flag: 'wx', mode: 0o600 })
  return { ...outcome, rawReport, logPath, reportPath, storedLogBytes: storedLog.length, storedLogByteLimit: maxOutputBytes + 17,
    // Forced parent termination cannot establish the state of every descendant or justify recursive cleanup.
    descendantsAfterInterruption: timedOut || !streamClosed ? 'unknown' : 'not-independently-observed' }
}
