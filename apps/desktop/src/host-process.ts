/** Electron Node-mode child lifecycle for the shared Web application. */

import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import { consumeRuntimeChildMessage, spawnRuntimeChild, type RuntimeChildLaunchRequest } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { desktopNodeEnvironment } from './node-environment.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | { readonly type: 'shutdown-complete' } | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  readonly error?: string
} | {
  readonly type: 'quit-inspection'
  readonly requestId: number
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error?: string
}

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One current child; old events retain this record and cannot mutate a successor. */
interface HostChildState {
  readonly child: ChildProcess
  readonly ready: PromiseWithResolvers<DesktopHostReady>
  readonly exited: PromiseWithResolvers<void>
  stderr: string
  failureReported: boolean
  stopping: boolean
  shutdownCompleted: boolean
  stopResult?: Promise<boolean>
  nextControlId: number
  readonly controlRequests: Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>
}
type ReplacementOperation<T> = Parameters<NonNullable<RuntimeChildLaunchRequest['owner']>['withReplacement']>[0] extends
(scope: infer Scope) => Promise<unknown> ? (scope: Scope) => Promise<T> : never

/** Shell-owned availability and ordinary readiness handling across a managed replacement. */
export interface DesktopHostReplacement {
  /** Track this whole replacement in the shell's existing startup/shutdown controller. */
  run<T>(operation: () => Promise<T>): Promise<T>
  /** Stop account observers and other per-child consumers before the old Host stops. */
  beforeStop(): void
  /** Rebind URL, authentication, injections and account observers to the replacement Host. */
  ready(ready: DesktopHostReady): Promise<void>
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private current: HostChildState | undefined
  private closed = false
  private replacement: { readonly abort: AbortController; readonly promise: Promise<unknown> } | undefined
  private startup: Promise<DesktopHostReady> | undefined

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   * @param replacementOwner - Existing shell lifecycle and readiness binding for managed child replacement.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly replacementOwner?: DesktopHostReplacement,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.closed) throw new Error('desktop host process is stopped')
    if (this.startup !== undefined) return this.startup
    if (this.current !== undefined) return this.current.ready.promise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawnRuntimeChild({ carrier: 'desktop-host', executable: this.node,
      owner: { withReplacement: operation => this.withReplacement(operation) }, args: [
        '--expose-internals',
        ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
        entry,
        this.runtimeDir,
        this.projectDir,
        this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
        ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
      ], options: {
        cwd: this.projectDir,
        env: desktopNodeEnvironment(this.node, undefined, this.environment),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      } })
    const initialReady = this.attach(child)
    const startup = (async () => {
      try { await initialReady }
      catch (error) { if (this.replacement === undefined) throw error }
      // Initial admission owns recovery just as a later replacement does. A
      // failed first child cannot settle shell startup while A is being restored.
      await this.replacement?.promise
      if (this.current === undefined || this.closed) throw new Error('desktop startup has no active child')
      return this.current.ready.promise
    })().finally(() => { if (this.startup === startup) this.startup = undefined })
    this.startup = startup
    return startup
  }

  private attach(child: ChildProcess): Promise<DesktopHostReady> {
    if (this.current !== undefined || this.closed) throw new Error('desktop child cannot replace an active or closed owner')
    const state: HostChildState = { child, ready: Promise.withResolvers<DesktopHostReady>(), exited: Promise.withResolvers<void>(),
      stderr: '', failureReported: false, stopping: false, shutdownCompleted: false, nextControlId: 1, controlRequests: new Map() }
    this.current = state
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { state.stderr = (state.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (this.current !== state) return
      try { if (consumeRuntimeChildMessage(child, message)) return }
      catch (error) {
        this.fail(state, new Error('dsh desktop host private coordinator rejected IPC', { cause: error }))
        child.kill('SIGTERM')
        return
      }
      if (!isDesktopHostEvent(message)) {
        this.fail(state, new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'ready') state.ready.resolve({ url: message.url, injections: message.injections })
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'shutdown-complete') {
        if (state.stopping) state.shutdownCompleted = true
        else this.fail(state, new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(state, new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = state.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(state, error) })
    child.once('close', (code) => {
      const suffix = state.stderr.trim() === '' ? '' : `: ${state.stderr.trim()}`
      if (code !== 0 && code !== null) this.fail(state, new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
      else this.fail(state, new Error(`dsh desktop host stopped${suffix}`))
      state.exited.resolve()
    })
    return state.ready.promise
  }

  private withReplacement<T>(operation: ReplacementOperation<T>): Promise<T> {
    const perform = (): Promise<T> => {
      if (this.closed || this.replacement !== undefined || this.current === undefined) return Promise.reject(new Error('desktop replacement is unavailable'))
      const abort = new AbortController()
      const promise = Promise.resolve().then(() => operation({
        signal: abort.signal,
        stop: async (child) => {
          abort.signal.throwIfAborted()
          const state = this.current
          if (state?.child !== child) throw new Error('desktop replacement does not own this child')
          this.replacementOwner?.beforeStop()
          await this.stopChild(state, true)
        },
        discard: async (child) => {
          abort.signal.throwIfAborted()
          const state = this.current
          if (state?.child !== child) throw new Error('desktop replacement does not own this failed child')
          this.replacementOwner?.beforeStop()
          await this.stopChild(state, false)
        },
        adopt: async (child) => {
          abort.signal.throwIfAborted()
          const ready = await this.attach(child)
          abort.signal.throwIfAborted()
          await this.replacementOwner?.ready(ready)
        },
      })).then((value) => {
        abort.signal.throwIfAborted()
        if (this.current === undefined || this.current.failureReported || this.current.stopping) throw new Error('desktop replacement has no healthy adopted child')
        return value
      }).catch(async (error: unknown) => {
        try { if (this.current !== undefined) await this.stopChild(this.current, false) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'desktop replacement and child cleanup failed') }
        if (abort.signal.aborted) throw abort.signal.reason
        throw error
      }).finally(() => { if (this.replacement?.abort === abort) this.replacement = undefined })
      this.replacement = { abort, promise }
      return promise
    }
    return this.replacementOwner === undefined ? perform() : this.replacementOwner.run(perform)
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<DesktopHostControlResponse> {
    const state = this.current
    if (state === undefined || !state.child.connected || state.failureReported || state.stopping) {
      throw new Error(`${request.type === 'update-tasks' ? 'desktop update' : 'desktop quit'}: Host is unavailable`)
    }
    const child = state.child
    const requestId = state.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        state.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error(deadlineMessage)) }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      state.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    this.closed = true
    const replacement = this.replacement
    replacement?.abort.abort(new DOMException('Desktop host is stopping', 'AbortError'))
    const results = await Promise.allSettled([
      this.current === undefined ? Promise.resolve() : this.stopChild(this.current, requireGraceful),
      replacement?.promise,
    ])
    if (results[0].status === 'rejected') throw results[0].reason
    if (results[1].status === 'rejected' && !(results[1].reason instanceof DOMException && results[1].reason.name === 'AbortError')) throw results[1].reason
  }

  private async stopChild(state: HostChildState, requireGraceful: boolean): Promise<void> {
    const child = state.child
    if (state.stopResult === undefined) state.stopResult = (async () => {
      state.stopping = true
      this.onPlatformSession?.(null)
      if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(state, error) })
      const exited = state.exited.promise
      const graceful = await exitsWithin(exited, 10_000)
      if (!graceful) child.kill('SIGTERM')
      if (!await exitsWithin(exited, 5_000)) {
        child.kill('SIGKILL')
        if (!await exitsWithin(exited, 5_000)) {
          throw new Error('dsh desktop host did not exit after SIGKILL')
        }
      }
      if (this.current === state) this.current = undefined
      return graceful
    })()
    const graceful = await state.stopResult
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !state.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(state.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(state: HostChildState, error: Error): void {
    if (this.current !== state) return
    this.onPlatformSession?.(null)
    state.ready.reject(error)
    for (const request of state.controlRequests.values()) request.reject(error)
    state.controlRequests.clear()
    if (!state.failureReported && !state.stopping) {
      state.failureReported = true
      // The coordinator may replace a failed B with the explicitly committed A.
      // Its scope owns candidate errors until healthy adoption or final rejection.
      try { if (this.replacement === undefined) this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
