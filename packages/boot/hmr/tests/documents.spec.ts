/** Native revision notifications reconcile the real HMR/Include tree without original-file watches. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { appliedProfileDocuments, bindProfileDocuments, boot, readProfilePatchesFromView, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { FSWatcher } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'
import { documentProviderFixture } from '../../app-boot/tests/document-provider-fixture.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => { const watcher = new native.FSWatcher(); watchers.push(watcher); queueMicrotask(() => watcher.emit('ready')); return watcher } }
})

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hmr-documents-')), dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  const profile: ProfileContext = { name: 'test', home, dir, cwd: home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const root = join(dir, 'cordis.yml'), nested = join(dir, 'nested.yml')
  writeFileSync(root, 'root poison: ['); writeFileSync(profile.patchPath, 'patch poison: ['); writeFileSync(nested, 'include poison: [')
  const provider = documentProviderFixture(profile, [{ insert: [
    { id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'probe', name: 'cordis:probe', config: { value: 'initial' } },
    { id: 'nested', name: 'cordis:include', config: { path: './nested.yml' } },
  ] }], { [nested]: '- id: child\n  name: cordis:child\n  config: { value: first }\n' })
  let ready: (() => void) | undefined
  const applications: string[] = []
  const start = watchers.length
  const ctx = await boot('fixture', root, readProfilePatchesFromView('fixture', profile, provider.documents.current(), provider.documents.bundleLayers(provider.documents.current())), (ctx) => {
    ctx.provide('profileContext', profile); bindProfileDocuments(ctx, provider.documents)
    ctx.provide('appReady', { onReady(listener) { ready = listener; return () => { ready = undefined } } })
    ctx.loader.builtins.timer = Timer; ctx.loader.builtins.hmr = Hmr
    ctx.loader.builtins.probe = { apply(_ctx: Context, config: { value: string }) { applications.push(config.value) } }
    ctx.loader.builtins.child = { apply(ctx: Context, config: { value: string }) { ctx.provide('childValue', config.value) } }
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  return { ...provider, profile, root, nested, ctx, applications, watchers: watchers.slice(start),
    ready: () => ready?.(), drain: () => ctx.hmr.runExclusive(async () => {}),
  }
}

it('waits for readiness, observes latest revisions once and refreshes nested documents from that same view', async () => {
  const f = await fixture()
  expect(f.watchers).toHaveLength(1)
  f.external({ [f.profile.patchPath]: '- id: probe\n  config: { value: edited }\n', [f.nested]: '- id: child\n  name: cordis:child\n  config: { value: second }\n' })
  expect(f.applications).toEqual(['initial'])
  f.ready(); await f.drain()
  expect(f.applications).toEqual(['initial', 'edited'])
  expect(f.ctx.get('childValue')).toBe('second')
  expect(appliedProfileDocuments(f.ctx)).toBe(f.documents.current().reference)
  f.notify(); f.notify(); await f.drain()
  expect(f.applications).toEqual(['initial', 'edited'])
  expect(readFileSync(f.root, 'utf8')).toBe('root poison: [')
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe('patch poison: [')
})

it('does not acknowledge invalid desired views and resumes after a later valid revision', async () => {
  const f = await fixture(); f.ready(); await f.drain()
  const applied = appliedProfileDocuments(f.ctx)
  f.external({ [f.nested]: 'invalid: [' }); await f.drain()
  expect(appliedProfileDocuments(f.ctx)).toBe(applied)
  expect(f.ctx.get('childValue')).toBe('first')
  f.external({ [f.nested]: '- id: child\n  name: cordis:child\n  config: { value: recovered }\n' }); await f.drain()
  expect(f.ctx.get('childValue')).toBe('recovered')
  expect(appliedProfileDocuments(f.ctx)).toBe(f.documents.current().reference)
})

it('unsubscribes before its own removal without awaiting the active HMR operation', async () => {
  const f = await fixture(); f.ready(); await f.drain()
  const hmr = f.ctx.hmr
  f.external({ [f.profile.patchPath]: '- id: hmr\n  disabled: true\n' })
  await expect(hmr.runExclusive(async () => {})).rejects.toThrow('disposed')
  expect(f.listeners.size).toBe(0)
  expect(f.ctx.get('hmr')).toBeUndefined()
})
