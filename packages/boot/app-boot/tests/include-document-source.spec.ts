/** Real Include composition reads logical native snapshots, including initialization and disposal. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished } from 'vitest'
import { bindProfileDocuments, boot, readProfilePatchesFromView, withProfileDocumentView, type ProfileContext } from '../src/index.ts'
import { documentProviderFixture } from './document-provider-fixture.ts'

async function fixture(initial?: string, absent = false) {
  const home = mkdtempSync(join(tmpdir(), 'include-documents-'))
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  const profile: ProfileContext = { name: 'test', home, dir, cwd: home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const root = join(dir, 'cordis.yml'), nested = join(dir, 'nested.yml')
  writeFileSync(root, 'root poison: [')
  if (!absent) writeFileSync(nested, 'nested poison: [')
  writeFileSync(join(dir, 'probe.mjs'), 'export function apply(ctx, config) { ctx.provide("includedProbe", config) }\n')
  const provider = documentProviderFixture(profile, [{ insert: [{
    id: 'nested', name: 'cordis:include', config: { path: './nested.yml',
      ...absent ? { initial: [{ id: 'probe', name: './probe.mjs', config: { value: 'initial' } }] } : {},
    },
  }] }], { [nested]: absent ? undefined : initial ?? '- id: probe\n  name: ./probe.mjs\n  config: { value: !!js ctx.baseUrl }\n' })
  const ctx = await boot('fixture', root, readProfilePatchesFromView('fixture', profile, provider.documents.current(), provider.documents.bundleLayers(provider.documents.current())), (ctx) => {
    ctx.provide('profileContext', profile); bindProfileDocuments(ctx, provider.documents)
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const include = [...ctx.loader.entries()].find(row => row.options.id === 'nested')!.subtree as Include
  return { ...provider, ctx, profile, root, nested, include }
}

it('mounts nested snapshots with native logical relative modules and !!js bases while poisoned originals survive stop', async () => {
  const f = await fixture()
  expect(f.ctx.get('includedProbe')).toEqual({ value: pathToFileURL(f.profile.dir).href + '/' })
  expect(f.include.filename).toBe(f.nested)
  await f.ctx.fiber.dispose()
  expect(readFileSync(f.root, 'utf8')).toBe('root poison: [')
  expect(readFileSync(f.nested, 'utf8')).toBe('nested poison: [')
  expect(existsSync(f.nested + '.tmp')).toBe(false)
})

it('creates a missing managed Include through native publication without creating the original file', async () => {
  const f = await fixture(undefined, true)
  expect(f.ctx.get('includedProbe')).toEqual({ value: 'initial' })
  expect(f.contents.get(f.nested)).toContain('value: initial')
  expect(f.receipts.size).toBe(1)
  expect(existsSync(f.nested)).toBe(false)
  await f.ctx.fiber.dispose()
  expect(existsSync(f.nested)).toBe(false)
})

it('surfaces managed invalid refresh and retains its old tree without reopening the original', async () => {
  const f = await fixture()
  const previous: unknown = f.ctx.get('includedProbe')
  f.external({ [f.nested]: 'invalid: [' })
  await expect(f.include.refresh()).rejects.toThrow()
  expect(f.ctx.get('includedProbe')).toEqual(previous)
  expect(readFileSync(f.nested, 'utf8')).toBe('nested poison: [')
})

it('writes a nested Loader update through its captured revision and keeps the original untouched', async () => {
  const f = await fixture('- id: probe\n  name: ./probe.mjs\n  config: { value: first }\n')
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'probe')!
  await entry.update({ disabled: true })
  f.include.write()
  await f.include.stop()
  expect(f.contents.get(f.nested)).toContain('disabled: true')
  expect(readFileSync(f.nested, 'utf8')).toBe('nested poison: [')
  expect(readFileSync(f.root, 'utf8')).toBe('root poison: [')
})

it('holds the exact snapshot through asynchronous reconciliation even when the provider advances', async () => {
  const f = await fixture('- id: probe\n  name: ./probe.mjs\n  config: { value: held }\n')
  const held = f.documents.current()
  await withProfileDocumentView(f.ctx, held, async () => {
    f.external({ [f.nested]: 'invalid: [' })
    await Promise.resolve()
    await f.include.refresh()
  })
  expect(f.ctx.get('includedProbe')).toEqual({ value: 'held' })
  await expect(f.include.refresh()).rejects.toThrow()
})

it('refuses changing an overlay-owned field through nested source write-back', async () => {
  const f = await fixture('- id: probe\n  name: ./probe.mjs\n  config: { value: source }\n')
  f.include.config.patches = [{ id: 'probe', config: { value: 'overlay' } }]
  f.include.write()
  await expect(f.include.stop()).rejects.toThrow('owned by a patch')
  expect(f.receipts.size).toBe(0)
  expect(f.contents.get(f.nested)).toContain('value: source')
  expect(readFileSync(f.nested, 'utf8')).toBe('nested poison: [')
})

it('derives source-owned nested edits without baking patches or losing YAML comments and expressions', async () => {
  const f = await fixture('# retained source comment\n- id: probe\n  name: ./probe.mjs\n  config: { value: !!js ctx.baseUrl }\n')
  f.include.config.patches = [{ id: 'probe', config: { value: 'overlay' } }]
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'probe')!
  await entry.update({ config: { value: 'overlay' }, disabled: true })
  f.include.write()
  await f.include.stop()
  expect(f.contents.get(f.nested)).toContain('# retained source comment')
  expect(f.contents.get(f.nested)).toContain('!!js ctx.baseUrl')
  expect(f.contents.get(f.nested)).toContain('disabled: true')
  expect(f.contents.get(f.nested)).not.toContain('overlay')
  expect(readFileSync(f.nested, 'utf8')).toBe('nested poison: [')
})
