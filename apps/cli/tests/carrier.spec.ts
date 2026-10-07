/** The fixed carrier descriptors retain native arguments without reading or initializing profiles. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot/runtime-version'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCarrierLaunch } from '../src/carrier.ts'
import { parseDshArgumentResult } from '../src/args.ts'

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function argv(...args: string[]): void {
  process.argv = [process.execPath, '/installation/bin.js', ...args]
}

describe('application-free carrier descriptions', () => {
  it.each(['cli', 'desktop-cli'] as const)('parses %s once with exact forwarded arguments and a literal Home', (carrier) => {
    argv('custom', '--from-default-profile', 'web', '--patch', 'first.yml', '--patch', 'second.yml', '--', '--help')
    vi.stubEnv('DSH_HOME', './relative-home')
    expect(prepareCarrierLaunch({ carrier, entryUrl: 'file:///installation/bin.js' })).toEqual({
      carrier, entryUrl: 'file:///installation/bin.js', home: resolve('./relative-home'), runtimeVersion: getDshRuntimeVersion(),
      invocation: { mode: 'profile', profile: 'custom', fromDefaultProfile: 'web', patches: ['first.yml', 'second.yml'], args: ['--help'] },
    })
  })

  it('preserves Desktop Host positional meanings and the shared Desktop plugin profile identity', () => {
    vi.stubEnv('DSH_HOME', '~/carrier-home')
    argv('/runtime', '/profile', '/office', '/pnpm.mjs', '/command-bin')
    expect(prepareCarrierLaunch({ carrier: 'desktop-host', entryUrl: 'file:///installation/index.js' })).toEqual({
      carrier: 'desktop-host', entryUrl: 'file:///installation/index.js', home: join(homedir(), 'carrier-home'),
      runtimeVersion: getDshRuntimeVersion(), profile: 'desktop', runtimeDir: '/runtime', projectDir: '/profile',
      officeSource: '/office', packageManagerPath: '/pnpm.mjs', commandPath: '/command-bin',
    })
    argv('plugin', '--profile', 'Desktop', 'add', 'example')
    expect(prepareCarrierLaunch({ carrier: 'desktop-cli', entryUrl: 'file:///installation/cli.js', manageDesktopProfile: true }))
      .toMatchObject({ carrier: 'desktop-cli', home: join(homedir(), 'carrier-home'), invocation: { mode: 'plugin', profile: 'desktop' } })
  })

  it.each([
    ['custom', '--from-default-profile', 'web', '--dump-config'],
    ['custom', '--dump-config-schema'],
    ['custom', '--dump-default-config'],
    ['plugin', '--profile', 'custom', 'add', 'example'],
  ])('does not initialize a Home or profile while describing %j', (...args) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-carrier-descriptor-'))
    try {
      const home = join(root, 'uninitialized')
      vi.stubEnv('DSH_HOME', home)
      argv(...args)
      prepareCarrierLaunch({ carrier: 'cli', entryUrl: 'file:///installation/bin.js' })
      expect(existsSync(home)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the real installation version and exits before loading a runner', () => {
    argv('--version')
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('terminal') })
    expect(() => prepareCarrierLaunch({ carrier: 'cli', entryUrl: 'file:///installation/bin.js' })).toThrow('terminal')
    expect(output).toHaveBeenCalledExactlyOnceWith(`${getDshRuntimeVersion()}\n`)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })
})

describe('terminal argument decisions', () => {
  it('captures output and status without writing or exiting', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit') })
    expect(parseDshArgumentResult(['--version'], '1.2.3')).toEqual({
      kind: 'terminal', exitCode: 0, output: [{ stream: 'stdout', text: '1.2.3\n' }],
    })
    expect(parseDshArgumentResult([], '1.2.3')).toEqual({
      kind: 'terminal', exitCode: 1, output: [{ stream: 'stderr', text: 'error: --profile <name> is required\n' }],
    })
    const help = parseDshArgumentResult(['--help'], '1.2.3')
    expect(help.kind).toBe('terminal')
    if (help.kind !== 'terminal') throw new Error('expected terminal help')
    expect(help.exitCode).toBe(0)
    expect(help.output.map(write => write.stream)).toEqual(['stdout', 'stdout'])
    expect(help.output[0]?.text).toContain('Usage: dsh')
    expect(help.output[1]?.text).toContain('Examples:')
    expect(out).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})

interface TerminalFixture {
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
}

const terminalFixtures = JSON.parse(readFileSync(new URL('./expected/carrier-terminal.json', import.meta.url), 'utf8')) as TerminalFixture[]

it.each(terminalFixtures)('retains the installed terminal output for $args', ({ args, exitCode, stdout, stderr }) => {
  const result = parseDshArgumentResult(args, getDshRuntimeVersion())
  expect(result.kind).toBe('terminal')
  if (result.kind !== 'terminal') throw new Error('expected a terminal decision')
  expect(result.exitCode).toBe(exitCode)
  expect(result.output.filter(write => write.stream === 'stdout').map(write => write.text).join('')).toBe(stdout)
  expect(result.output.filter(write => write.stream === 'stderr').map(write => write.text).join('')).toBe(stderr)
})
