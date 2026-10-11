/** Approve pnpm's pending dependency scripts in the current profile's workspace settings. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { ManagementFailure } from './failure.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Value pnpm leaves for a build script that still needs a decision. */
const UNDECIDED_BUILD = 'set this to true or false'

/** Where a non-interactive run names the build scripts it skipped. */
const IGNORED_BUILDS = /\bIgnored build scripts: (.+)/

function parsePolicy(text: string) {
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isMap(document.contents)) throw new Error('pnpm-workspace.yaml must be a YAML mapping')
  const builds = document.get('allowBuilds')
  if (builds !== undefined && !isMap(builds)) throw new Error('allowBuilds must be a YAML mapping')
  visit(builds ?? null, (_key, node) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      throw new Error('allowBuilds must not contain YAML anchors or aliases')
    }
  })
  const keys = isMap(builds) ? builds.items.flatMap(({ key }) =>
    isScalar(key) && typeof key.value === 'string' ? [key.value] : []) : []
  const pending = isMap(builds) ? builds.items.flatMap(({ key, value }) =>
    isScalar(key) && typeof key.value === 'string' && !/[*?]/.test(key.value)
      && isScalar(value) && value.value === UNDECIDED_BUILD ? [key.value] : []) : []
  return { document, pending, keys }
}

async function readPolicyText(dir: string): Promise<string> {
  try { return await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return '{}\n'
  }
}

/** Read pending script decisions from a complete admitted workspace document.
 * @param text Exact current policy text, or an empty mapping for admitted absence.
 * @returns Named undecided packages; existing decisions and wildcard rules are excluded.
 */
export function pendingBuildsFromText(text: string): string[] {
  return parsePolicy(text).pending
}

/** Derive an explicitly requested build approval without filesystem access or script execution.
 * @param text Complete current workspace policy text.
 * @param names Exact package names already approved by the caller under the existing consent flow.
 * @returns Changed policy text, or undefined for an empty request.
 * @throws When any requested name is no longer pending or the policy contains shared approval nodes.
 */
export function deriveBuildApprovalText(text: string, names: readonly string[]): string | undefined {
  const { document, pending } = parsePolicy(text)
  if (names.some(name => !pending.includes(name))) throw new ManagementFailure('stale-approval')
  if (names.length === 0) return undefined
  for (const name of names) document.setIn(['allowBuilds', name], true)
  return String(document)
}

/** Read package names left undecided by pnpm 11, including after installation cleanup.
 * @param dir Current profile directory.
 * @returns Exact package names awaiting a build decision; wildcard rules are excluded.
 */
export async function readPendingBuilds(dir: string): Promise<string[]> {
  return pendingBuildsFromText(await readPolicyText(dir))
}

/**
 * Record the build scripts a failed run reported as ignored, then list every name awaiting a decision.
 *
 * pnpm writes those policy entries itself only when it can prompt, and the
 * manager always runs it non-interactively, so the run's own report is the
 * record that survives.
 * @param dir Current profile directory.
 * @param output Captured output of the failed run.
 * @returns Exact package names awaiting a build decision; wildcard rules are excluded.
 */
export async function recordPendingBuilds(dir: string, output: string): Promise<string[]> {
  const { document, pending, keys } = parsePolicy(await readPolicyText(dir))
  const known = new Set(keys)
  const added = ignoredBuildNames(output).filter(name => !known.has(name))
  if (added.length === 0) return pending
  for (const name of added) document.setIn(['allowBuilds', name], UNDECIDED_BUILD)
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
  return [...pending, ...added]
}

/**
 * Read the package names a pnpm run reported as ignored build scripts.
 * @param output Captured output of the run.
 * @returns Exact names in report order; wildcard patterns are excluded.
 */
export function ignoredBuildNames(output: string): string[] {
  const reported = IGNORED_BUILDS.exec(output)?.[1]
  if (reported === undefined) return []
  return reported.split(',').map(name => name.trim()).filter(name => name !== '' && !/[*?]/.test(name))
}

/** Persist approval without running scripts; the caller holds the profile manifest lock.
 * @param dir Current profile directory.
 * @param names Explicit package names from the pending build list.
 * @throws If a name is no longer pending or allowBuilds contains YAML anchors or aliases; no approvals are written.
 */
export async function approveBuilds(dir: string, names: readonly string[]): Promise<void> {
  const text = deriveBuildApprovalText(await readPolicyText(dir), names)
  if (text === undefined) return
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), text, { mode: 0o600 })
}
