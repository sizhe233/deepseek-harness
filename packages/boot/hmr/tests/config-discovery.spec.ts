import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import { watchConfig } from '../src/watch-config.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>()
  return { ...native, stat: vi.fn(native.stat) }
})
vi.mock('chokidar', async (importOriginal) => {
  const native = await importOriginal<typeof import('chokidar')>()
  return { ...native, watch: vi.fn((_paths: string | string[], options?: ChokidarOptions) => {
    // A completed empty scan with no later directory notifications, as when
    // fs.watchFile's first baseline includes a child created after that scan.
    const watcher = new native.FSWatcher(options)
    Reflect.set(watcher, '_readyEmitted', true)
    queueMicrotask(() => { watcher.emit('ready') })
    return watcher
  }) }
})

async function fixture(options: ChokidarOptions = {}) {
  const root = await realpath(mkdtempSync(join(tmpdir(), 'dsh-hmr-discovery-')))
  const filename = join(root, 'later', 'plugins.yml')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const refresh = vi.fn()
  const dispose = await watchConfig(ctx, filename, options, refresh)
  const watcher = vi.mocked(watch).mock.results.at(-1)!.value as FSWatcher
  return { root, filename, ctx, refresh, watcher, dispose }
}

it.each([false, true])('discovers and stabilizes an exact file without directory events (polling: %s)', async (usePolling) => {
  const { root, filename, refresh, watcher, dispose } = await fixture({ usePolling })
  const enrolled = Promise.withResolvers<undefined>()
  const stabilize = vi.spyOn(watcher, '_awaitWriteFinish')
  const add = watcher.add.bind(watcher)
  vi.spyOn(watcher, 'add').mockImplementation((paths) => {
    expect(paths).toBe(filename)
    enrolled.resolve(undefined)
    return add(paths)
  })
  const delivered = Promise.withResolvers<string>()
  refresh.mockImplementation(() => { delivered.resolve(readFileSync(filename, 'utf8')) })
  mkdirSync(join(root, 'later'))
  writeFileSync(filename, 'partial')
  await enrolled.promise
  expect(refresh).not.toHaveBeenCalled()
  writeFileSync(filename, 'complete configuration')
  expect(await delivered.promise).toBe('complete configuration')
  expect(stabilize).toHaveBeenCalledOnce()
  expect(watcher._closers.get(filename)).toHaveLength(1)
  expect(watcher.getWatched()[join(root, 'later')]).toEqual(['plugins.yml'])
  await dispose()
  expect(watcher.getWatched()).toEqual({})
  expect(refresh).toHaveBeenCalledOnce()
})

it('keeps discovery scoped to a file and stops polling after its first event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { root, filename, refresh, watcher, dispose } = await fixture()
  const directory = await stat(root)
  const missing = Object.assign(new Error('not present yet'), { code: 'ENOENT' })
  const read = vi.mocked(stat).mockRejectedValueOnce(missing).mockResolvedValueOnce(directory)
  const add = vi.spyOn(watcher, 'add')
  await vi.advanceTimersByTimeAsync(50)
  await vi.advanceTimersByTimeAsync(50)
  expect(add).not.toHaveBeenCalled()
  watcher.emit('add', join(root, 'unrelated.yml'))
  expect(refresh).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  watcher.emit('add', filename)
  expect(refresh).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  read.mockClear()
  await vi.advanceTimersByTimeAsync(500)
  expect(read).not.toHaveBeenCalled()
  await dispose()
})

it.each(['dispose', 'event'] as const)('does not enroll a late stat result after %s stops discovery', async (stop) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { root, filename, refresh, watcher, dispose } = await fixture()
  const sample = join(root, 'sample.yml')
  writeFileSync(sample, 'present')
  const stats = await stat(sample)
  const pending = Promise.withResolvers<typeof stats>()
  vi.mocked(stat).mockReturnValueOnce(pending.promise)
  const add = vi.spyOn(watcher, 'add')
  const close = vi.spyOn(watcher, 'close')
  await vi.advanceTimersByTimeAsync(50)
  let disposed = false
  const disposal = stop === 'dispose' ? dispose().then(() => { disposed = true }) : undefined
  if (stop === 'event') watcher.emit('add', filename)
  await Promise.resolve()
  expect(close).toHaveBeenCalledTimes(stop === 'dispose' ? 1 : 0)
  if (stop === 'dispose') watcher.emit('change', filename)
  expect(refresh).toHaveBeenCalledTimes(stop === 'dispose' ? 0 : 1)
  expect(disposed).toBe(false)
  pending.resolve(stats)
  await disposal
  await vi.advanceTimersByTimeAsync(500)
  expect(add).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await dispose()
})

it('reports discovery failure once and releases the timer and registration', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { filename, ctx, refresh, watcher, dispose } = await fixture()
  const failure = Object.assign(new Error('config access denied'), { code: 'EACCES' })
  vi.mocked(stat).mockRejectedValueOnce(failure)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const add = vi.spyOn(watcher, 'add')
  await vi.advanceTimersByTimeAsync(50)
  expect(warn).toHaveBeenCalledExactlyOnceWith(failure)
  expect(add).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await dispose()
  const next = await watchConfig(ctx, filename, {}, refresh)
  await next()
  expect(vi.getTimerCount()).toBe(0)
})
