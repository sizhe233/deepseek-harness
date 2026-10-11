/** Derive only fields owned by an Include source, preserving unchanged YAML nodes and overlay ownership. */
import { isDeepStrictEqual } from 'node:util'
import { isSeq, parseDocument, Scalar, visit, type YAMLSeq } from 'yaml'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

type Field = { present: false } | { present: true; value: unknown }
const absent: Field = { present: false }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const field = (value: Record<string, unknown>, key: string): Field => Object.hasOwn(value, key) ? { present: true, value: value[key] } : absent
function derive(raw: Field, before: Field, after: Field, path: string): Field {
  if (isDeepStrictEqual(before, after)) return structuredClone(raw)
  if (isDeepStrictEqual(raw, before)) return structuredClone(after)
  if (raw.present && before.present && after.present && object(raw.value) && object(before.value) && object(after.value)) {
    const result = structuredClone(raw.value)
    for (const key of new Set([...Object.keys(before.value), ...Object.keys(after.value)])) {
      const next = derive(field(raw.value, key), field(before.value, key), field(after.value, key), `${path}.${key}`)
      if (next.present) Object.defineProperty(result, key, { value: next.value, enumerable: true, configurable: true, writable: true })
      else Reflect.deleteProperty(result, key)
    }
    return { present: true, value: result }
  }
  throw new Error(`Include field is owned by a patch: ${path}`)
}
function rows(raw: readonly EntryOptions[], before: readonly EntryOptions[], after: readonly EntryOptions[]): EntryOptions[] {
  const index = (entries: readonly EntryOptions[]) => {
    const result = new Map<string, EntryOptions>()
    for (const entry of entries) {
      if (!entry.id || result.has(entry.id)) throw new Error('Managed Include edits require unique entry ids')
      result.set(entry.id, entry)
    }
    return result
  }
  const originals = index(raw), previous = index(before), desired = index(after)
  if (isDeepStrictEqual(raw, before)) return structuredClone([...after])
  const priorOrder = before.filter(row => desired.has(row.id)).map(row => row.id)
  const nextOrder = after.filter(row => previous.has(row.id)).map(row => row.id)
  if (!isDeepStrictEqual(priorOrder, nextOrder)) throw new Error('Managed Include reordering across patches requires an explicit source edit')
  const result: EntryOptions[] = []
  for (const [id, old] of previous) {
    const next = desired.get(id), source = originals.get(id)
    if (source === undefined) {
      if (!isDeepStrictEqual(old, next)) throw new Error(`Include entry is owned by a patch: ${id}`)
      continue
    }
    if (next === undefined) {
      if (!isDeepStrictEqual(source, old)) throw new Error(`Patched Include entry cannot be removed from its source: ${id}`)
      continue
    }
    if (source.name !== old.name || old.name !== next.name) throw new Error(`Include entry ownership changed: ${id}`)
    if (source.group && old.group && next.group && Array.isArray(source.config) && Array.isArray(old.config) && Array.isArray(next.config)) {
      const config = rows(source.config as EntryOptions[], old.config as EntryOptions[], next.config as EntryOptions[])
      const fields = derive({ present: true, value: { ...source, config: null } }, { present: true, value: { ...old, config: null } }, { present: true, value: { ...next, config: null } }, id)
      if (!fields.present || !object(fields.value)) throw new Error('Include group ownership changed')
      result.push({ ...fields.value, id: source.id, name: source.name, config })
    } else {
      const fields = derive({ present: true, value: source }, { present: true, value: old }, { present: true, value: next }, id)
      if (!fields.present || !object(fields.value)) throw new Error('Include entry ownership changed')
      result.push({ ...fields.value, id: source.id, name: source.name })
    }
  }
  for (const [id, entry] of desired) if (!previous.has(id)) result.push(structuredClone(entry))
  return result
}

/**
 * Derive a source-only candidate from a Loader edit of the composed entry list.
 * @param source Current native source text.
 * @param format Include serialization format.
 * @param raw Parsed source entries, before overlays.
 * @param before Effective entries before the user's edit.
 * @param after Requested effective entries.
 * @returns Source bytes and detached source entries; overlay-owned changes refuse.
 */
export function deriveOwnedEntryDocument(source: string, format: 'application/yaml' | 'application/json', raw: readonly EntryOptions[], before: readonly EntryOptions[], after: readonly EntryOptions[]): { text: string; data: EntryOptions[] } {
  const data = rows(raw, before, after)
  if (format === 'application/json') return { text: JSON.stringify(data, null, 2), data }
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length) throw new Error('Managed Include source YAML is invalid', { cause: document.errors[0] })
  if (!isSeq(document.contents)) throw new Error('Managed Include source must be a YAML sequence')
  const sequence: YAMLSeq = document.contents
  const original = new Map(raw.map(entry => [entry.id, entry]))
  const nodes = new Map(raw.map((entry, index) => [entry.id, sequence.items[index]]))
  const update = (path: (string | number)[], previous: unknown, next: unknown): void => {
    if (isDeepStrictEqual(previous, next)) return
    if (Array.isArray(previous) && Array.isArray(next)) {
      const node = document.getIn(path, true)
      if (isSeq(node) && previous.every(item => object(item) && typeof item.id === 'string') && next.every(item => object(item) && typeof item.id === 'string')) {
        const old = new Map(previous.map((item, index) => [String(item.id), { value: item, node: node.items[index] }]))
        node.items = next.map(item => old.get(String(item.id))?.node ?? document.createNode(item))
        next.forEach((item, index) => { const value = old.get(String(item.id)); if (value !== undefined) update([...path, index], value.value, item) })
      } else if (isSeq(node) && previous.length === next.length) next.forEach((value, index) => { update([...path, index], previous[index], value) })
      else document.setIn(path, document.createNode(next))
    } else if (object(previous) && object(next)) {
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (!Object.hasOwn(next, key)) document.deleteIn([...path, key])
        else if (!Object.hasOwn(previous, key)) document.setIn([...path, key], document.createNode(next[key]))
        else update([...path, key], previous[key], next[key])
      }
    } else document.setIn(path, document.createNode(next))
  }
  sequence.items = data.map(entry => nodes.get(entry.id) ?? document.createNode(entry))
  data.forEach((entry, index) => { const previous = original.get(entry.id); if (previous !== undefined) update([index], previous, entry) })
  visit(document, { Map(_key, node) {
    if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
    const expression = new Scalar(node.get('__jsExpr')); expression.tag = 'tag:yaml.org,2002:js'; return expression
  } })
  return { text: String(document), data }
}
