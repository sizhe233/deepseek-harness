/** Synthetic subprocesses for portable teardown tests; no native conformance assertions. */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, directory] = process.argv.slice(2)
if (mode === 'ignore-close') {
  console.log(JSON.stringify({ ready: true }))
  setInterval(() => {}, 1000)
} else if (mode === 'overflow-stdout' || mode === 'overflow-stderr') {
  const output = mode === 'overflow-stdout' ? process.stdout : process.stderr
  output.write(Buffer.alloc(16 * 1024, 120))
  setInterval(() => {}, 1000)
} else if (mode === 'inherit-streams' || mode === 'inherit-overflow') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hold-streams', directory], {
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  })
  child.once('error', error => { console.error(error.message); process.exit(1) })
  child.once('spawn', () => {
    child.unref()
    const output = mode === 'inherit-overflow' ? Buffer.alloc(16 * 1024, 120)
      : `${JSON.stringify({ ready: true, descendantPid: child.pid })}\n`
    process.stdout.write(output, () => process.exit(0))
  })
} else if (mode === 'hold-streams') {
  const deadline = setTimeout(() => {
    writeFileSync(join(directory, 'descendant-timeout'), 'test owner did not release streams')
    process.exit(2)
  }, 5000)
  const timer = setInterval(() => {
    if (!existsSync(join(directory, 'release'))) return
    clearInterval(timer); clearTimeout(deadline)
    writeFileSync(join(directory, 'descendant-settled'), 'released')
    process.exit(0)
  }, 10)
} else throw new Error(`Unknown fixture mode ${mode}`)
