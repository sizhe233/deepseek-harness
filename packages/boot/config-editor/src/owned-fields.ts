/** Reverse only still-matching raw configuration fields, preserving concurrent unrelated edits. */
import { isDeepStrictEqual } from 'node:util'

type PresentField = { present: true; value: unknown }
type Field = { present: false } | PresentField
const absent: Field = { present: false }
const field = (record: Record<string, unknown>, key: string): Field =>
  Object.hasOwn(record, key) ? { present: true, value: record[key] } : absent
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function reverse(before: PresentField, after: PresentField, current: PresentField, path: string): PresentField
function reverse(before: Field, after: Field, current: Field, path: string): Field
function reverse(before: Field, after: Field, current: Field, path: string): Field {
  if (isDeepStrictEqual(before, after)) return current
  if (isDeepStrictEqual(current, after)) return structuredClone(before)
  const b = before.present ? before.value : undefined
  const a = after.present ? after.value : undefined
  const c = current.present ? current.value : undefined
  if ((!before.present || object(b)) && (!after.present || object(a)) && object(c)) {
    const prior = before.present ? b as Record<string, unknown> : {}
    const next = after.present ? a as Record<string, unknown> : {}
    const result = structuredClone(c)
    for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
      const value = reverse(field(prior, key), field(next, key), field(c, key), `${path}.${key}`)
      if (value.present) Object.defineProperty(result, key, { value: value.value, enumerable: true, configurable: true, writable: true })
      else Reflect.deleteProperty(result, key)
    }
    return !before.present && Object.keys(result).length === 0 ? absent : { present: true, value: result }
  }
  if (Array.isArray(b) && Array.isArray(a) && Array.isArray(c) && b.length === a.length && a.length === c.length) {
    const result = structuredClone(c)
    for (let index = 0; index < a.length; index++) {
      if (isDeepStrictEqual(b[index], a[index])) continue
      const afterValue: unknown = a[index], currentValue: unknown = c[index]
      for (const key of ['id', 'name']) {
        if (object(afterValue) && Object.hasOwn(afterValue, key)
          && (!object(currentValue) || !isDeepStrictEqual(afterValue[key], currentValue[key]))) {
          throw new Error(`Configuration owned-field identity changed at ${path}[${index}]`)
        }
      }
      const value = reverse({ present: true, value: b[index] }, { present: true, value: a[index] }, { present: true, value: c[index] }, `${path}[${index}]`)
      result[index] = value.value
    }
    return { present: true, value: result }
  }
  throw new Error(`Configuration owned field changed at ${path}`)
}

/**
 * Reverse one raw config override using exact before/after field presence from retained native documents.
 * @param before Whether the override existed and its raw value before publication.
 * @param after Whether the override existed and its raw value after publication.
 * @param current Override from the newest native view.
 * @returns A detached reverse candidate; changed owned fields or array identities reject.
 */
export function reverseOwnedConfig(before: Field, after: Field, current: Field): Field {
  return reverse(before, after, current, 'config')
}
