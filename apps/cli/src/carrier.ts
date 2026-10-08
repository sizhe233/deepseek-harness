/** Application-free descriptions of the three installation-owned launch carriers. */

import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot/runtime-version'
import { admitRuntimeCarrier, type RuntimeAdmission } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { finishDshArguments, parseDshArgumentResult, type DshInvocation } from './args.ts'

/** Common installation facts, resolved without loading a profile or application. */
interface CarrierIdentity {
  /** The installed wrapper's module URL, including source launches. */
  entryUrl: string
  /** Literal normalized Home; this read neither creates nor canonicalizes it. */
  home: string
  runtimeVersion: string
  /** Native admission is supplied by the installed wrapper before business imports. */
  readonly admission?: Exclude<RuntimeAdmission, { status: 'blocked' }>
}

/** Ordinary command-line launch, including inspection and plugin-management modes. */
export interface CliCarrierLaunch extends CarrierIdentity {
  carrier: 'cli' | 'desktop-cli'
  invocation: DshInvocation
}

/** Electron-owned Host launch; its positional arguments retain their installed meanings. */
export interface DesktopHostLaunch extends CarrierIdentity {
  carrier: 'desktop-host'
  profile: 'desktop'
  runtimeDir: string
  projectDir: string
  officeSource: string | undefined
  packageManagerPath: string | undefined
  commandPath: string | undefined
}

/** The supported fixed carrier descriptors; none selects an arbitrary application entry. */
export type CarrierLaunch = CliCarrierLaunch | DesktopHostLaunch

/** Installation-owned command access; no application arguments are accepted here. */
interface CliCarrierOptions {
  carrier: 'cli' | 'desktop-cli'
  entryUrl: string
  manageDesktopProfile?: boolean | undefined
}

/** Electron Host identification supplied by its installed wrapper. */
interface DesktopHostOptions {
  carrier: 'desktop-host'
  entryUrl: string
}

/**
 * Describe the current process before importing its business entry.
 * Help, version, and argument errors retain their exact output and exit here.
 * @param options - Fixed carrier identity and installation-owned Desktop plugin access.
 * @returns the parsed invocation and literal Home, without profile initialization.
 */
export function prepareCarrierLaunch(options: CliCarrierOptions): CliCarrierLaunch
/**
 * Describe Electron's current Host process without loading its application.
 * @param options - Fixed Host carrier identity.
 * @returns the unchanged positional arguments and literal Home.
 */
export function prepareCarrierLaunch(options: DesktopHostOptions): DesktopHostLaunch
export function prepareCarrierLaunch(options: CliCarrierOptions | DesktopHostOptions): CarrierLaunch {
  const runtimeVersion = getDshRuntimeVersion()
  if (options.carrier === 'desktop-host') {
    return {
      carrier: options.carrier, entryUrl: options.entryUrl, runtimeVersion, home: resolveDshHome(),
      profile: 'desktop', runtimeDir: process.argv[2] as string, projectDir: process.argv[3] as string,
      officeSource: process.argv[4], packageManagerPath: process.argv[5], commandPath: process.argv[6],
    }
  }
  const invocation = finishDshArguments(parseDshArgumentResult(
    process.argv.slice(2), runtimeVersion, options.manageDesktopProfile,
  ))
  return { carrier: options.carrier, entryUrl: options.entryUrl, runtimeVersion, home: resolveDshHome(), invocation }
}

/**
 * Admit the parsed fixed carrier before importing its application module.
 * @param launch Descriptor produced by prepareCarrierLaunch, with no application dependencies loaded.
 * @returns The same arguments and one immutable process admission.
 */
export function admitCarrierLaunch(launch: CliCarrierLaunch): Promise<CliCarrierLaunch>
export function admitCarrierLaunch(launch: DesktopHostLaunch): Promise<DesktopHostLaunch>
export async function admitCarrierLaunch(launch: CarrierLaunch): Promise<CarrierLaunch> {
  const admission = await admitRuntimeCarrier({
    carrier: launch.carrier, entryUrl: launch.entryUrl, home: launch.home,
    profile: launch.carrier === 'desktop-host' ? launch.profile : launch.invocation.profile,
    ...(launch.carrier !== 'desktop-host' && launch.invocation.mode !== 'plugin' ? {
      patches: Object.freeze([...launch.invocation.patches]),
      ...(launch.invocation.fromDefaultProfile === undefined ? {} : { fromDefaultProfile: launch.invocation.fromDefaultProfile }),
    } : {}),
    mode: launch.carrier === 'desktop-host' || launch.invocation.mode === 'profile' ? 'application'
      : launch.invocation.mode === 'plugin' ? 'package' : 'inspection',
  })
  return Object.freeze({ ...launch, admission })
}
