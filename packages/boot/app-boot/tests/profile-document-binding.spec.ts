/** Incomplete or stale native document bindings fail before root composition and Include publication. */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { getIncludeDocumentSource } from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  appliedProfileDocuments, bindProfileDocuments, currentProfileDocumentView, markProfileDocumentsApplied,
  mountRootInclude, prepareProfileEntries,
  withProfileDocumentView, type ProfileContext,
} from '../src/index.ts'
import { PluginPackages } from '../src/profile-resolution/service.ts'
import { documentProviderFixture } from './document-provider-fixture.ts'

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const home = resolve('/native/home'), dir = join(home, 'profiles', 'test'), generation = resolve('/native/g')
  const profile: ProfileContext = { name: 'test', home, dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(generation, 'package.json'), cwd: home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const nested = join(profile.dir, 'nested.yml')
  return { ctx, profile, nested, ...documentProviderFixture(profile, [], { [nested]: undefined }) }
}

it('holds a supplied view without registering a document provider and restores the outside context', async () => {
  const f = fixture(), view = f.documents.current()
  expect(currentProfileDocumentView(f.ctx)).toBeUndefined()
  expect(await withProfileDocumentView(f.ctx, view, async () => {
    await Promise.resolve()
    expect(currentProfileDocumentView(f.ctx)).toBe(view)
    return 'held'
  })).toEqual({ value: 'held', view })
  expect(currentProfileDocumentView(f.ctx)).toBeUndefined()
})

it('requires a launcher Profile before binding any native Include authority', () => {
  const f = fixture()
  expect(() => bindProfileDocuments(f.ctx, f.documents)).toThrow('launcher Profile context')
  expect(getIncludeDocumentSource(f.ctx)).toBeUndefined()
})

it.each(['documents', 'profile'] as const)('refuses a managed root with its %s binding missing', async (missing) => {
  const f = fixture()
  await f.ctx.plugin(Loader)
  if (missing === 'documents') f.ctx.provide('profileContext', f.profile)
  else f.ctx.provide('profileDocuments', f.documents)
  await expect(withProfileDocumentView(f.ctx, f.documents.current(), () => mountRootInclude(f.ctx, join(f.profile.dir, 'cordis.yml'))))
    .rejects.toThrow('Managed root Include requires its Profile document binding')
  expect([...f.ctx.loader.entries()]).toEqual([])
})

it('refuses a stale Include handle even if the provider returns a newer snapshot to its derivation', async () => {
  const f = fixture()
  f.ctx.provide('profileContext', f.profile)
  const deriveSnapshot = vi.fn(f.documents.withWriteSnapshot.bind(f.documents))
  bindProfileDocuments(f.ctx, { ...f.documents, withWriteSnapshot: deriveSnapshot })
  const handle = await getIncludeDocumentSource(f.ctx)!.read(f.nested)
  if (handle.writeback !== 'persist') throw new Error('Expected a native publication handle')
  f.external({ [f.nested]: '[]' })
  deriveSnapshot.mockImplementation(async (_request, derive) => {
    await derive(f.documents.current())
    throw new Error('Stale publication must not reach commit')
  })
  await expect(handle.publish('[]')).rejects.toThrow('Include document view changed before publication')
  expect(f.receipts.size).toBe(0)
})

it('keeps the captured native source available while the dynamic ProfileDocuments service is withdrawn', async () => {
  const f = fixture()
  f.ctx.provide('profileContext', f.profile)
  bindProfileDocuments(f.ctx, f.documents)
  f.ctx.set('profileDocuments', undefined)
  expect(currentProfileDocumentView(f.ctx)).toBeUndefined()
  const handle = await getIncludeDocumentSource(f.ctx)!.read(f.nested)
  expect(handle).toMatchObject({ state: 'absent', writeback: 'persist' })
})

it.each([undefined, '{}'])('refuses an absent uninitialized or malformed admitted Include during compatibility preflight', (text) => {
  const f = fixture()
  f.ctx.provide('profileContext', f.profile)
  f.ctx.provide('profileDocuments', f.documents)
  f.external({ [f.nested]: text })
  expect(() => prepareProfileEntries(f.ctx, [{ id: 'nested', name: 'cordis:include', config: { path: './nested.yml' } }],
    pathToFileURL(join(f.profile.dir, 'cordis.yml')).href)).toThrow(text === undefined ? 'config file not found' : 'top-level array')
})

it('rejects simultaneous mutable and admitted package resolution authorities', () => {
  const f = fixture()
  const resolution = { profilesDir: join(f.profile.home, 'profiles'), profileDir: f.profile.dir, entries: [], localPackageNames: [], linkedRoots: [] }
  expect(() => new PluginPackages(f.ctx, { resolution, admitted: { resolution, packageOf: () => undefined } }))
    .toThrow('two runtime resolution authorities')
})

it('records successful application independently of desired publication and of other process roots', () => {
  const f = fixture(), other = fixture(), before = f.documents.current()
  expect(appliedProfileDocuments(f.ctx)).toBeUndefined()
  markProfileDocumentsApplied(f.ctx, before.reference)
  f.external({ [f.nested]: '[]' })
  expect(f.documents.current().reference).not.toBe(before.reference)
  expect(appliedProfileDocuments(f.ctx)).toBe(before.reference)
  expect(appliedProfileDocuments(other.ctx)).toBeUndefined()
  markProfileDocumentsApplied(f.ctx, f.documents.current().reference)
  expect(appliedProfileDocuments(f.ctx)).toBe(f.documents.current().reference)
})

it('uses only the admitted package graph, retains it on refresh, and rejects live graph replacement', async () => {
  const f = fixture()
  const resolution = { profilesDir: join(f.profile.home, 'profiles'), profileDir: f.profile.dir, entries: [], localPackageNames: [], linkedRoots: [] }
  const metadata = { name: 'probe', version: '1.0.0', dir: resolve('/native/g/probe'), manifestPath: resolve('/native/g/probe/package.json'), manifest: {} }
  const packageOf = vi.fn(() => metadata), packages = new PluginPackages(f.ctx, { admitted: { resolution, packageOf } })
  const parent = pathToFileURL(join(f.profile.dir, 'cordis.yml')).href
  expect(packages.packageOf('probe/private', parent)).toBe(metadata)
  expect(packageOf).toHaveBeenCalledExactlyOnceWith('probe/private', parent)
  await packages.refresh()
  expect(() => { packages.replace(resolution) }).toThrow('new process activation')
  expect(packages.packageOf('probe/private', parent)).toBe(metadata)
})
