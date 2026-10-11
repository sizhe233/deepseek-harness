/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { migrateLegacyMcpConfiguration } from './legacy-mcp-configuration.ts'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile, type ProfileLayer } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import { parsePatchList } from './patch-list.ts'
import { assertProfileDocumentSelection, type ProfileDocumentSelection, type ProfileDocumentView } from './profile-document-view.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  /** Fixed business-entry module URL used to classify application dependencies during HMR. */
  readonly applicationEntry?: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  return finishProfilePatches([
    ...profile.layers.flatMap(layer => layer.patches),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ], context.telemetryDisabledEnv)
}

/** Bundle layers loaded from the exact code and package-document selection admitted for this process. */
export interface ProfileDocumentLayers {
  readonly codeBinding: ProfileDocumentSelection['codeBinding']
  readonly packageDocuments: ProfileDocumentSelection['packageDocuments']
  readonly layers: readonly ProfileLayer[]
}

/**
 * Compose an admitted immutable document view with its matching bundle layers and launch overlays.
 * No source files, package manifests or initial Profile patches are read by this adapter.
 * @param binName Diagnostic prefix for malformed patches.
 * @param context Logical launch locations and invocation overlays.
 * @param view Complete desired document view, acquired through the native read capability.
 * @param bundles Layers already admitted for the process's code and package-document selection.
 * @returns Detached ordered patches; this neither applies the Loader nor acknowledges a published revision.
 * @throws For mismatched selection, an unlisted document or malformed present patches.
 */
export function readProfilePatchesFromView(
  binName: string, context: ProfileContext, view: ProfileDocumentView, bundles: ProfileDocumentLayers,
): PatchOptions[] {
  if (context.patchPath !== join(context.dir, PROFILE_PATCH_FILENAME)) {
    throw new Error('Managed Profile patch path does not match its logical Profile directory')
  }
  assertProfileDocumentSelection(view, {
    profileDir: context.dir, home: context.home,
    codeBinding: bundles.codeBinding, packageDocuments: bundles.packageDocuments,
  })
  const profile = view.read(context.patchPath)
  const home = view.read(join(context.home, PROFILE_PATCH_FILENAME))
  return finishProfilePatches([
    ...bundles.layers.flatMap(layer => layer.patches),
    ...profile.state === 'absent' ? [] : parsePatchList(binName, profile.logicalPath, profile.text, 'patches'),
    ...home.state === 'absent' ? [] : parsePatchList(binName, home.logicalPath, home.text, 'patches'),
    ...context.overlays,
  ], context.telemetryDisabledEnv)
}

/** Detach all layers before applying launch-time privacy and legacy configuration projections. */
function finishProfilePatches(input: PatchOptions[], telemetryDisabledEnv: string | undefined): PatchOptions[] {
  const patches = structuredClone(input)
  const telemetryPatch = resolveTelemetryPatch(telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return migrateLegacyMcpConfiguration(patches)
}
