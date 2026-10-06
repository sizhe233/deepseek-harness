import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TerminalSessionService, { TerminalBackendCleanupError, TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import { BashTerminalBackend, PWSH_PROMPT_SETUP } from '@deepseek-ai/dsh-terminal-bash'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'
import { resolveConfig, type ResolvedConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import { LocalPtySession } from '@deepseek-ai/dsh-terminal-bash/src/session.ts'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

class EmptySandbox extends SandboxProvider {
  async confine(_argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

class RecordingSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.calls.push({ argv, policy })
    return { argv: ['/sandbox', '--', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function config(): ResolvedConfig {
  return {
    backendType: 'shell', shellDialect: 'bash', pwshBootstrap: 'argv', shellPath: '/bin/bash', shellArgs: [], rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 100, maxReadBytes: 50,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 50, handoffGraceMs: 10, promptTailGraceMs: 0, timeoutMs: 100,
    disposeGraceMs: 10,
  }
}

function agent(ctx: Context, cwd?: string): Agent {
  const id = SessionId('agent')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, ...cwd === undefined ? {} : { cwd },
  })
  return {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function terminalHandle(): SubprocessTerminalHandle & { output: PassThrough } {
  const output = new PassThrough()
  return {
    pid: 123,
    output,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    write: async () => {},
    resize: async () => {},
    inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
    inspectForeground: async () => ({ processGroupId: 123, inputWaiting: true }),
    signalForeground: async () => 123,
    terminate: async () => { output.end() },
  }
}

class StubSubprocessRuntime extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: 'posix' as const } }
  async resolveExecutable(command: string): Promise<string> { return command }
  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('unused') }
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return terminalHandle()
  }
}

function spec(owner: Agent, signal?: AbortSignal) {
  return {
    sessionId: TerminalSessionId('pty-1'), owner, type: 'shell',
    ...signal !== undefined ? { signal } : {},
  }
}

function stubLocalSession(initialize: () => Promise<void> = () => Promise.resolve()): LocalPtySession {
  return {
    motd: '',
    initialize,
    startSend: () => { throw new Error('unused') },
    read: () => { throw new Error('unused') },
    signal: () => Promise.resolve({ delivered: true, targetPgid: 1 }),
    status: () => ({ kind: 'running' as const }),
    close: () => Promise.resolve(),
  } as unknown as LocalPtySession
}

function registerStubLocalBackend(ctx: Context, createSession: () => LocalPtySession) {
  return ctx.inject(['terminals', 'sandbox', 'sandboxPolicy', 'sessionProjections', 'subprocess'], (providerCtx) => {
    providerCtx.terminals.registerBackend(new BashTerminalBackend(
      providerCtx,
      { ...config(), backendType: 'stub' },
      async () => terminalHandle(),
      createSession,
    ))
  })
}

describe('BashTerminalBackend startup rollback', () => {
  it('rejects pre-aborted setup and empty sandbox argv', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/tmp' })
    const backend = new BashTerminalBackend(ctx, config(), async () => terminalHandle())
    const controller = new AbortController()
    const abortReason = new Error('spawn aborted')
    controller.abort(abortReason)
    await expect(backend.spawn(spec(agent(ctx), controller.signal))).rejects.toBe(abortReason)
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('empty argv')
  })

  it('closes failed startup and aggregates cleanup failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const spawnTerminal = async (): Promise<SubprocessTerminalHandle> => terminalHandle()

    const closed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const failed = { initialize: () => Promise.reject(new Error('startup failed')), close: closed } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(ctx, config(), spawnTerminal, () => failed)
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('startup failed')
    expect(closed).toHaveBeenCalledWith('PTY startup failed')

    const startupFailure = new Error('startup failed')
    const cleanupFailure = new Error('cleanup failed')
    const doublyFailed = {
      initialize: () => Promise.reject(startupFailure),
      close: () => Promise.reject(cleanupFailure),
    } as unknown as LocalPtySession
    const aggregate = new BashTerminalBackend(ctx, config(), spawnTerminal, () => doublyFailed)
    await expect(aggregate.spawn(spec(agent(ctx)))).rejects.toEqual(expect.objectContaining({
      name: 'TerminalBackendCleanupError',
      spawnError: startupFailure,
      cleanupError: cleanupFailure,
    } satisfies Partial<TerminalBackendCleanupError>))
  })

  it('awaits terminal cleanup when session construction fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const quiescent = Promise.withResolvers<undefined>()
    const terminal = {
      ...terminalHandle(),
      terminate: vi.fn(() => quiescent.promise),
    }
    const constructionStarted = Promise.withResolvers<undefined>()
    const failure = new Error('terminal emulator unavailable')
    const backend = new BashTerminalBackend(
      ctx,
      config(),
      async () => terminal,
      () => {
        constructionStarted.resolve(undefined)
        throw failure
      },
    )

    const spawning = backend.spawn(spec(agent(ctx)))
    await constructionStarted.promise
    expect(terminal.terminate).toHaveBeenCalledOnce()
    let settled = false
    void spawning.then(
      () => { settled = true },
      () => { settled = true },
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    quiescent.resolve(undefined)
    await expect(spawning).rejects.toBe(failure)
  })

  it('starts startup rollback when cancellation wins a stalled initialization', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const initialization = Promise.withResolvers<undefined>()
    const initializationStarted = Promise.withResolvers<undefined>()
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = {
      initialize: () => {
        initializationStarted.resolve(undefined)
        return initialization.promise
      },
      close,
    } as unknown as LocalPtySession
    const backend = new BashTerminalBackend(ctx, config(), async () => terminalHandle(), () => session)
    const controller = new AbortController()
    const reason = new Error('cancel stalled startup')

    const spawning = backend.spawn(spec(agent(ctx), controller.signal))
    await initializationStarted.promise
    controller.abort(reason)

    await expect(spawning).rejects.toBe(reason)
    expect(close).toHaveBeenCalledWith('PTY startup failed')
    initialization.resolve(undefined)
  })

  it('does not allocate a terminal when confinement resolves after cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const entered = Promise.withResolvers<AbortSignal>()
    const response = Promise.withResolvers<ConfinedArgv>()
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation((_argv, _policy, signal) => {
      entered.resolve(signal!)
      return response.promise
    })
    const spawnTerminal = vi.fn(async () => terminalHandle())
    const backend = new BashTerminalBackend(ctx, config(), spawnTerminal)
    const controller = new AbortController()
    const spawning = backend.spawn(spec(agent(ctx), controller.signal))
    const signal = await entered.promise
    controller.abort(new Error('cancel confinement'))
    expect(signal.aborted).toBe(true)
    response.resolve({ argv: ['bash'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await expect(spawning).rejects.toThrow('cancel confinement')
    expect(spawnTerminal).not.toHaveBeenCalled()
  })

  it('wraps confined argv, scrubs the environment, and returns initialized sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const terminal = terminalHandle()
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
      spawned = spec
      return terminal
    }
    const initialized = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = new LocalPtySession(terminalHandle(), config())
    vi.spyOn(session, 'initialize').mockImplementation(initialized)
    onTestFinished(() => session.close('fixture cleanup'))
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellArgs: ['-i'] },
      spawnTerminal,
      () => session,
    )
    const previous = process.env.PTY_TEST_SECRET
    process.env.PTY_TEST_SECRET = 'must-not-leak'
    try {
      expect(await backend.spawn({ ...spec(agent(ctx)), cwd: '/work' })).toBe(session)
    } finally {
      if (previous === undefined) delete process.env.PTY_TEST_SECRET
      else process.env.PTY_TEST_SECRET = previous
    }

    expect(spawned).toMatchObject({
      argv: ['/sandbox', '--', '/bin/bash', '-i'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      graceMs: 10,
      env: {
        TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: 'dsh> ', BASH_SILENCE_DEPRECATION_WARNING: '1',
        PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"; PS1=\'dsh> \'',
        DSH_SHELL: '1', DSH_SESSION_ID: 'agent', DSH_PTY_SESSION_ID: 'pty-1',
      },
    })
    expect(spawned?.env?.PTY_TEST_SECRET).toBeUndefined()
    expect(initialized).toHaveBeenCalledWith(undefined, undefined, '\r')
    expect((ctx.sandbox as RecordingSandbox).calls).toEqual([{
      argv: ['/bin/bash', '-i'],
      policy: { mode: 'workspace-write', sessionId: 'agent', workspaceRoot: resolve('/workspace') },
    }])
  })

  it('resolves session mode and root together before wrapping the shell', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/deployment-fallback' })
    const terminal = terminalHandle()
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
      spawned = spec
      return terminal
    }
    const initialized = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = new LocalPtySession(terminalHandle(), config())
    vi.spyOn(session, 'initialize').mockImplementation(initialized)
    onTestFinished(() => session.close('fixture cleanup'))
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellArgs: ['-i'] },
      spawnTerminal,
      () => session,
    )
    const owner = agent(ctx, '/session-workspace')
    setSandboxMode(owner.session, 'workspace-write')
    expect(await backend.spawn(spec(owner))).toBe(session)

    expect(spawned).toMatchObject({
      argv: ['/sandbox', '--', '/bin/bash', '-i'],
      cwd: resolve('/session-workspace'),
    })
    expect((ctx.sandbox as RecordingSandbox).calls).toEqual([{
      argv: ['/bin/bash', '-i'],
      policy: { mode: 'workspace-write', sessionId: 'agent', workspaceRoot: resolve('/session-workspace') },
    }])
  })

  it('rejects a confined spawn without a sandbox provider', async () => {
    const confinedCtx = new Context()
    await confinedCtx.plugin(SessionProjectionRegistry)
    await confinedCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const confined = new BashTerminalBackend(
      confinedCtx,
      config(),
      async () => { throw new Error('terminal spawn must not run') },
      () => stubLocalSession(),
    )
    await expect(confined.spawn(spec(agent(confinedCtx)))).rejects.toThrow(
      'sandbox mode "workspace-write" requires a ctx.sandbox provider in the execution world',
    )
  })

  it('forwards terminal allocation cancellation directly', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })

    const publishedController = new AbortController()
    let publishedSignal: AbortSignal | undefined
    const published = new BashTerminalBackend(
      ctx,
      config(),
      async (spawnSpec) => {
        publishedSignal = spawnSpec.signal
        return terminalHandle()
      },
      () => stubLocalSession(),
    )
    await published.spawn(spec(agent(ctx), publishedController.signal))
    expect(publishedSignal).toBe(publishedController.signal)
    publishedController.abort(new Error('originating turn ended'))
    expect(publishedSignal?.aborted).toBe(true)

    const pendingController = new AbortController()
    const seen = Promise.withResolvers<AbortSignal>()
    const pending = new BashTerminalBackend(
      ctx,
      config(),
      async spawnSpec => await new Promise<SubprocessTerminalHandle>((_resolve, reject) => {
        const setupSignal = spawnSpec.signal as AbortSignal
        seen.resolve(setupSignal)
        const onAbort = (): void => {
          reject(setupSignal.reason instanceof Error ? setupSignal.reason : new Error(String(setupSignal.reason)))
        }
        setupSignal.addEventListener('abort', onAbort, { once: true })
      }),
      () => stubLocalSession(),
    )
    const spawning = pending.spawn(spec(agent(ctx), pendingController.signal))
    const pendingSignal = await seen.promise
    const reason = new Error('cancel pending allocation')
    pendingController.abort(reason)
    await expect(spawning).rejects.toBe(reason)
    expect(pendingSignal.aborted).toBe(true)
  })

  it('composes the default local session around a spawned terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const output = new PassThrough()
    const outcome = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const terminal: SubprocessTerminalHandle = {
      pid: 123,
      output,
      done: outcome.promise,
      write: async () => {},
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
      inspectForeground: async () => ({ processGroupId: 123, inputWaiting: true }),
      signalForeground: async () => 123,
      async terminate() {
        output.end()
        outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
      },
    }
    queueMicrotask(() => { output.write(Buffer.from('\x1b]133;D;0\x07dsh> ')) })
    const backend = new BashTerminalBackend(
      ctx,
      config(),
      async () => terminal,
    )
    const session = await backend.spawn(spec(agent(ctx)))
    expect(session.motd).toBe('dsh> ')
    await session.close('test complete')
  })

  it.each([
    { inputWaiting: false, pwshBootstrap: 'argv' as const },
    { inputWaiting: true, pwshBootstrap: 'argv' as const },
    { inputWaiting: false, pwshBootstrap: 'stdin' as const },
    { inputWaiting: true, pwshBootstrap: 'stdin' as const },
  ])('waits for the installed pwsh prompt before publishing startup ($pwshBootstrap, stdin wait: $inputWaiting)', async ({ inputWaiting, pwshBootstrap }) => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const terminal = terminalHandle()
    const writes: string[] = []
    let waiting = false
    terminal.write = async (text) => { writes.push(text) }
    terminal.inspectForeground = async () => ({ processGroupId: terminal.pid, inputWaiting: waiting })
    const backend = new BashTerminalBackend(ctx, {
      ...config(), shellDialect: 'pwsh', shellPath: 'pwsh', pwshBootstrap, timeoutMs: 300,
    }, async () => terminal)
    let published = false
    const spawning = backend.spawn(spec(agent(ctx))).then((session) => {
      published = true
      return session
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(writes).toEqual(pwshBootstrap === 'argv' ? [] : [ENCODING_PREAMBLE + PWSH_PROMPT_SETUP + '\x1bOM'])
      // The host can await stdin before the bootstrap command has executed.
      waiting = inputWaiting
      await vi.advanceTimersByTimeAsync(20)
      expect(published).toBe(false)

      terminal.output.write(Buffer.from(PWSH_PROMPT_SETUP + '\r\n'))
      await vi.advanceTimersByTimeAsync(60)
      expect(published).toBe(false)
      terminal.output.write(Buffer.from('\x1b]133;D;0\x07'))
      await vi.advanceTimersByTimeAsync(20)
      expect(published).toBe(false)
      terminal.output.write(Buffer.from('dsh> still starting'))
      await vi.advanceTimersByTimeAsync(60)
      expect(published).toBe(false)

      terminal.output.write(Buffer.from('\x1b]133;D;0\x07dsh> '))
      await vi.advanceTimersByTimeAsync(10)
      const session = await spawning
      expect(session.motd).toMatch(/dsh> $/)
      expect(Buffer.byteLength(session.motd)).toBeLessThanOrEqual(config().maxReadBytes)
      expect(writes).toEqual(pwshBootstrap === 'argv' ? [] : [ENCODING_PREAMBLE + PWSH_PROMPT_SETUP + '\x1bOM'])
      await session.close('test complete')
    } finally {
      await terminal.terminate()
      await spawning.catch(() => {})
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('bootstraps pwsh through argv, forwards cancellation, and scrubs bash-only env', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const initialized = vi.fn<LocalPtySession['initialize']>().mockResolvedValue(undefined)
    const session = new LocalPtySession(terminalHandle(), config())
    vi.spyOn(session, 'initialize').mockImplementation(initialized)
    onTestFinished(() => session.close('fixture cleanup'))
    const backend = new BashTerminalBackend(
      ctx,
      { ...config(), shellDialect: 'pwsh', shellPath: 'pwsh' },
      async (spec) => { spawned = spec; return terminalHandle() },
      () => session,
    )
    const signal = new AbortController().signal
    expect(await backend.spawn(spec(agent(ctx), signal))).toBe(session)
    expect(initialized).toHaveBeenCalledExactlyOnceWith(signal, undefined, '\r')
    expect(spawned?.argv).toEqual(['pwsh', '-NoExit', '-Command', ENCODING_PREAMBLE + PWSH_PROMPT_SETUP])
    expect(spawned?.env).toMatchObject({
      TERM: 'dumb', NO_COLOR: '1', DSH_SHELL: '1', DSH_SESSION_ID: 'agent', DSH_PTY_SESSION_ID: 'pty-1',
    })
    expect(spawned?.env?.PS1).toBeUndefined()
    expect(spawned?.env?.PROMPT_COMMAND).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it.each([
    { shellArgs: [], managed: true },
    { shellArgs: ['-NoProfile'], managed: false },
    { shellArgs: ['-NoExit', '-Command', '$env:KEEP = "custom"'], managed: false },
    { shellArgs: ['-NoExit', '-File', 'custom.ps1'], managed: false },
  ].flatMap(entry => (['posix', 'windows'] as const).map(platform => ({ ...entry, platform }))))('confines the complete pwsh argv and preserves custom startup: $shellArgs ($platform)', async ({ shellArgs, managed, platform }) => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockResolvedValue({ platform })
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    let spawned: SubprocessTerminalSpawnSpec | undefined
    const initialized = vi.fn<LocalPtySession['initialize']>().mockResolvedValue(undefined)
    const session = new LocalPtySession(terminalHandle(), config())
    vi.spyOn(session, 'initialize').mockImplementation(initialized)
    onTestFinished(() => session.close('fixture cleanup'))
    const resolved = resolveConfig({ ...config(), shellDialect: 'pwsh', shellPath: 'pwsh', shellArgs })
    const backend = new BashTerminalBackend(ctx, resolved,
      async (spec) => { spawned = spec; return terminalHandle() }, () => session)
    try {
      await backend.spawn(spec(agent(ctx)))
      const argv = ['pwsh', ...(managed
        ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', ENCODING_PREAMBLE + PWSH_PROMPT_SETUP]
        : shellArgs)]
      expect((ctx.sandbox as RecordingSandbox).calls[0]?.argv).toEqual(argv)
      expect(spawned?.argv).toEqual(['/sandbox', '--', ...argv])
      expect(initialized).toHaveBeenCalledExactlyOnceWith(undefined,
        managed ? undefined : ENCODING_PREAMBLE + PWSH_PROMPT_SETUP,
        !managed && platform === 'posix' ? '\x1bOM' : '\r')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not allocate a custom pwsh terminal after cancellation during environment discovery', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const environment = Promise.withResolvers<{ platform: 'posix' }>()
    const discover = vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockReturnValue(environment.promise)
    const spawn = vi.fn(async () => terminalHandle())
    const backend = new BashTerminalBackend(ctx, {
      ...config(), shellDialect: 'pwsh', shellPath: 'pwsh', pwshBootstrap: 'stdin', shellArgs: ['-NoProfile'],
    }, spawn)
    const controller = new AbortController()
    const reason = new Error('cancel environment discovery')
    try {
      const spawning = backend.spawn(spec(agent(ctx), controller.signal))
      const rejected = expect(spawning).rejects.toBe(reason)
      expect(discover).toHaveBeenCalledExactlyOnceWith(controller.signal)
      controller.abort(reason)
      environment.resolve({ platform: 'posix' })
      await rejected
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['exit', 'abort'] as const)('closes unpublished pwsh when startup ends by %s', async (ending) => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const terminal = terminalHandle()
    const terminate = vi.spyOn(terminal, 'terminate')
    const controller = new AbortController()
    const reason = new Error('cancel pwsh startup')
    const backend = new BashTerminalBackend(ctx, {
      ...config(), shellDialect: 'pwsh', shellPath: 'pwsh',
    }, async () => terminal)
    const spawning = backend.spawn(spec(agent(ctx), controller.signal))
    const rejected = ending === 'exit'
      ? expect(spawning).rejects.toThrow('PTY shell exited during startup')
      : expect(spawning).rejects.toBe(reason)
    try {
      await vi.advanceTimersByTimeAsync(0)
      if (ending === 'exit') terminal.output.end()
      else controller.abort(reason)
      await rejected
      expect(terminate).toHaveBeenCalledTimes(1)
      expect(terminal.output.readableEnded).toBe(true)
    } finally {
      await terminal.terminate()
      await spawning.catch(() => {})
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('bounds pwsh startup with one deadline and closes a shell without a verified prompt', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const terminal = terminalHandle()
    const writes: string[] = []
    terminal.write = async (text) => { writes.push(text) }
    const terminate = vi.spyOn(terminal, 'terminate')
    const backend = new BashTerminalBackend(ctx, {
      ...config(), shellDialect: 'pwsh', shellPath: 'pwsh',
    }, async () => terminal)
    const spawning = backend.spawn(spec(agent(ctx)))
    const rejected = expect(spawning).rejects.toThrow('did not reach readiness before startup timeout')
    try {
      await vi.advanceTimersByTimeAsync(0)
      terminal.output.write(Buffer.from(PWSH_PROMPT_SETUP + '\r\n'))
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(writes).toEqual([])
      expect(terminate).toHaveBeenCalledTimes(1)
      expect(terminal.output.readableEnded).toBe(true)
    } finally {
      await terminal.terminate()
      await spawning.catch(() => {})
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

})

describe('terminal-bash plugin shape', () => {
  it('keeps name, inject, and Config through Loader unwrapExports', () => {
    expect('default' in ptyLocal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ptyLocal) as Record<string, unknown>
    expect(unwrapped.name).toBe('terminal-bash')
    expect(unwrapped.inject).toEqual(['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess'])
    expect(unwrapped.Config).toBeDefined()
  })

  it('validates config and registers the configured backend', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)
    const fiber = await ctx.plugin(ptyLocal, config())
    expect(ctx.terminals.listBackends()).toEqual(['shell'])
    await fiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
  })

  it('ignores unrelated session events and mode changes without a live owner', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)
    await ctx.plugin(ptyLocal, config())

    const session = ctx.sessions.create(SessionId('unowned-mode'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
    expect(() => { setSandboxMode(session, 'read-only') }).not.toThrow()
  })

  it('keeps the owner-lifetime sandbox fence after the local provider unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)

    const session = ctx.sessions.create(SessionId('mode-owner'))
    const ownerFiber = await ctx.plugin(() => {})
    const owner: Agent = {
      id: session.id, options: {}, session, inbox: unsupportedInbox(),
      status: 'idle',
      ctx: ownerFiber.ctx,
      send: () => {},
      followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(owner)
    const providerFiber = await registerStubLocalBackend(ctx, () => stubLocalSession())
    const created = await ctx.terminals.spawn(owner, { type: 'stub' })

    const unrelated = ctx.sessions.create(SessionId('unrelated-mode'))
    expect(() => { setSandboxMode(unrelated, 'read-only') }).not.toThrow()
    expect(() => {
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()

    expect(() => { setSandboxMode(session, 'danger-full-access') }).not.toThrow()
    await providerFiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow(
      'cannot change sandbox mode from "danger-full-access" to "read-only" while persistent terminal sessions are open or being created; wait for creation to settle and close them first',
    )
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)

    const replacementFiber = await registerStubLocalBackend(ctx, () => stubLocalSession())
    const second = await ctx.terminals.spawn(owner, { type: 'stub' })
    await replacementFiber.dispose()
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow('open or being created')

    await ctx.terminals.kill(owner, created.sessionId)
    await ctx.terminals.kill(owner, second.sessionId)
    expect(() => { setSandboxMode(session, 'read-only') }).not.toThrow()
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(2)
  })

  it('also fences sandbox-mode changes across unpublished PTY creation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    await ctx.plugin(StubSubprocessRuntime)

    const session = ctx.sessions.create(SessionId('pending-mode-owner'))
    const ownerFiber = await ctx.plugin(() => {})
    const owner: Agent = {
      id: session.id, options: {}, session, inbox: unsupportedInbox(),
      status: 'idle',
      ctx: ownerFiber.ctx,
      send: () => {},
      followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(owner)
    const gate = Promise.withResolvers<undefined>()
    await registerStubLocalBackend(ctx, () => stubLocalSession(() => gate.promise))
    const spawning = ctx.terminals.spawn(owner, { type: 'stub' })

    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow('open or being created')
    gate.resolve(undefined)
    const created = await spawning
    await ctx.terminals.kill(owner, created.sessionId)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
  })
})
