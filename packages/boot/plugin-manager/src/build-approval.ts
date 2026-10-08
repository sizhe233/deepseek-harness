/** Approve pnpm's pending dependency scripts in the current profile's workspace settings. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { ManagementFailure } from './failure.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

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
  const pending = isMap(builds) ? builds.items.flatMap(({ key, value }) =>
    isScalar(key) && typeof key.value === 'string' && !/[*?]/.test(key.value)
      && isScalar(value) && value.value === 'set this to true or false' ? [key.value] : []) : []
  return { document, pending }
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
