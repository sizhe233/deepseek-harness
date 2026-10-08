/** Published carrier import ordering, including transitive emitted chunks and negative controls. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const hook = new URL('./fixtures/carrier-boundary.mjs', import.meta.url).href
const cases = [
  { carrier: 'cli', entry: '../lib/bin.js', business: '../lib/cli-main.js', args: ['custom', '--patch', 'overlay.yml', '--', '--help'] },
  { carrier: 'desktop-cli', entry: '../../desktop-host/lib/cli.js', business: '../../desktop-host/lib/cli-main.js', args: ['plugin', '--profile', 'desktop', 'add', 'example'] },
  { carrier: 'desktop-host', entry: '../../desktop-host/lib/index.js', business: '../../desktop-host/lib/host-main.js', args: ['/runtime', '/profile', '/office', '/pnpm.mjs', '/command-bin'] },
] as const

interface BoundaryObservation {
  pid: number
  boundary: string
  loaded: string[]
  args: [{ carrier: string; entryUrl: string; home: string; runtimeVersion: string; invocation?: { mode: string } }, ...unknown[]]
  argv: string[]
  cwd: string
}

async function runCarrier(test: typeof cases[number], args: readonly string[] = test.args, negative?: string) {
  const entry = new URL(test.entry, import.meta.url)
  const business = new URL(test.business, import.meta.url)
  const child = execa(process.execPath, ['--import', hook, fileURLToPath(entry), ...args], {
    cwd: root, input: '', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
    env: { DSH_TEST_CARRIER_ENTRY: entry.href, DSH_TEST_CARRIER_BUSINESS: business.href,
      DSH_TEST_CARRIER_NEGATIVE: negative ?? '', DSH_HOME: './carrier-test-home' },
  })
  const pid = child.pid
  const result = await child
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, pid }
}

describe('installed application-free carriers', { retry: 0 }, () => {
  it.each(cases)('$carrier loads only its bootstrap dependencies before its fixed business entry', async (test) => {
    const result = await runCarrier(test)
    expect(result.exitCode, result.stderr).toBe(0)
    const observation = JSON.parse(result.stdout) as BoundaryObservation
    expect(observation.pid).toBe(result.pid)
    expect(observation.args[0].carrier).toBe(test.carrier)
    expect(observation.args[0].entryUrl).toBe(new URL(test.entry, import.meta.url).href)
    expect(observation.args[0].runtimeVersion).toBe(
      (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version,
    )
    expect(observation.boundary).toBe(new URL(test.business, import.meta.url).href)
    expect(observation.argv.slice(2)).toEqual(test.args)
    expect(observation.cwd).toBe(root.replace(/[\\/]$/u, ''))
    expect(observation.loaded.some(url => url.endsWith('/runtime-version.js'))).toBe(true)
    expect(observation.loaded.some(url => /\/(?:cli-main|host-main|profile-boot|office|office-engine)\.js$/u.test(url))).toBe(false)
  })

  it('keeps the ordinary exported runCli API repeatable in one process', async () => {
    const test = cases[0]
    const entry = new URL(test.entry, import.meta.url)
    const child = execa(process.execPath, ['--import', hook, '--input-type=module', '--eval', `
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, 'custom'];
      const { runCli } = await import(${JSON.stringify(entry.href)});
      await runCli();
      await runCli();
    `], {
      cwd: root, input: '', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
      env: { DSH_TEST_CARRIER_ENTRY: entry.href, DSH_TEST_CARRIER_BUSINESS: new URL(test.business, import.meta.url).href },
    })
    const result = await child
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const observations = result.stdout.split('\n').map(line => JSON.parse(line) as BoundaryObservation)
    expect(observations).toHaveLength(2)
    expect(observations.map(observation => observation.pid)).toEqual([child.pid, child.pid])
    expect(observations.map(observation => observation.args[0].invocation?.mode)).toEqual(['profile', 'profile'])
  })

  it.each(cases)('$carrier rejects an eager application import in the emitted wrapper', async (test) => {
    const result = await runCarrier(test, test.args, 'entry')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('APPLICATION_BEFORE_BUSINESS: @deepseek-ai/cordis')
    expect(result.stdout).toBe('')
  })

  it.each(cases)('$carrier rejects an eager application import in a transitive emitted bootstrap module', async (test) => {
    const result = await runCarrier(test, test.args, 'transitive')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('APPLICATION_BEFORE_BUSINESS: @deepseek-ai/cordis')
    expect(result.stdout).toBe('')
  })

  it.each(cases.slice(0, 2))('$carrier handles terminal commands without reaching any business entry', async (test) => {
    for (const args of [['--help'], ['--version'], []]) {
      const result = await runCarrier(test, args)
      expect(result.exitCode, result.stderr).toBe(args.length === 0 ? 1 : 0)
      expect(result.stdout).not.toContain('"boundary"')
      expect(result.stderr).not.toContain('APPLICATION_BEFORE_BUSINESS')
    }
  })

  it.each(['--dump-config', '--dump-config-schema', '--dump-default-config'])('preserves non-activating %s dispatch', async (mode) => {
    const result = await runCarrier(cases[0], ['custom', mode])
    expect(result.exitCode, result.stderr).toBe(0)
    const observation = JSON.parse(result.stdout) as BoundaryObservation
    expect(observation.args[0].invocation?.mode).toBe(mode === '--dump-config-schema' ? 'dump-config-schema' : 'dump-config')
  })
})
