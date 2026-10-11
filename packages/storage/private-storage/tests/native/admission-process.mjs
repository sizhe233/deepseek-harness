/** Test-owned JSON-line process protocol with separate exit and stream-close deadlines. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

/**
 * Start an owned fixture; uncertainty callbacks tell the caller to retain filesystem fixtures.
 * @param command - Test executable.
 * @param args - Literal argument array.
 * @param options - Environment, bounded protocol deadlines, and lifecycle notifications.
 * @returns Line reader and bounded graceful/forced teardown operations.
 */
export function startAdmissionProcess(command, args, {
  env, gracefulTimeoutMs = 30_000, forcedTimeoutMs = 5_000, lineTimeoutMs = 30_000, maxOutputBytes = 64 * 1024,
  onUncertain = () => {}, onClosed = () => {},
} = {}) {
  assert.ok(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 1024 * 1024)
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', ended = false, processExited = false, uncertain = false, killRequested = false
  let stdoutBytes = 0, stderrBytes = 0, protocolError, failureCleanup, cleanupError, killing
  const queue = [], waiters = []
  const protocol = new PassThrough()
  const lines = createInterface({ input: protocol })
  function protocolFailed(stream) {
    if (protocolError) return
    protocolError = new Error(`Fixture ${stream} byte limit exceeded (${maxOutputBytes})`)
    queue.length = 0
    for (const waiter of waiters.splice(0)) waiter.reject(protocolError)
    /* Continue draining discarded chunks so our own pause cannot prevent pipe closure. */
    lines.close(); protocol.destroy()
    failureCleanup = kill().catch(error => { cleanupError = error })
  }
  child.stdout.on('data', bytes => {
    if (protocolError) return
    stdoutBytes += bytes.length
    if (stdoutBytes > maxOutputBytes) { protocolFailed('stdout'); return }
    protocol.write(bytes)
  })
  child.stdout.on('end', () => { if (!protocol.destroyed) protocol.end() })
  child.stderr.on('data', bytes => {
    if (protocolError) return
    stderrBytes += bytes.length
    if (stderrBytes > maxOutputBytes) { protocolFailed('stderr'); return }
    stderr = (stderr + bytes.toString()).slice(-8192)
  })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') stderr = (stderr + error.message).slice(-8192) })
  lines.on('line', line => {
    if (protocolError) return
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(line)
    else queue.push(line)
  })
  const processExit = new Promise(resolveExit => {
    child.once('exit', (code, signal) => { processExited = true; resolveExit({ code, signal }) })
    child.once('error', error => resolveExit({ error: error.message }))
  })
  const closed = new Promise(resolveClose => {
    child.once('error', error => { for (const waiter of waiters.splice(0)) waiter.reject(error) })
    child.once('close', (code, signal) => {
      ended = true; lines.close(); protocol.destroy(); onClosed()
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Fixture exited ${code}/${signal}: ${stderr}`))
      resolveClose({ code, signal })
    })
  })
  async function boundedClose(milliseconds) {
    let timer
    try {
      return await Promise.race([closed, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds) })])
    } finally { clearTimeout(timer) }
  }
  function observation() {
    return { pid: child.pid, processExited, streamClosed: ended, uncertain, killRequested,
      stdoutBytes, stderrBytes, protocolFailure: protocolError?.message ?? null }
  }
  function kill() {
    if (killing) return killing
    killing = (async () => {
      let signalError
      if (!ended && !processExited && !killRequested) {
        killRequested = true
        try { child.kill('SIGKILL') } catch (error) { signalError = error }
      }
      const exit = await boundedClose(forcedTimeoutMs)
      if (!exit) {
        if (!uncertain) { uncertain = true; onUncertain(observation()) }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); lines.close(); protocol.destroy(); child.unref()
        throw new Error(`Fixture exceeded forced-close deadline; pid=${child.pid}, processExitObserved=${processExited}${signalError ? `, signalError=${signalError.message}` : ''}`)
      }
      return exit
    })()
    const pending = killing
    void pending.then(() => { if (killing === pending) killing = undefined }, () => { if (killing === pending) killing = undefined })
    return pending
  }
  async function checkProtocol() {
    if (!protocolError) return
    await failureCleanup
    if (cleanupError) throw new AggregateError([protocolError, cleanupError], `${protocolError.message}; ${cleanupError.message}`)
    throw protocolError
  }
  return {
    processExit,
    observation,
    async next() {
      await checkProtocol()
      let line = queue.shift()
      if (line === undefined) {
        assert.equal(ended, false, `Fixture exited before response: ${stderr}`)
        line = await new Promise((resolveLine, rejectLine) => {
          const waiter = {
            resolve(value) { clearTimeout(timer); resolveLine(value) },
            reject(error) { clearTimeout(timer); rejectLine(error) },
          }
          const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            rejectLine(new Error('Fixture handshake timed out'))
          }, lineTimeoutMs)
          waiters.push(waiter)
        })
      }
      await checkProtocol()
      return JSON.parse(line)
    },
    async close() {
      await checkProtocol()
      if (!ended && !processExited) child.stdin.end('close\n')
      const exit = await boundedClose(gracefulTimeoutMs)
      if (!exit) { await kill(); throw new Error('Fixture exceeded graceful-exit deadline and required forced teardown') }
      await checkProtocol()
      assert.equal(exit.code, 0, `Fixture teardown failed: ${stderr}`)
      assert.equal(exit.signal, null)
    },
    kill,
  }
}
