/** One immutable resolution and byte gate for native ESM and CommonJS call kinds. */
import { createHash } from 'node:crypto'
import Module, { isBuiltin, registerHooks } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Verified regular file in the generation or closed bootstrap capsule. */
export interface RuntimeCodeFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
/** Native admission retains file/security identity; pathname readback cannot replace this capability. */
export interface RuntimeCodeSource {
  read(file: RuntimeCodeFile): Uint8Array
}
/** All paths are native-admitted physical paths; alias roots translate code anchors only. */
export interface RuntimeCodeGateBinding {
  readonly files: readonly RuntimeCodeFile[]
  readonly aliases: readonly Readonly<{ logical: string; physical: string }>[]
  readonly roots: readonly string[]
  /** Exact generation copies sharing the already loaded, identically inventoried bootstrap module instance. */
  /** Exact files permitted to be loaded before application admission. */
  readonly bootstrapFiles?: readonly string[]
  readonly sharedModules?: readonly Readonly<{ generated: string; bootstrap: string }>[]
  readonly source: RuntimeCodeSource
  /** Exact installation-owned preloads already verified by the bootstrap capsule. */
  readonly admittedPreloads?: readonly string[]
}
interface ResolveOptions { paths?: string[]; [key: string]: unknown }
interface NativeCjs {
  _cache: Record<string, Module | undefined>
  _resolveFilename(request: string, parent: Module | undefined, isMain?: boolean, options?: ResolveOptions): string
  _nodeModulePaths(directory: string): string[]
}
const cjsModule = Module as typeof Module & NativeCjs
let installed = false
const inside = (root: string, path: string): boolean => {
  const tail = relative(root, path)
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Install one process-lifetime native call-kind gate. It has no retargeting or disposal operation.
 * @param input Native-admitted immutable inventory, logical code anchors and retained read authority.
 * @returns Read-only inspection for metadata consumers; installing another gate refuses.
 */
export function installRuntimeCodeGate(input: RuntimeCodeGateBinding): Readonly<{ inspect(path: string): RuntimeCodeFile }> {
  if (installed) throw new Error('A runtime code binding is already installed')
  if (/(?:^|\s)(?:--(?:import|require|(?:experimental-)?loader)(?:=|\s|$)|-r(?:\s|$))/u.test(process.env.NODE_OPTIONS ?? '')) {
    throw new Error('Managed runtime requires explicitly inventoried preloads in fixed carrier argv, not NODE_OPTIONS')
  }
  const allowedPreloads = new Set(input.admittedPreloads ?? [])
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]
    if (argument === undefined) continue
    const match = /^(--(?:import|require|(?:experimental-)?loader)|-r)(?:=(.*))?$/u.exec(argument)
    if (match === null) continue
    const target = match[2] ?? process.execArgv[++index]
    if (target === undefined || !allowedPreloads.has(target)) throw new Error('Managed runtime has an unadmitted preload or loader')
  }
  const readSource = input.source.read.bind(input.source)
  const files = new Map(input.files.map(file => [file.path, Object.freeze({ ...file })]))
  const roots = Object.freeze([...input.roots])
  const shared = new Map((input.sharedModules ?? []).map(row => [row.generated, row.bootstrap]))
  if (shared.size !== (input.sharedModules?.length ?? 0)) throw new Error('Duplicate shared bootstrap mapping')
  for (const [generated, bootstrap] of shared) {
    const copy = files.get(generated), original = files.get(bootstrap)
    if (copy === undefined || original === undefined || copy.sha256 !== original.sha256 || copy.bytes !== original.bytes) {
      throw new Error('Shared bootstrap module differs from its inventoried generation copy')
    }
  }
  const sharedPath = (path: string): string => shared.get(path) ?? path
  const aliases = Object.freeze(input.aliases.map(row => Object.freeze({ ...row })).sort((a, b) => b.logical.length - a.logical.length))
  if (files.size !== input.files.length || roots.some(root => !isAbsolute(root) || resolve(root) !== root)
    || aliases.some(row => !isAbsolute(row.logical) || resolve(row.logical) !== row.logical
      || !roots.some(root => inside(root, row.physical)))) throw new Error('Runtime code inventory paths are invalid')
  for (const file of files.values()) {
    if (!isAbsolute(file.path) || resolve(file.path) !== file.path || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/u.test(file.sha256) || !roots.some(root => inside(root, file.path))) throw new Error('Runtime code file is invalid')
  }
  const bootstrapFiles = new Set(input.bootstrapFiles ?? [])
  for (const path of bootstrapFiles) if (!files.has(path)) throw new Error('Bootstrap file is outside the closed inventory')
  const managed = (path: string): boolean => roots.some(root => inside(root, path)) || aliases.some(row => inside(row.logical, path))
  const mapped = (path: string): string => {
    if (bootstrapFiles.has(path)) return path
    if (aliases.some(row => inside(row.physical, path))) return path
    const alias = aliases.find(row => inside(row.logical, path))
    return alias === undefined ? path : join(alias.physical, relative(alias.logical, path))
  }
  for (const path of Object.keys(cjsModule._cache)) {
    if (managed(path) && !bootstrapFiles.has(path)) throw new Error('Application CommonJS code loaded before runtime admission')
  }
  const inspect = (path: string): RuntimeCodeFile => {
    const file = files.get(resolve(path))
    if (file === undefined) throw new Error(`Executable is outside the admitted runtime inventory: ${path}`)
    const bytes = readSource(file)
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Admitted runtime bytes changed: ${path}`)
    return file
  }
  const metadata = [...files.keys()].filter(path => path.endsWith(`${sep}package.json`))
  const metadataByDirectory = new Map(metadata.map(path => [dirname(path), path]))
  const metadataByPackage = new Map<string, Set<string>>()
  for (const path of metadata) {
    const parts = path.split(sep)
    for (const [index, first] of parts.entries()) {
      if (parts[index - 1] !== 'node_modules') continue
      const name = first.startsWith('@') ? `${first}/${parts[index + 1]}` : first
      const key = name.toLowerCase(), paths = metadataByPackage.get(key) ?? new Set<string>()
      paths.add(path); metadataByPackage.set(key, paths)
    }
  }
  const scopeMetadata = (path: string, selected: Set<string>): void => {
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      const manifest = metadataByDirectory.get(directory)
      if (manifest !== undefined) selected.add(manifest)
      if (dirname(directory) === directory) break
    }
  }
  const inspectMetadata = (paths: Iterable<string> = metadata): void => { for (const path of paths) inspect(path) }
  const resolutionMetadata = (request: string, parent: string | undefined, direct: string | undefined): Set<string> => {
    const selected = new Set<string>()
    if (parent !== undefined) scopeMetadata(parent, selected)
    if (direct !== undefined) {
      scopeMetadata(direct, selected)
      // Directory requests can consult main and nested package scopes. Exact files cannot.
      if (!files.has(direct)) for (const path of metadata) if (inside(direct, path)) selected.add(path)
    } else {
      const conventional = /^(?:@[a-zA-Z0-9_.~-]+\/)?[a-zA-Z0-9_.~-]+(?:\/[^\\:#?%]*)?$/u.test(request)
        && !request.split('/').some(part => part === '.' || part === '..')
      const name = conventional ? /^(?:@[^/]+\/)?[^/]+/u.exec(request)?.[0] : undefined
      // Package imports may redirect to another bare package; retain the complete check there.
      if (name === undefined) return new Set(metadata)
      for (const path of metadataByPackage.get(name.toLowerCase()) ?? []) selected.add(path)
    }
    return selected
  }
  inspectMetadata()
  function mappedURL(value: string): string
  function mappedURL(value: string | undefined): string | undefined
  function mappedURL(value: string | undefined): string | undefined {
    if (!value?.startsWith('file:')) return value
    const parsed = new URL(value), result = pathToFileURL(mapped(fileURLToPath(parsed)))
    result.search = parsed.search; result.hash = parsed.hash
    return result.href
  }
  // oxlint-disable-next-line typescript/unbound-method -- Captured native method is invoked with its original receiver below.
  const nativeResolve = cjsModule._resolveFilename
  let delegating = 0
  const replacement: NativeCjs['_resolveFilename'] = function (this: typeof cjsModule, request, parent, isMain, options) {
    if (delegating !== 0) return nativeResolve.call(this, request, parent, isMain, options)
    if (isBuiltin(request)) {
      const result = nativeResolve.call(this, request, parent, isMain, options)
      if (!isBuiltin(result) || result.replace(/^node:/u, '') !== request.replace(/^node:/u, '')) throw new Error('Runtime builtin was redirected')
      return result
    }
    const parentPath = parent?.filename === undefined ? undefined : resolve(parent.filename)
    const direct = isAbsolute(request) ? resolve(request) : undefined
    if (!(parentPath !== undefined && managed(parentPath)) && !(direct !== undefined && managed(direct))) {
      return nativeResolve.call(this, request, parent, isMain, options)
    }
    const physicalParent = parentPath === undefined ? undefined : mapped(parentPath)
    const target = direct === undefined ? request : mapped(direct)
    const requestedPath = direct === undefined
      ? /^\.\.?([/\\]|$)/u.test(request) && physicalParent !== undefined ? resolve(dirname(physicalParent), request) : undefined
      : target
    const checkedMetadata = resolutionMetadata(request, physicalParent, requestedPath)
    inspectMetadata(checkedMetadata)
    const synthetic = physicalParent === undefined ? parent : new Module(physicalParent)
    if (synthetic !== undefined && physicalParent !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- The native CJS synthetic parent retains its original parent chain.
      synthetic.parent = parent?.parent; synthetic.filename = physicalParent
      synthetic.paths = cjsModule._nodeModulePaths(dirname(physicalParent))
    }
    const mappedOptions = options?.paths === undefined ? options : { ...options, paths: options.paths.map((path) => {
      const result = mapped(resolve(path))
      if (!roots.some(root => inside(root, result))) throw new Error('CommonJS lookup escaped the admitted runtime')
      return result
    }) }
    delegating++
    try {
      const result = nativeResolve.call(this, target, synthetic, isMain, mappedOptions)
      const selected = sharedPath(result)
      scopeMetadata(result, checkedMetadata); scopeMetadata(selected, checkedMetadata)
      inspectMetadata(checkedMetadata)
      inspect(selected)
      return selected
    } finally { delegating-- }
  }
  cjsModule._resolveFilename = replacement
  try {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBuiltin(specifier)) {
          const result = nextResolve(specifier, context)
          if (result.url !== (specifier.startsWith('node:') ? specifier : `node:${specifier}`)) throw new Error('Runtime builtin was redirected')
          return result
        }
        const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined
        const direct = specifier.startsWith('file:') ? fileURLToPath(specifier) : isAbsolute(specifier) ? resolve(specifier) : undefined
        if (!(parent !== undefined && managed(parent)) && !(direct !== undefined && managed(direct))) return nextResolve(specifier, context)
        const physicalParent = parent === undefined ? undefined : mapped(parent)
        const requestedPath = direct === undefined
          ? /^\.\.?(\/|$)/u.test(specifier) && physicalParent !== undefined
            ? fileURLToPath(new URL(specifier, pathToFileURL(physicalParent))) : undefined
          : mapped(direct)
        const checkedMetadata = resolutionMetadata(specifier, physicalParent, requestedPath)
        inspectMetadata(checkedMetadata)
        const target = specifier.startsWith('file:') ? mappedURL(specifier) : direct === undefined ? specifier : mapped(direct)
        const result = nextResolve(target, { ...context, parentURL: mappedURL(context.parentURL) })
        if (!result.url.startsWith('file:')) throw new Error('Runtime import has an unadmitted URL scheme')
        const original = fileURLToPath(result.url), selected = sharedPath(original)
        scopeMetadata(original, checkedMetadata); scopeMetadata(selected, checkedMetadata)
        inspectMetadata(checkedMetadata)
        inspect(selected)
        return selected === original ? result : { ...result, url: pathToFileURL(selected).href }
      },
      load(url, context, nextLoad) {
        if (url.startsWith('node:')) {
          const result = nextLoad(url, context)
          if (result.format !== 'builtin' || result.source != null || 'responseURL' in result && result.responseURL !== undefined && result.responseURL !== url) throw new Error('Runtime builtin bytes were replaced')
          return result
        }
        if (!url.startsWith('file:') || !managed(fileURLToPath(url))) return nextLoad(url, context)
        const metadata = new Set<string>()
        scopeMetadata(fileURLToPath(url), metadata); inspectMetadata(metadata)
        const file = inspect(fileURLToPath(url)), result = nextLoad(url, context)
        if ('responseURL' in result && result.responseURL !== undefined && result.responseURL !== url) throw new Error('A loader changed admitted executable identity')
        const source: unknown = result.source
        if (source !== undefined && source !== null) {
          const bytes = typeof source === 'string' ? Buffer.from(source)
            : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
              : source instanceof ArrayBuffer ? new Uint8Array(source) : undefined
          if (bytes === undefined) throw new Error('A loader returned unsupported executable source')
          if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('A loader transformed admitted executable bytes')
        }
        inspectMetadata(metadata); inspect(file.path)
        return result
      },
    })
  } catch (error) { cjsModule._resolveFilename = nativeResolve; throw error }
  installed = true
  return Object.freeze({ inspect })
}
