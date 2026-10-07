/** Profile-local compatibility permissions readable before any Cordis plugins load. */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'semver'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { getDshRuntimeVersion } from './plugin-compatibility.ts'
import type { ProfileDocumentView } from './profile-document-view.ts'
import { createProfileDocumentOperationId, publishedProfileDocumentView, type ProfileDocuments } from './profile-documents.ts'

/** Independent profile metadata; neither package manifests nor Cordis patches carry grants. */
export const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'

/** Published and scoped npm package names, as npm accepts them in a manifest dependency key. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Whether a decoded record accepts only exact DSH versions. */
function isVersionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(version => typeof version === 'string' && isExactPluginVersion(version))
}

/** Test whether an exemption names a canonical exact SemVer, including build metadata.
 * @param value Version supplied by a manifest or user.
 * @returns False for ranges, prefixes, whitespace, and malformed versions.
 */
export function isExactPluginVersion(value: string): boolean {
  const parsed = parse(value)
  return parsed !== null && value === `${parsed.version}${parsed.build.length === 0 ? '' : `+${parsed.build.join('.')}`}`
}

/** Validate one explicit exemption without granting it.
 * @param packageVersion Exact npm package-name@version, never an installation spec or range.
 * @param runtimeVersion Exact DSH version, including prerelease and build metadata.
 * @throws When either identity is not canonical.
 */
export function validatePluginVersionExemption(packageVersion: string, runtimeVersion: string): void {
  const separator = packageVersion.lastIndexOf('@')
  if (separator <= 0 || !PACKAGE_NAME.test(packageVersion.slice(0, separator))
    || !isExactPluginVersion(packageVersion.slice(separator + 1)) || !isExactPluginVersion(runtimeVersion)) {
    throw new Error('Version exemptions require an exact npm package-name@version and an exact DSH runtime version')
  }
}

/** What one profile's compatibility file currently authorizes, and what is wrong with it. */
export interface ProfileCompatibility {
  /** Accepted exact package-name@version keys mapped to their allowed DSH versions. */
  readonly exemptions: Record<string, string[]>
  /** Human-readable problems; empty when every record was accepted. */
  readonly warnings: string[]
  /**
   * Whether the file holds nothing this reader rejected, so a grant or revocation may rewrite it.
   * A false value means writing would discard content the user must repair by hand.
   */
  readonly rewritable: boolean
}

/** Read the profile's independent compatibility file without loading plugins.
 * A missing file authorizes nothing. An unreadable or unparsable file authorizes nothing and is
 * reported instead of failing, so a bad file can never make the profile unusable; rejected records
 * are skipped while the remaining valid ones still apply.
 * @param profileDir Absolute profile directory.
 * @param view Optional native admitted view; unlisted/unavailable documents throw without filesystem fallback.
 * @returns Accepted exemptions plus every problem found; no manifest fallback is used.
 */
export function readProfileCompatibility(profileDir: string, view?: ProfileDocumentView): ProfileCompatibility {
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const unreadable = (reason: string): ProfileCompatibility =>
    ({ exemptions: {}, warnings: [`${filename} ${reason}; treating the profile as having no exemptions`], rewritable: false })
  let text: string
  if (view !== undefined) {
    const document = view.read(filename)
    if (document.state === 'absent') return { exemptions: {}, warnings: [], rewritable: true }
    text = document.text
  } else try { text = readFileSync(filename, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exemptions: {}, warnings: [], rewritable: true }
    return unreadable(`cannot be read (${String(error)})`)
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { return unreadable(`is not valid JSON (${String(error)})`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return unreadable('must map exact package@version keys to DSH version lists')
  }
  const exemptions: Record<string, string[]> = {}
  const warnings: string[] = []
  for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || !PACKAGE_NAME.test(key.slice(0, separator)) || !isExactPluginVersion(key.slice(separator + 1))) {
      warnings.push(`${filename}: ${JSON.stringify(key)} is not an exact package-name@version key; the record is ignored`)
      continue
    }
    if (!isVersionList(versions)) {
      warnings.push(`${filename}: ${key} must contain a list of exact DSH versions; the record is ignored`)
      continue
    }
    exemptions[key] = versions
  }
  return { exemptions, warnings, rewritable: warnings.length === 0 }
}

/** Read only the accepted exemptions of a profile.
 * @param profileDir Absolute profile directory.
 * @param view Optional admitted view; unavailable managed documents never reopen their originals.
 * @returns Exact package-name@version keys mapped to their allowed DSH versions.
 */
export function readProfileVersionExemptions(profileDir: string, view?: ProfileDocumentView): Record<string, string[]> {
  return readProfileCompatibility(profileDir, view).exemptions
}

function changedExemptions(
  current: ProfileCompatibility, packageVersion: string, runtimeVersion: string, enabled: boolean,
): string {
  if (!current.rewritable) {
    throw new Error(`${PROFILE_COMPATIBILITY_FILENAME} must be repaired before exemptions change:\n${current.warnings.join('\n')}`)
  }
  const exemptions = current.exemptions
  const versions = exemptions[packageVersion] ?? []
  if (enabled) exemptions[packageVersion] = [...new Set([...versions, runtimeVersion])]
  else {
    const retained = versions.filter(version => version !== runtimeVersion)
    if (retained.length) exemptions[packageVersion] = retained
    else Reflect.deleteProperty(exemptions, packageVersion)
  }
  return JSON.stringify(exemptions, undefined, 2) + '\n'
}

/** Persist one informed grant or revocation through its file lock or admitted document authority.
 * @param profileDir Profile directory; no package manifest is created or modified.
 * @param packageVersion Exact manifest package-name@version.
 * @param runtimeVersion Exact DSH version; grants must name the current runtime, revocations may name historical ones.
 * @param enabled Whether to grant rather than revoke.
 * @param acceptRisk Required true for grants after explicit acknowledgement of possible crashes or data loss.
 * @param documents Launcher-admitted native authority for managed profiles; omitted retains ordinary file behavior.
 * @returns After the ordinary atomic write or finalized native publication. Existing plugin instances are not reloaded.
 * @throws For invalid identities, missing consent, a stale runtime, or a file the reader rejected,
 * which the user must repair because rewriting it would discard their content. Native stale views or
 * unfinalized outcomes refuse without an original-file fallback or automatic publication retry.
 */
export async function setProfileVersionExemption(
  profileDir: string, packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk: boolean,
  documents?: ProfileDocuments,
): Promise<void> {
  validatePluginVersionExemption(packageVersion, runtimeVersion)
  if (enabled && !acceptRisk) {
    throw new Error('Incompatible plugins may cause crashes or data loss. To grant this exact-version exemption, explicitly acknowledge the risk with --accept-risk (acceptRisk: true).')
  }
  const current = getDshRuntimeVersion()
  if (enabled && runtimeVersion !== current) {
    throw new Error(`Cannot approve DSH ${runtimeVersion}: this application runs DSH ${current}. Use --dsh-version ${current}.`)
  }
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  if (documents !== undefined) {
    if (documents.selection.profileDir !== profileDir) throw new Error('Compatibility writer does not match the admitted Profile')
    const view = await documents.refresh()
    const publication = await documents.withWriteSnapshot({
      operationId: createProfileDocumentOperationId(), expected: view.reference,
    }, current => [{ logicalPath: filename, expected: current.read(filename).reference,
      text: changedExemptions(readProfileCompatibility(profileDir, current), packageVersion, runtimeVersion, enabled) }])
    publishedProfileDocumentView(publication)
    return
  }
  await mkdir(profileDir, { recursive: true })
  await withFileLock(filename, async () => {
    const text = changedExemptions(readProfileCompatibility(profileDir), packageVersion, runtimeVersion, enabled)
    await writeFileAtomic(filename, text, { mode: 0o600 })
  })
}
