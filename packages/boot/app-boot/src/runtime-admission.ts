/** Application-free carrier admission. Providers are installed by the fixed security capsule. */
import { lstatSync } from 'node:fs'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { Worker, isMainThread, workerData, type WorkerOptions } from 'node:worker_threads'
import { join, isAbsolute, normalize } from 'node:path'
import { registerRuntimeOuterCapability, runtimeOuterCapability } from './runtime-outer-bootstrap.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Profile, RuntimeResolution } from './profile.ts'
import type { ProfileDocuments } from './profile-documents.ts'
import type { PluginPackage } from './profile-resolution/service.ts'

/** Installation-owned process entry; business module names are never supplied by browser requests. */
export type RuntimeCarrierId = 'cli' | 'desktop-cli' | 'desktop-host'
/** An already parsed invocation. Admission does not parse or rewrite arguments. */
export interface RuntimeAdmissionRequest {
  readonly carrier: RuntimeCarrierId
  readonly entryUrl: string
  readonly home: string
  readonly profile: string
  readonly mode: 'application' | 'inspection' | 'package' | 'offline'
  /** Fixed invocation overlays, in original order; admitted as configuration snapshots. */
  readonly patches?: readonly string[]
  /** Native serialized initialization retains the existing explicit template request. */
  readonly fromDefaultProfile?: string
}
/** Read-only metadata supplied by the same gate that resolves and validates executable bytes. */
export interface AdmittedPackageGraph {
  readonly resolution: RuntimeResolution
  packageOf(specifier: string, parentURL: string): PluginPackage | undefined
}
/** Physical resources verified with an installed Desktop carrier; data locations remain logical. */
export interface RuntimeCarrierResources {
  readonly runtimeDir: string
  readonly supportDir: string
  readonly officeSource: string
  readonly packageManagerPath: string
  readonly commandPath: string
}
/** One generation and document view retained for the lifetime of this process. */
export interface ManagedRuntimeAdmission {
  readonly status: 'managed'
  readonly bindingId: string
  readonly request: RuntimeAdmissionRequest
  readonly profile: Profile
  readonly installAnchor: string
  readonly documents: ProfileDocuments
  readonly packages: AdmittedPackageGraph
  readonly carrierResources?: RuntimeCarrierResources
  readonly workers?: RuntimeWorkerAuthority
  /** Install the single immutable ESM/CJS gate before importing any business module. */
  installResolution(): void
  /** Supply admitted Host capabilities before any plugin or Include mounts. */
  provideServices(ctx: Context): void | Promise<void>
  /** Bind the carrier's existing graceful process shutdown before any plugin mounts. */
  bindShutdown?(shutdown: () => void): void
  /** Validate real carrier readiness, durably commit any activation, then open its native admission gate. */
  ready(facts: Readonly<{ carrier: RuntimeCarrierId; applicationEntry: string }>): Promise<void>
  /** Retain uncertain activation and closed admission on failure; never infer process death. */
  failed(error: unknown): void | Promise<void>
}
/** Missing or failed native discovery is distinct from a positively absent enrollment. */
export type RuntimeAdmission = Readonly<{ status: 'unenrolled' }> | Readonly<{ status: 'blocked'; reason: string }> | ManagedRuntimeAdmission
/** The fixed bootstrap capsule owns native locator discovery, selectors, code inventory and process leases. */
export interface RuntimeAdmissionProvider {
  admit(request: RuntimeAdmissionRequest): Promise<RuntimeAdmission>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Actual fixed-carrier qualification, present before any business plugin mounts. */
    runtimeAdmission: Exclude<RuntimeAdmission, { status: 'blocked' }>
  }
}
let provider: RuntimeAdmissionProvider | undefined
let started = false
let current: Exclude<RuntimeAdmission, { status: 'blocked' }> | undefined
const admitted = new WeakSet<ManagedRuntimeAdmission>()
const failed = new WeakSet<ManagedRuntimeAdmission>()

/**
 * Install one provider from the installation-owned bootstrap capsule before the first admission.
 * @param value Already bound native provider; caller paths and environment strings are not providers.
 */
export function installRuntimeAdmissionProvider(value: RuntimeAdmissionProvider): void {
  if (started || provider !== undefined) throw new Error('Runtime admission provider is already fixed')
  provider = Object.freeze({ admit: value.admit.bind(value) })
}

/**
 * Establish absence without reading an enrollment, following a reparse object, or creating Home state.
 * A present management root requires the native provider even when its index is missing or inaccessible.
 * @param home Literal Home selected by the existing application-free grammar.
 * @returns Positive absence, or a diagnostic requiring native discovery.
 */
export function inspectUnenrolledRuntime(home: string): RuntimeAdmission {
  try {
    lstatSync(join(home, 'runtime-management'))
    return Object.freeze({ status: 'blocked', reason: 'Runtime management exists; the fixed native admission provider is required' })
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return Object.freeze({ status: 'unenrolled' })
    }
    return Object.freeze({ status: 'blocked', reason: `Runtime enrollment discovery failed: ${String(error)}` })
  }
}

/**
 * Qualify the exact carrier and install its frozen code gate before business imports.
 * @param input Descriptor from the fixed carrier and its existing argument grammar.
 * @returns Native managed binding or positive absence; blocked/mismatched admission throws.
 */
export async function admitRuntimeCarrier(input: RuntimeAdmissionRequest): Promise<Exclude<RuntimeAdmission, { status: 'blocked' }>> {
  if (started) throw new Error('This process already admitted a runtime carrier')
  started = true
  const request = Object.freeze({ ...input })
  const result = provider === undefined ? inspectUnenrolledRuntime(request.home) : await provider.admit(request)
  if (result.status === 'blocked') throw new Error(result.reason)
  if (result.status === 'unenrolled') { current = result; return result }
  try {
    for (const key of ['carrier', 'entryUrl', 'home', 'profile', 'mode'] as const) {
      if (result.request[key] !== request[key]) throw new Error('Runtime admission belongs to another carrier invocation')
    }
    if (request.carrier !== 'cli' && result.carrierResources === undefined) throw new Error('Managed Desktop requires admitted physical carrier resources')
    const view = result.documents.current(), selection = result.documents.selection
    if (result.bindingId !== selection.codeBinding || view.selection.codeBinding !== selection.codeBinding
      || view.selection.packageDocuments !== selection.packageDocuments || view.selection.profileDir !== result.profile.dir
      || selection.profileDir !== result.profile.dir || view.selection.home !== request.home || selection.home !== request.home
      || result.profile.name !== request.profile) throw new Error('Runtime admission code and document selections differ')
    result.installResolution()
    Object.freeze(result)
    admitted.add(result)
    current = result
    return result
  } catch (error) {
    await result.failed(error)
    throw error
  }
}

/**
 * Require the actual opaque result issued to this process, rather than a structurally similar object.
 * @param value Carrier-owned admission forwarded to profile boot.
 * @returns The same admitted capability.
 */
export function requireManagedRuntimeAdmission(value: ManagedRuntimeAdmission): ManagedRuntimeAdmission {
  if (!admitted.has(value)) throw new Error('Managed runtime binding was not admitted before the business import')
  return value
}

export { installRuntimeCodeGate, type RuntimeCodeGateBinding, type RuntimeCodeFile, type RuntimeCodeSource } from './runtime-code-gate.ts'

/**
 * Read this process's opaque admission for boot-free dump/package consumers.
 * @returns The already admitted binding, or undefined for an explicitly custom/source consumer.
 */
export function currentRuntimeAdmission(): Exclude<RuntimeAdmission, { status: 'blocked' }> | undefined { return current }

/**
 * Retain the original startup failure while closing native admission once.
 * @param admission Opaque result returned to this carrier, if admission completed.
 * @param error Original business import/startup failure.
 * @returns Never returns; cleanup errors are aggregated with the original failure.
 */
export async function failRuntimeCarrier(admission: RuntimeAdmission | undefined, error: unknown): Promise<never> {
  if (admission?.status === 'managed' && !failed.has(admission)) {
    failed.add(admission)
    try { await admission.failed(error) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime startup and native admission closure failed')
    }
  }
  throw error
}

/** Installation-owned Worker creation, with native inherited admission before the fixed Worker main import. */
export interface RuntimeWorkerAuthority {
  /**
   * Spawn the already inventoried Worker entry, preserving native data, transfers and lifecycle events.
   * @param entry Fixed code-owned Worker URL/path; browser paths confer no authority.
   * @param options Original Worker options, including data and transferList.
   * @returns The real Node Worker, so its message/error/exit/termination semantics remain native.
   */
  spawn(entry: string | URL, options?: WorkerOptions): Worker
}

/**
 * Create a Harness-owned Worker under the current process binding.
 * @param entry Original fixed Worker main.
 * @param options Original Node options.
 * @returns The real Worker using inherited native admission, or ordinary Node construction when unenrolled.
 */
export function createRuntimeWorker(entry: string | URL, options?: WorkerOptions): Worker {
  if (current?.status === 'managed') {
    if (current.workers === undefined) throw new Error('Managed runtime has no qualified Worker bootstrap')
    return current.workers.spawn(entry, options)
  }
  return new Worker(entry, options)
}
let inheritedWorkerPayload: { readonly value: unknown } | undefined
/**
 * Retain original workerData before the fixed Worker main imports; this is payload handling, not admission authority.
 * @param payload Original parent-supplied data, preserved without cloning or dropping transferred objects.
 */
export function installRuntimeWorkerPayload(payload: unknown): void {
  if (isMainThread || inheritedWorkerPayload !== undefined) throw new Error('Worker payload is already installed or this is the main thread')
  inheritedWorkerPayload = { value: payload }
}
/**
 * Read original Node workerData after managed wrappers unwrap their private transport envelope.
 * @returns The unchanged original payload; ordinary Workers retain Node's workerData.
 */
export function runtimeWorkerData(): unknown { return inheritedWorkerPayload === undefined ? workerData : inheritedWorkerPayload.value }

/** Fixed installation-owned child launch, registered before the outer application imports its Host lifecycle. */
export interface RuntimeChildLaunchRequest {
  readonly carrier: RuntimeCarrierId
  readonly executable: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
  /** Existing lifecycle owner retains all normal IPC, quit/update and replacement-ready handling. */
  readonly owner?: {
    withReplacement<T>(operation: (scope: {
      readonly signal: AbortSignal
      stop(child: ChildProcess): Promise<void>
      /** Relinquish a failed candidate after its actual exit, without claiming successful graceful drain. */
      discard(child: ChildProcess): Promise<void>
      adopt(child: ChildProcess): Promise<void>
    }) => Promise<T>): Promise<T>
  }
}
/** Fixed installation-owned child launch, registered before the outer application imports its Host lifecycle. */
export interface RuntimeChildLaunchAuthority {
  /**
   * Preserve the actual Node child while attaching the fixed capsule and its private coordinator channel.
   * @param request Carrier identity and the original installation-owned spawn request.
   * @returns The real ChildProcess observed by the existing application lifecycle owner.
   */
  spawn(request: RuntimeChildLaunchRequest): ChildProcess
  /**
   * Consume only a private protocol message after authenticating its actual child and operation.
   * @param child The actual process returned by spawn.
   * @param message Private protocol candidate; normal application messages never reach this method.
   * @returns True only after native identity/operation validation and delivery to its coordinator.
   */
  consumeMessage(child: ChildProcess, message: unknown): boolean
}
const CHILD_LAUNCH = Symbol.for('@deepseek-ai/dsh/outer-bootstrap/child-launch/v1')
const INSTALLATION_LOCATION = Symbol.for('@deepseek-ai/dsh/outer-bootstrap/installation-location/v1')
/**
 * Bind the one packaged logical runtime to its separately packaged physical code directory before outer startup.
 * @param location Exact installer-owned package layout; paths do not grant native enrollment or code authority.
 */
export function installRuntimeInstallationLocation(location: Readonly<{ bundled: string; installation: string }>): void {
  for (const path of [location.bundled, location.installation]) {
    if (!isAbsolute(path) || normalize(path) !== path) throw new Error('Runtime installation location must be a literal absolute path')
  }
  registerRuntimeOuterCapability(INSTALLATION_LOCATION, Object.freeze({ bundled: location.bundled, installation: location.installation }))
}
/**
 * Resolve the fixed packaged location supplied by the outer installer; ordinary applications retain their own path.
 * @param bundled Original application-owned bundled runtime location.
 * @returns The same ordinary location or its one explicitly registered physical installation.
 */
export function resolveRuntimeInstallation(bundled: string): string {
  const location = runtimeOuterCapability(INSTALLATION_LOCATION) as Readonly<{ bundled: string; installation: string }> | undefined
  if (location === undefined) return bundled
  if (bundled !== location.bundled) throw new Error('Runtime installation location differs from the fixed packaged binding')
  return location.installation
}
/**
 * Install the fixed child launcher from an installer-owned outer bootstrap before application startup.
 * @param authority Native authority already bound to the installed descriptors; no environment discovery occurs here.
 */
export function installRuntimeChildLaunchAuthority(authority: RuntimeChildLaunchAuthority): void {
  registerRuntimeOuterCapability(CHILD_LAUNCH, Object.freeze({
    spawn: authority.spawn.bind(authority), consumeMessage: authority.consumeMessage.bind(authority),
  }))
}
/**
 * Spawn a fixed carrier through its installer-owned authority, preserving ordinary unenrolled process creation.
 * @param request Original fixed executable/arguments/options owned by the application, never a browser entry choice.
 * @returns The same real ChildProcess used for native IPC, startup, shutdown and update exclusion.
 */
export function spawnRuntimeChild(request: RuntimeChildLaunchRequest): ChildProcess {
  const childLaunchAuthority = runtimeOuterCapability(CHILD_LAUNCH) as RuntimeChildLaunchAuthority | undefined
  return childLaunchAuthority === undefined
    ? spawn(request.executable, [...request.args], request.options) : childLaunchAuthority.spawn(request)
}

/**
 * Authenticate private coordinator messages before a carrier's existing IPC grammar examines them.
 * @param child Actual child whose native identity is retained by the installed authority.
 * @param message IPC message. Ordinary ready/fatal/shutdown/control traffic always returns false.
 * @returns Whether the native coordinator consumed this private message; invalid messages retain normal fatal handling.
 */
export function consumeRuntimeChildMessage(child: ChildProcess, message: unknown): boolean {
  if (message === null || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string'
    || !message.type.startsWith('dsh-runtime-')) return false
  const authority = runtimeOuterCapability(CHILD_LAUNCH) as RuntimeChildLaunchAuthority | undefined
  return authority?.consumeMessage(child, message) ?? false
}

/** Outer applications qualify document preparation separately from a child process launch. */
export interface RuntimeProfileRequest {
  readonly home: string
  readonly profileDir: string
  readonly runtimeDir: string
}
/** Managed operations preserve originals through the indexed native document service. */
export type RuntimeProfileQualification = Readonly<{ status: 'unenrolled' }> | Readonly<{ status: 'blocked'; reason: string }>
  | Readonly<{ status: 'managed'
    /** Complete native initialization/migration before the application spawns its Host. */
    prepare(): Promise<void>
    /**
     * Select a native recovery view and retain a private versioned backup.
     * @param defaultBundles Fixed installation-owned recovery bundle names.
     * @returns The generated private backup path, when there was a previous patch.
     */
    disableThirdParty(defaultBundles: readonly string[]): Promise<string | undefined>
  }>
/** Installer-owned outer Profile authority; browser paths and environment values are never providers. */
export interface RuntimeProfileAuthority {
  /**
   * Qualify the explicit logical Profile against native installer records.
   * @param request Outer application's fixed Home/Profile/runtime facts.
   * @returns Positive absence, an actionable block, or native preparation/recovery operations.
   */
  qualify(request: RuntimeProfileRequest): Promise<RuntimeProfileQualification>
}
const PROFILE_AUTHORITY = Symbol.for('@deepseek-ai/dsh/outer-bootstrap/profile/v1')
/**
 * Install native document preparation and recovery before importing the outer application.
 * @param authority Native provider from the fixed installer bootstrap.
 */
export function installRuntimeProfileAuthority(authority: RuntimeProfileAuthority): void {
  registerRuntimeOuterCapability(PROFILE_AUTHORITY, Object.freeze({ qualify: authority.qualify.bind(authority) }))
}
/**
 * Qualify Desktop preparation/recovery before any original Profile lock or write.
 * @param request Explicit outer-application locations.
 * @returns Native authority, positive absent management, or an actionable block.
 */
export async function qualifyRuntimeProfile(request: RuntimeProfileRequest): Promise<RuntimeProfileQualification> {
  const authority = runtimeOuterCapability(PROFILE_AUTHORITY) as RuntimeProfileAuthority | undefined
  if (authority !== undefined) {
    const qualified = await authority.qualify(Object.freeze({ ...request }))
    return qualified.status === 'managed' ? Object.freeze({ status: 'managed',
      prepare: qualified.prepare.bind(qualified), disableThirdParty: qualified.disableThirdParty.bind(qualified),
    }) : Object.freeze({ ...qualified })
  }
  const qualification = inspectUnenrolledRuntime(request.home)
  return qualification.status === 'managed' ? { status: 'blocked', reason: 'Outer Profile authority is unavailable' } : qualification
}
