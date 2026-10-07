import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as runtimeAdmission from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { DesktopBackendController } from '../src/backend-controller.ts'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, QUIT_INSPECTION_DEADLINE_MS } from '../src/host-process.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type === 'quit-inspection') {
    // Ids divisible by three never answer; the others report scheduled work for odd ids.
    if (message.requestId % 3 === 0) return
    process.send({ type: 'quit-inspection', requestId: message.requestId, activeTasks: false, scheduledTasks: message.requestId % 2 === 1 })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, environment, onFailure)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('adopts a real replacement child under the same owner and routes controls, readiness and shutdown to it', async () => {
    let launch: runtimeAdmission.RuntimeChildLaunchRequest | undefined
    let firstChild: ChildProcess | undefined
    const original = runtimeAdmission.spawnRuntimeChild
    const capture = vi.spyOn(runtimeAdmission, 'spawnRuntimeChild').mockImplementation((request) => {
      launch = request
      firstChild = original(request)
      return firstChild
    })
    const runtime = projectWithHost()
    const rebound = vi.fn(async (_ready: { readonly url: string }) => {})
    const beforeStop = vi.fn()
    const failures = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, failures,
      undefined, undefined, undefined, { run: operation => operation(), beforeStop, ready: rebound })
    hosts.push(host)
    try {
      const first = await host.start()
      if (launch?.owner === undefined || firstChild === undefined) throw new Error('missing launch owner')
      const request = launch
      const previous = firstChild
      let successor: ChildProcess | undefined
      await launch.owner.withReplacement(async (scope) => {
        await scope.stop(previous)
        expect(previous.exitCode).toBe(0)
        successor = spawn(request.executable, [...request.args], request.options)
        await scope.adopt(successor)
      })
      expect(beforeStop).toHaveBeenCalledTimes(1)
      expect(rebound).toHaveBeenCalledTimes(1)
      expect(rebound.mock.calls[0]?.[0]).not.toEqual(first)
      expect(await host.updateTasks('lock')).toBe(true)
      previous.emit('message', { type: 'fatal', message: 'stale predecessor' })
      expect(failures).not.toHaveBeenCalled()
      await host.stop(true)
      expect(successor?.exitCode).toBe(0)
      await expect(host.start()).rejects.toThrow('stopped')
    } finally { capture.mockRestore() }
  })

  it('keeps the shell usable after an exited failed candidate is excluded and the predecessor is relaunched', async () => {
    let launch: runtimeAdmission.RuntimeChildLaunchRequest | undefined
    let previous: ChildProcess | undefined
    const original = runtimeAdmission.spawnRuntimeChild
    const capture = vi.spyOn(runtimeAdmission, 'spawnRuntimeChild').mockImplementation((request) => {
      launch = request; previous = original(request); return previous
    })
    const runtime = projectWithHost(), failures = vi.fn()
    let host!: DesktopHostProcess
    let instance!: { start(): Promise<unknown>; stop(): Promise<void> }
    const controller = new DesktopBackendController((onFailure) => {
      host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
        (error) => { failures(error); onFailure(error) },
        undefined, undefined, undefined, { run: operation => controller.continueHost(instance, operation),
          beforeStop: () => {}, ready: async () => {} })
      hosts.push(host)
      instance = { start: () => host.start(), stop: () => host.stop(true) }
      return instance
    }, () => {})
    try {
      await controller.start(async () => {})
      if (launch?.owner === undefined || previous === undefined) throw new Error('missing launch owner')
      const request = launch, oldChild = previous
      let failed: ChildProcess | undefined, restored: ChildProcess | undefined
      await launch.owner.withReplacement(async (scope) => {
        await scope.stop(oldChild)
        failed = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        await expect(scope.adopt(failed)).rejects.toThrow('exited with 7')
        expect(failed.exitCode).toBe(7)
        await scope.discard(failed)
        restored = spawn(request.executable, [...request.args], request.options)
        await scope.adopt(restored)
      })
      expect(controller.state).toEqual({ phase: 'ready' })
      expect(controller.host).toBe(instance)
      expect(failures).not.toHaveBeenCalled()
      expect(await host.updateTasks('lock')).toBe(true)
      await controller.close()
      expect(restored?.exitCode).toBe(0)
    } finally { capture.mockRestore() }
  })

  it('cancels and joins adoption when normal shell shutdown starts before replacement readiness', async () => {
    let launch: runtimeAdmission.RuntimeChildLaunchRequest | undefined
    let previous: ChildProcess | undefined
    const original = runtimeAdmission.spawnRuntimeChild
    const capture = vi.spyOn(runtimeAdmission, 'spawnRuntimeChild').mockImplementation((request) => {
      launch = request; previous = original(request); return previous
    })
    const runtime = projectWithHost()
    let host!: DesktopHostProcess
    let instance!: { start(): Promise<unknown>; stop(): Promise<void> }
    const controller = new DesktopBackendController((onFailure) => {
      host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, onFailure,
        undefined, undefined, undefined, { run: operation => controller.continueHost(instance, operation),
          beforeStop: () => {}, ready: async () => {} })
      hosts.push(host)
      instance = { start: () => host.start(), stop: () => host.stop(true) }
      return instance
    }, () => {})
    try {
      await controller.start(async () => {})
      if (launch?.owner === undefined || previous === undefined) throw new Error('missing launch owner')
      const oldChild = previous
      const adopted = Promise.withResolvers<undefined>()
      let successor: ChildProcess | undefined
      const replacing = launch.owner.withReplacement(async (scope) => {
        await scope.stop(oldChild)
        successor = spawn(process.execPath, ['--input-type=module', '-e', `
          process.on('message', message => {
            if (message.type === 'shutdown') process.send({ type: 'shutdown-complete' }, () => process.disconnect())
          })
          setInterval(() => {}, 1000).unref()
        `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        const ready = scope.adopt(successor)
        adopted.resolve(undefined)
        await ready
      })
      const rejected = expect(replacing).rejects.toMatchObject({ name: 'AbortError' })
      await adopted.promise
      expect(controller.host).toBeUndefined()
      await controller.close()
      await rejected
      expect(successor?.exitCode).toBe(0)
    } finally { capture.mockRestore() }
  })

  it('finishes initial startup only after a failed first child is replaced by the restored runtime', async () => {
    const runtime = projectWithHost(), failures = vi.fn(), rebound = vi.fn(async () => {})
    let host!: DesktopHostProcess
    let instance!: { start(): Promise<unknown>; stop(): Promise<void> }
    let recovery: Promise<void> | undefined, failed: ChildProcess | undefined, restored: ChildProcess | undefined
    const controller = new DesktopBackendController((onFailure) => {
      host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
        (error) => { failures(error); onFailure(error) }, undefined, undefined, undefined,
        { run: operation => controller.continueHost(instance, operation), beforeStop: () => {}, ready: rebound })
      hosts.push(host)
      instance = { start: () => host.start(), stop: () => host.stop(true) }
      return instance
    }, () => {})
    const capture = vi.spyOn(runtimeAdmission, 'spawnRuntimeChild').mockImplementation((request) => {
      const owner = request.owner
      if (owner === undefined) throw new Error('missing launch owner')
      const candidate = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 50)'],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      failed = candidate
      queueMicrotask(() => {
        recovery = owner.withReplacement(async (scope) => {
          await new Promise<void>(resolve => candidate.once('close', () => { resolve() }))
          await scope.discard(candidate)
          restored = spawn(request.executable, [...request.args], request.options)
          await scope.adopt(restored)
        })
        void recovery.catch(() => {})
      })
      return candidate
    })
    try {
      await controller.start(async () => {})
      await recovery
      expect(failed?.exitCode).toBe(7)
      expect(restored?.pid).toBeTypeOf('number')
      expect(controller.state).toEqual({ phase: 'ready' })
      expect(controller.host).toBe(instance)
      expect(rebound).toHaveBeenCalledTimes(1)
      expect(failures).not.toHaveBeenCalled()
      expect(await host.updateTasks('lock')).toBe(true)
      await controller.close()
      expect(restored?.exitCode).toBe(0)
    } finally { capture.mockRestore() }
  })

  it('delivers private coordinator traffic separately while preserving ordinary ready, control and shutdown IPC', async () => {
    let privatePid: number | undefined
    const consume = vi.spyOn(runtimeAdmission, 'consumeRuntimeChildMessage').mockImplementation((child, message) => {
      if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'dsh-runtime-test') {
        privatePid = child.pid
        return true
      }
      return false
    })
    try {
      const host = hostProcess(projectWithHost(`process.send({ type: 'dsh-runtime-test' });\n${HTTP_HOST}`))
      const ready = await host.start()
      expect(ready.url).toContain('token=fixture')
      expect(privatePid).toBeTypeOf('number')
      expect(await host.updateTasks('inspect')).toBe(false)
      await host.stop()
    } finally { consume.mockRestore() }
  })

  it.each(['refused', 'throw'] as const)('stops a Host after %s private coordinator traffic', async (mode) => {
    const cause = new Error('native child identity mismatch')
    const consume = vi.spyOn(runtimeAdmission, 'consumeRuntimeChildMessage').mockImplementation(() => {
      if (mode === 'throw') throw cause
      return false
    })
    try {
      const host = hostProcess(projectWithHost("process.send({ type: 'dsh-runtime-invalid' }); setInterval(() => {}, 1000)"))
      if (mode === 'throw') await expect(host.start()).rejects.toMatchObject({ message: 'dsh desktop host private coordinator rejected IPC', cause })
      else await expect(host.start()).rejects.toThrow('sent an invalid IPC event')
      await host.stop()
    } finally { consume.mockRestore() }
  })

  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it('correlates quit inspections with task requests and fails an unanswered one at its own deadline', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: Host is unavailable')
    await host.start()
    // Request ids 1 and 2: the fixture answers by id parity, so both control kinds share one id space.
    expect(await Promise.all([host.inspectQuit(), host.updateTasks('inspect')]))
      .toEqual([{ activeTasks: false, scheduledTasks: true }, false])
    const started = Date.now()
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: inspection timed out')
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUIT_INSPECTION_DEADLINE_MS - 50)
    expect(await host.inspectQuit()).toEqual({ activeTasks: false, scheduledTasks: false })
  }, 15_000)

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })
})

it.each([null, 'stable-account'])('carries Platform identity %s over private IPC and clears credentials on shutdown', async (userId) => {
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'", "process.send({ type: 'platform-session', session: { origin: 'https://platform.deepseek.com', userId: " + JSON.stringify(userId) + ", token: 'fixture-secret', embeddedPageDist: 'feat/test' } }); process.send({ type: 'ready'"))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await host.start()
  expect(changed).toHaveBeenCalledWith({ origin: 'https://platform.deepseek.com', userId, token: 'fixture-secret', embeddedPageDist: 'feat/test' })
  await host.stop()
  expect(changed).toHaveBeenLastCalledWith(null)
})

it.each([undefined, '', 7])('rejects malformed Platform account identity %s on private IPC', async (userId) => {
  const session = { origin: 'https://platform.deepseek.com', token: 'fixture-secret', userId }
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'",
    `process.send({ type: 'platform-session', session: ${JSON.stringify(session)} }); process.send({ type: 'ready'`))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await expect(host.start()).rejects.toThrow('invalid IPC event')
  expect(changed.mock.calls).toEqual([[null]])
  await host.stop()
})
