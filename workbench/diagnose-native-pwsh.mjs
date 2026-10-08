import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Read-only diagnostic of the candidate's pwsh prompt; required acceptance runs separately.
const root = process.cwd()
const pty = createRequire(join(root, 'packages/subprocess/subprocess-local/package.json'))('node-pty')
const { Terminal } = createRequire(join(root, 'packages/terminal/terminal-bash/package.json'))('@xterm/headless')
const promptSource = readFileSync(join(root, 'packages/terminal/terminal-bash/src/index.ts'), 'utf8')
const promptParts = promptSource.match(/export const PWSH_PROMPT_SETUP =\s*("(?:[^"\\]|\\.)*") \+ CONTROLLED_PROMPT \+ ("(?:[^"\\]|\\.)*")/)
const prompt = readFileSync(join(root, 'packages/terminal/terminal-bash/src/sanitize.ts'), 'utf8')
  .match(/export const CONTROLLED_PROMPT = '([^']*)'/)?.[1]
const encoding = readFileSync(join(root, 'packages/shell/pwsh-local/src/index.ts'), 'utf8')
  .match(/export const ENCODING_PREAMBLE =\s*'([^']*)'/)?.[1]
if (!promptParts || !prompt || !encoding) throw new Error('Unrecognized candidate pwsh bootstrap source')
const setup = encoding + JSON.parse(promptParts[1]) + prompt + JSON.parse(promptParts[2])
const monitorScript = `import os,sys,time,termios,json
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOCTTY)
last=None
print(json.dumps({'ready':True,'at':str(time.monotonic_ns())}),flush=True)
while True:
 try:
  a=termios.tcgetattr(fd)
  mode={'canonical':bool(a[3]&termios.ICANON),'icrnl':bool(a[0]&termios.ICRNL),'igncr':bool(a[0]&termios.IGNCR),'inlcr':bool(a[0]&termios.INLCR),'echo':bool(a[3]&termios.ECHO),'isig':bool(a[3]&termios.ISIG),'vmin':a[6][termios.VMIN] if isinstance(a[6][termios.VMIN],int) else a[6][termios.VMIN][0],'vtime':a[6][termios.VTIME] if isinstance(a[6][termios.VTIME],int) else a[6][termios.VTIME][0]}
  if mode!=last: print(json.dumps({'at':str(time.monotonic_ns()),'mode':mode}),flush=True);last=mode
 except OSError as e:
  print(json.dumps({'error':str(e),'at':str(time.monotonic_ns())}),flush=True);break
 time.sleep(.001)
`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, ms, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

for (let round = 0; round < 3; round++) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-pwsh-native-probe-'))
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  const versionFile = join(workspace, 'version.json')
  const version = `[IO.File]::WriteAllText('${versionFile.replaceAll("'", "''")}', ((@{ pwsh = $PSVersionTable.PSVersion.ToString(); dotnet = [Environment]::Version.ToString(); readline = (Get-Module PSReadLine | ForEach-Object { $_.Version.ToString() }) }) | ConvertTo-Json -Compress)); `
  const events = []
  let raw = ''
  let sent = false
  let sendTimer
  let monitorOutput = ''
  let monitorError = ''
  let closed = false
  let terminal
  let emulator
  let monitor
  let monitorExit
  let exit
  const record = (kind, data) => {
    events.push({ at: process.hrtime.bigint().toString(), kind, data })
    if (events.length > 200) events.shift()
  }
  try {
    terminal = pty.spawn('pwsh', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', version + setup], {
      cwd: workspace, cols: 160, rows: 40, name: 'dumb', env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
    })
    exit = new Promise(resolve => terminal.onExit(data => {
      closed = true
      record('exit', data)
      resolve(data)
    }))
    emulator = new Terminal({ cols: 160, rows: 40, scrollback: 0 })
    monitor = spawn('python3', ['-u', '-c', monitorScript, terminal.ptsName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    monitorExit = new Promise((resolve, reject) => {
      monitor.once('exit', resolve)
      monitor.once('error', reject)
    })
    // Preserve spawn errors as diagnostics; cleanup still awaits the same process promise.
    void monitorExit.catch(error => { monitorError = String(error) })
    monitor.stdout.on('data', data => { monitorOutput = (monitorOutput + data).slice(-32_768) })
    monitor.stderr.on('data', data => { monitorError = (monitorError + data).slice(-4_096) })
    emulator.onData(data => { record('protocol-write', data); terminal.write(data) })
    terminal.onData(data => {
      raw = (raw + data).slice(-32_768)
      record('output', data.slice(-4_096))
      emulator.write(data)
      if (!sent && raw.includes(prompt)) {
        sent = true
        sendTimer = setTimeout(() => {
          const command = "Write-Output ('NATIVE-' + 'READY')\r"
          record('caller-write', command)
          terminal.write(command)
        }, 10)
      }
    })
    const deadline = performance.now() + 3_000
    while (!raw.includes('NATIVE-READY') && !closed && performance.now() < deadline) await sleep(10)
    let versionInfo
    try { versionInfo = readFileSync(versionFile, 'utf8') }
    catch (error) { versionInfo = String(error) }
    console.log(JSON.stringify({
      round, platform: process.platform, arch: process.arch, node: process.version,
      pid: terminal.pid, tty: terminal.ptsName, version: versionInfo,
      commandExecuted: raw.includes('NATIVE-READY'), events,
      modeTransitions: monitorOutput, monitorError,
    }))
  } finally {
    clearTimeout(sendTimer)
    try {
      if (terminal && !closed) terminal.kill('SIGTERM')
      if (exit) await Promise.race([exit, sleep(1_000)])
      if (terminal && !closed) {
        terminal.kill('SIGKILL')
        await bounded(exit, 2_000, 'PowerShell did not exit after SIGKILL')
      }
    } finally {
      monitor?.kill('SIGTERM')
      try { if (monitorExit) await bounded(monitorExit, 2_000, 'PTY observer did not exit') }
      catch (error) {
        monitor?.kill('SIGKILL')
        await bounded(monitorExit, 2_000, 'PTY observer did not exit after SIGKILL')
        throw error
      } finally {
        emulator?.dispose()
        rmSync(workspace, { recursive: true, force: true })
      }
    }
  }
}
