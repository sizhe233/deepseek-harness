/** Exact terminal bytes from the built CLI, before profile initialization or runner imports. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface TerminalFixture {
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
}

const fixtures = JSON.parse(readFileSync(new URL('./expected/carrier-terminal.json', import.meta.url), 'utf8')) as TerminalFixture[]
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const runnerMarker = 'TERMINAL_COMMAND_LOADED_RUNNER'
const rejectRunner = `data:text/javascript,${encodeURIComponent(String.raw`
  import { registerHooks } from 'node:module';
  registerHooks({ load(url, context, nextLoad) {
    if (/\/(?:cli-main|profile-boot)\.js$/u.test(url)) throw new Error('${runnerMarker}');
    return nextLoad(url, context);
  } });
`)}`

let directory: string
let home: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-carrier-terminal-'))
  home = join(directory, 'uninitialized')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

async function terminal(args: readonly string[]) {
  const result = await execa(process.execPath, ['--import', rejectRunner, bin, ...args], {
    cwd: directory, input: '', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
    stripFinalNewline: false, extendEnv: false,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory, USERPROFILE: directory,
      DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
  })
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(existsSync(home)).toBe(false)
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

describe('built carrier terminal output', { retry: 0 }, () => {
  it.each(fixtures)('matches the pure parser fixture for $args', async ({ args, ...expected }) => {
    expect(await terminal(args)).toEqual(expected)
  })

  it.each(['-h', '--help'])('prints plugin %s before requiring a profile', async (flag) => {
    const expected = fixtures.find(fixture => fixture.args.join(' ') === 'plugin --help')
    if (expected === undefined) throw new Error('missing plugin help fixture')
    expect(await terminal(['plugin', flag])).toEqual({
      exitCode: 0, stdout: expected.stdout, stderr: '',
    })
  })

  it.each(['-V', '--version'])('prints the installation version for %s', async (flag) => {
    expect(await terminal([flag])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: '' })
  })

  it('detects a command that reaches the runner', async () => {
    const result = await terminal(['custom'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`Error: ${runnerMarker}`)
  })
})
