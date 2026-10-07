/** Comment-preserving profile plugin enablement edits. */
import { readFile } from 'node:fs/promises'
import { isMap, isSeq, parseDocument } from 'yaml'
import { parsePatchList } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Replace the last matching override or append one after existing insertions.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(filename: string, id: string, name: string, enabled: boolean): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const next = derivePluginEnabledText(filename, text, id, name, enabled)
  if (next === undefined) return false
  await writeFileAtomic(filename, next, { mode: 0o600 })
  return true
}

/** Derive one enablement edit from admitted text without reopening its logical source.
 * @param filename Logical profile patch filename, used only for parser diagnostics and relative names.
 * @param text Complete current patch text, or an explicit empty sequence for admitted absence.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Changed patch text, or undefined when its effective override already matches.
 */
export function derivePluginEnabledText(
  filename: string, text: string, id: string, name: string, enabled: boolean,
): string | undefined {
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  parsePatchList('dsh', filename, text, 'patches')
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  if (isMap(target)) {
    if (document.getIn([items.indexOf(target), 'disabled']) === !enabled) return undefined
    document.setIn([items.indexOf(target), 'disabled'], !enabled)
  } else {
    document.add({ id, disabled: !enabled })
  }
  return String(document)
}
