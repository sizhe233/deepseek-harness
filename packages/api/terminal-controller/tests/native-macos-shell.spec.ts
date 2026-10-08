/** Native macOS shell selection and PTY acceptance; other hosts cannot provide this evidence. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolveShell } from '../src/shells.ts'
import type { TerminalShell } from '../src/types.ts'

async function withLocalShell(run: (runtime: SubprocessRuntime, cwd: string, home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-macos-shell-'))
  const ctx = new Context()
  const previous = new Map(['HOME', 'ZDOTDIR', 'SHELL'].map(key => [key, process.env[key]]))
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> => cleanup ??= (async () => {
    try { await ctx.fiber.dispose() } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })()
  onTestFinished(dispose)
  try {
    // macOS /var is a symlink; compare the shell's physical cwd with its real path.
    const cwd = await realpath(root)
    const home = join(cwd, 'home')
    await mkdir(home)
    await writeFile(join(home, '.zshrc'), "PROMPT=''\nRPROMPT=''\nexport DSH_TEST_ZSHRC=isolated\n")
    process.env.HOME = home
    process.env.ZDOTDIR = home
    process.env.SHELL = '/bin/zsh'
    await ctx.plugin(LocalSubprocessRuntime)
    // Missing /bin/zsh is a macOS acceptance failure, never a dependency skip.
    await expect(ctx.subprocess.resolveExecutable('/bin/zsh')).resolves.toBe('/bin/zsh')
    await run(ctx.subprocess, cwd, home)
  } finally { await dispose() }
  expect(new Map([...previous.keys()].map(key => [key, process.env[key]]))).toEqual(previous)
}

async function runZsh(runtime: SubprocessRuntime, shell: TerminalShell, cwd: string, home: string, zshrc: string): Promise<void> {
  const handle = await runtime.spawnTerminal({
    argv: [shell.path, ...shell.args], cwd, rows: 24, cols: 80,
    terminalType: 'xterm-256color', graceMs: 100,
    env: { DSH_TEST_ZSHRC: '' },
  })
  let output = ''
  handle.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
  try {
    await handle.write('printf \'DSH_ZSH:%s\\nDSH_TERM:%s\\nDSH_CWD:%s\\nDSH_HOME:%s\\nDSH_ZDOTDIR:%s\\nDSH_ZSHRC:%s\\n\' "$ZSH_VERSION" "$TERM" "$PWD" "$HOME" "$ZDOTDIR" "$DSH_TEST_ZSHRC"; exit 0\r')
    const outcome = await handle.done
    expect(outcome.signal).toBeNull()
    expect(outcome.exitCode).toBe(0)
    await finished(handle.output, { cleanup: true })
    expect(output).toMatch(/(?:^|\r?\n)DSH_ZSH:\d+\.\d/u)
    expect(output).toContain(`DSH_TERM:xterm-256color\r\nDSH_CWD:${cwd}\r\n`)
    expect(output).toContain(`DSH_HOME:${home}\r\nDSH_ZDOTDIR:${home}\r\nDSH_ZSHRC:${zshrc}\r\n`)
  } finally {
    await handle.terminate()
    await handle.done
    await finished(handle.output, { cleanup: true })
  }
  expect(() => process.kill(handle.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
}

describe.skipIf(process.platform !== 'darwin')('native macOS shells (requires real /bin/zsh)', { concurrent: false }, () => {
  it('selects SHELL and executes interactive zsh with isolated startup files, TERM and cwd', async () => {
    await withLocalShell(async (runtime, cwd, home) => {
      const signal = new AbortController().signal
      await expect(runtime.terminalEnvironment(signal)).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/zsh' })
      const shell = await resolveShell(runtime, undefined, signal)
      expect(shell).toEqual({ path: '/bin/zsh', name: 'zsh', args: ['-i'] })
      await runZsh(runtime, shell, cwd, home, 'isolated')
    })
  })

  it('uses the real account shell when SHELL is absent or empty', async () => {
    await withLocalShell(async (runtime) => {
      const accountShell = userInfo().shell || undefined
      for (const value of [undefined, '']) {
        if (value === undefined) delete process.env.SHELL
        else process.env.SHELL = value
        await expect(runtime.terminalEnvironment()).resolves.toEqual({
          platform: 'posix', ...accountShell === undefined ? {} : { defaultShell: accountShell },
        })
        const shell = await resolveShell(runtime, undefined, new AbortController().signal)
        expect(shell.path).toBe(await runtime.resolveExecutable(accountShell ?? '/bin/sh'))
      }
    })
  })

  it('honors configured zsh arguments even when the declared default cannot resolve', async () => {
    await withLocalShell(async (runtime, cwd, home) => {
      process.env.SHELL = join(cwd, 'missing-default-shell')
      const signal = new AbortController().signal
      await expect(resolveShell(runtime, undefined, signal)).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
      const configured = { path: '/bin/zsh', name: 'Configured zsh', args: ['-f', '-i'] }
      const shell = await resolveShell(runtime, configured, signal)
      expect(shell).toEqual(configured)
      await runZsh(runtime, shell, cwd, home, '')
    })
  })
})
