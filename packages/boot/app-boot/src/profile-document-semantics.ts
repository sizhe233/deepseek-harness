/** Native document semantics after the launcher's immutable code gate is installed. */
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { resolveConfig, type Context, type Plugin } from '@deepseek-ai/cordis'
import Loader, { EntryGroup, ModuleLoader, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { load, dump } from 'js-yaml'
import type { AdmittedPackageGraph } from './runtime-admission.ts'
import type { ProfileDocumentView, ProfileDocumentSnapshot } from './profile-document-view.ts'
import type { ProfileDocumentWrite, ProfileDocumentParticipant } from './profile-documents.ts'
import { parsePatchList } from './patch-list.ts'
import { readProfileManifest, composeEntries, bundlePatchPaths, type ProfileLayer } from './profile.ts'
import { readProfilePatchesFromView, type ProfileContext, type ProfileDocumentLayers } from './profile-context.ts'
import { readProfileCompatibility } from './profile-compatibility.ts'
import { evaluatePluginCompatibility } from './plugin-compatibility.ts'

/** Raw bundle inputs already verified against the immutable generation by the native launcher. */
export interface ProfileDocumentBundleSource {
  readonly packageName: string
  readonly packageDir: string
  readonly manifest: Record<string, unknown>
  readonly patches: readonly { readonly logicalPath: string; readonly text: string }[]
}
/** Current graph and real Host context; other code bindings validate through their own qualified endpoint. */
export interface ProfileDocumentSemanticOptions {
  readonly profile: ProfileContext
  readonly packages: AdmittedPackageGraph
  readonly bundleSources: readonly ProfileDocumentBundleSource[]
  readonly context?: () => Context | undefined
  readonly validateParticipant?: (participant: ProfileDocumentParticipant, writes: readonly ProfileDocumentWrite[]) => Promise<void>
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const expressions = (value: unknown): boolean => isJsExpr(value) || Array.isArray(value) && value.some(expressions)
  || object(value) && Object.values(value).some(expressions)
function entries(value: unknown): EntryOptions[] {
  if (!Array.isArray(value) || value.some(row => !object(row) || typeof row.name !== 'string'
    || row.id !== undefined && typeof row.id !== 'string' || row.group !== undefined && row.group !== null && typeof row.group !== 'boolean')) throw new Error('Native configuration must contain literal plugin entry mappings')
  return value as EntryOptions[]
}

/**
 * Bind ordinary bundle, Include, compatibility and Config semantics to an admitted immutable graph.
 * @param options Native-verified bundle bytes and logical Profile facts; this factory performs no source discovery.
 * @returns Deferred synchronous layers and native publication validation; neither installs a resolver nor mounts plugins.
 */
export function createProfileDocumentSemantics(options: ProfileDocumentSemanticOptions): {
  bundleLayers(view: ProfileDocumentView): ProfileDocumentLayers
  /** Derive generated initial Include documents without opening sources, mounting plugins or evaluating expressions. */
  missingIncludeWrites(view: ProfileDocumentView): Promise<readonly ProfileDocumentWrite[]>
  validatePublication(
    view: ProfileDocumentView, writes: readonly ProfileDocumentWrite[], participants: readonly ProfileDocumentParticipant[],
  ): Promise<void>
} {
  const sources = new Map(options.bundleSources.map(source => [source.packageName, structuredClone(source)]))
  if (sources.size !== options.bundleSources.length) throw new Error('Native bundle inventory contains duplicate package names')
  const bundleLayers = (view: ProfileDocumentView): ProfileDocumentLayers => {
    const manifest = readProfileManifest('dsh', options.profile.dir, view), selected = manifest.dsh?.profile?.bundles ?? []
    if (!Array.isArray(selected) || selected.some(value => typeof value !== 'string') || new Set(selected).size !== selected.length) throw new Error('Profile bundle list is invalid')
    const exemptions = readProfileCompatibility(options.profile.dir, view).exemptions, layers: ProfileLayer[] = []
    for (const packageName of selected) {
      const source = sources.get(packageName)
      if (source === undefined) throw new Error(`Bundle is outside the admitted code graph: ${packageName}`)
      const dsh = source.manifest.dsh, bundle = object(dsh) ? dsh.bundle : undefined
      if (!object(bundle)) throw new Error('Admitted bundle has no native declaration')
      const patch = bundle.patch
      if (typeof patch !== 'string' && (!Array.isArray(patch) || patch.some(path => typeof path !== 'string'))) throw new Error('Admitted bundle patch declaration is invalid')
      const expected = bundlePatchPaths(source.packageDir, { patch: patch as string | string[] })
      if (!isDeepStrictEqual(expected, source.patches.map(row => row.logicalPath))) throw new Error('Native bundle patch inventory differs from its manifest')
      const issue = evaluatePluginCompatibility(source.manifest, exemptions)
      if (issue !== undefined && !issue.exempted) continue
      layers.push({ packageName, packageDir: source.packageDir, patchPaths: [...expected], patches: source.patches.flatMap(row => parsePatchList('dsh', row.logicalPath, row.text, 'bundle patches')) })
    }
    return { ...view.selection, layers }
  }
  const rows = (view: ProfileDocumentView) => composeEntries([readProfilePatchesFromView('dsh', options.profile, view, bundleLayers(view))])
  return {
    bundleLayers,
    async missingIncludeWrites(view) {
      const loader = ModuleLoader.fromInternal()
      if (loader === undefined) throw new Error('Native Include initialization requires the admitted module loader')
      const writes = new Map<string, ProfileDocumentWrite>(), visiting = new Set<string>()
      const initialValues = new Map<string, unknown>()
      let count = 0
      const walk = async (list: EntryOptions[], base: string, depth = 0): Promise<void> => {
        if (depth > 64) throw new Error('Native Include initialization depth exceeds its bound')
        for (const row of list) {
          if (++count > 100_000) throw new Error('Native Include initialization entry count exceeds its bound')
          entries([row])
          if (row.disabled === true && row.group !== true) continue
          if (!row.name.startsWith('cordis:') && options.packages.packageOf(row.name, base) === undefined) throw new Error('Initial Include plugin is outside the admitted code graph')
          const builtins = options.context?.()?.loader.builtins
          const runtime: unknown = row.name === 'cordis:include' ? Include : row.name === 'cordis:group' ? Group
            : row.name.startsWith('cordis:') && builtins !== undefined && Object.hasOwn(builtins, row.name.slice(7)) ? builtins[row.name.slice(7)]
              : Loader.prototype.unwrapExports(await loader.import(row.name, base, {}))
          if (runtime === Group || row.name === '@deepseek-ai/cordis-plugin-group') { await walk(entries(row.config), base, depth + 1); continue }
          if (runtime !== Include && row.name !== '@deepseek-ai/cordis-plugin-include') continue
          if (!object(row.config) || typeof row.config.path !== 'string') throw new Error('Initial Include requires a literal logical path')
          const filename = fileURLToPath(new URL(row.config.path, base)), extension = extname(filename)
          if (!['.json', '.yaml', '.yml'].includes(extension) || visiting.has(filename)) throw new Error('Initial Include format or cycle is unsupported')
          const source = view.read(filename)
          let child: EntryOptions[]
          if (source.state === 'absent') {
            child = entries(row.config.initial)
            const previous = initialValues.get(filename)
            if (previous !== undefined && !isDeepStrictEqual(previous, child)) throw new Error('Missing Include has conflicting initial declarations')
            initialValues.set(filename, structuredClone(child))
            const text = extension === '.json' ? JSON.stringify(child, null, 2) : dump(child, { schema: entryListSchema })
            writes.set(filename, Object.freeze({ logicalPath: filename, expected: source.reference, text }))
          } else child = entries(extension === '.json' ? JSON.parse(source.text) : load(source.text, { schema: entryListSchema }))
          const patches = row.config.patches
          if (patches !== undefined && !Array.isArray(patches)) throw new Error('Initial Include patches must be a literal list')
          visiting.add(filename)
          try { await walk(applyEntryPatches(child, patches as PatchOptions[] | undefined, () => {}), new URL('.', pathToFileURL(filename)).href, depth + 1) }
          finally { visiting.delete(filename) }
        }
      }
      await walk(rows(view), pathToFileURL(join(options.profile.dir, 'cordis.yml')).href)
      return Object.freeze([...writes.values()])
    },
    async validatePublication(view, writes, participants) {
      const changed = new Map<string, ProfileDocumentSnapshot>(writes.map(write => [write.logicalPath, write.state === 'absent'
        ? { logicalPath: write.logicalPath, reference: write.expected, state: 'absent' }
        : { logicalPath: write.logicalPath, reference: write.expected, state: 'present', text: write.text }]))
      const candidate: ProfileDocumentView = { ...view, read: path => changed.get(path) ?? view.read(path) }
      // Strictly parse compatibility before any candidate imports. Revocation retains the normal deny/skip semantics.
      const exemptions = readProfileCompatibility(options.profile.dir, candidate).exemptions
      const loader = ModuleLoader.fromInternal()
      if (loader === undefined) throw new Error('Native schema validation requires the admitted module loader')
      const before = new Map<string, EntryOptions>(), visiting = new Set<string>()
      let count = 0
      const key = (base: string, row: EntryOptions) => JSON.stringify([base, row.id, row.name])
      const walk = async (
        list: EntryOptions[], base: string, snapshot: ProfileDocumentView, validate: boolean, depth = 0,
      ): Promise<void> => {
        if (depth > 64) throw new Error('Native configuration depth exceeds its bound')
        for (const row of list) {
          if (++count > 200_000) throw new Error('Native configuration entry count exceeds its bound')
          entries([row])
          const identity = key(base, row)
          if (!validate) before.set(identity, row)
          if (row.disabled === true && row.group !== true) continue
          const metadata = row.name.startsWith('cordis:') ? undefined : options.packages.packageOf(row.name, base)
          if (!row.name.startsWith('cordis:') && metadata === undefined) throw new Error(`Plugin is outside the admitted fixed graph: ${row.name}`)
          const issue = metadata === undefined ? undefined : evaluatePluginCompatibility(metadata.manifest, exemptions)
          if (issue !== undefined && !issue.exempted) continue
          const builtins = options.context?.()?.loader.builtins
          const builtin: unknown = row.name === 'cordis:include' ? Include : row.name === 'cordis:group' ? Group
            : row.name.startsWith('cordis:') && builtins !== undefined && Object.hasOwn(builtins, row.name.slice(7))
              ? builtins[row.name.slice(7)] : undefined
          if (row.name.startsWith('cordis:') && builtin === undefined) throw new Error('Native builtin requires its admitted Host registration')
          const runtime: unknown = builtin ?? Loader.prototype.unwrapExports(await loader.import(row.name, base, {}))
          const nativeInclude = runtime === Include || row.name === '@deepseek-ai/cordis-plugin-include'
          const nativeGroup = runtime === Group || row.name === '@deepseek-ai/cordis-plugin-group'
          if (nativeInclude) {
            if (!object(row.config) || typeof row.config.path !== 'string') throw new Error('Native Include requires a literal logical path')
            const filename = fileURLToPath(new URL(row.config.path, base))
            if (visiting.has(filename)) throw new Error('Native Include cycle is invalid')
            const source = snapshot.read(filename)
            const child = source.state === 'absent' ? entries(row.config.initial) : entries(extname(filename) === '.json' ? JSON.parse(source.text) : load(source.text, { schema: entryListSchema }))
            const patches = row.config.patches
            if (patches !== undefined && !Array.isArray(patches)) throw new Error('Native Include patches must be a literal list')
            visiting.add(filename)
            try { await walk(applyEntryPatches(child, patches as PatchOptions[] | undefined, () => {}), new URL('.', pathToFileURL(filename)).href, snapshot, validate, depth + 1) }
            finally { visiting.delete(filename) }
          } else if (nativeGroup) await walk(entries(row.config), base, snapshot, validate, depth + 1)
          else if (runtime !== null && (typeof runtime === 'object' || typeof runtime === 'function') && Reflect.get(runtime, EntryGroup.key)) throw new Error('Unrecognized native tree carrier requires explicit schema admission')
          else if (validate) {
            const previous = before.get(identity)
            if (expressions(row.config)) {
              const live = [...options.context?.()?.loader.entries() ?? []].find(entry => entry.options.id === row.id
                && entry.options.name === row.name && entry.parent.tree.ctx.baseUrl === new URL('.', base).href)
              if (live?.fiber?.runtime !== undefined && live.fiber.runtime !== null) {
                const raw: unknown = row.config
                const config: unknown = live.fiber.ctx.waterfall(live.fiber, 'internal/config', raw, () => raw)
                resolveConfig(live.fiber.runtime, config)
              } else if (!previous || !isDeepStrictEqual(previous.config, row.config) || previous.disabled !== row.disabled) throw new Error('Changed dynamic configuration requires its real native Host context')
            } else resolveConfig(runtime as Plugin.Runtime, row.config)
          }
        }
      }
      const base = pathToFileURL(join(options.profile.dir, 'cordis.yml')).href
      await walk(rows(view), base, view, false)
      await walk(rows(candidate), base, candidate, true)
      if (writes.some(write => write.logicalPath === join(options.profile.home, 'cordis.patch.yml')
        || participants.some(participant => participant.homeDocuments.some(document => document.logicalPath === write.logicalPath)))) {
        if (participants.length && options.validateParticipant === undefined) throw new Error('Shared Home publication requires each participant’s admitted code and schema validator')
        for (const participant of participants) await options.validateParticipant?.(participant, writes)
      }
    },
  }
}
