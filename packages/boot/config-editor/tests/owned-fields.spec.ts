/** Field reconciliation covers raw presence and selector identity, independently of YAML serialization. */
import { expect, it } from 'vitest'
import { reverseOwnedConfig } from '../src/owned-fields.ts'

const value = (value: unknown) => ({ present: true as const, value })

it('restores absent fields without deleting new unrelated fields', () => {
  expect(reverseOwnedConfig({ present: false }, value({ a: 1, b: { c: 2 } }), value({ a: 1, b: { c: 2, d: 3 }, e: 4 })))
    .toEqual(value({ b: { d: 3 }, e: 4 }))
})

it('restores only the persona text within an unchanged array selector', () => {
  const before = { plugins: [{ id: 'persona', name: 'persona', config: { prefix: 'before', suffix: 'same' } }] }
  const after = { plugins: [{ id: 'persona', name: 'persona', config: { prefix: 'after', suffix: 'same' } }] }
  const current = { plugins: [{ id: 'persona', name: 'persona', config: { prefix: 'after', suffix: 'unrelated' } }] }
  expect(reverseOwnedConfig(value(before), value(after), value(current)))
    .toEqual(value({ plugins: [{ id: 'persona', name: 'persona', config: { prefix: 'before', suffix: 'unrelated' } }] }))
  current.plugins[0]!.id = 'different'
  expect(() => reverseOwnedConfig(value(before), value(after), value(current))).toThrow('identity changed')
})

it('refuses changed owned fields and ambiguous array structure', () => {
  expect(() => reverseOwnedConfig(value({ prefix: 'a' }), value({ prefix: 'b' }), value({ prefix: 'c' }))).toThrow('owned field changed')
  expect(() => reverseOwnedConfig(value([1]), value([2]), value([2, 3]))).toThrow('owned field changed')
})

it('restores a literal prototype-named field without changing the detached object prototype', () => {
  const before = JSON.parse('{"__proto__":{"owned":true}}') as Record<string, unknown>
  const result = reverseOwnedConfig(value(before), value({}), value({ unrelated: 1 }))
  expect(result).toEqual(value({ ...before, unrelated: 1 }))
  if (result.present && result.value !== null && typeof result.value === 'object') {
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype)
    expect(Object.hasOwn(result.value, '__proto__')).toBe(true)
  }
})

it('restores a deleted object while preserving fields concurrently reintroduced by another writer', () => {
  expect(reverseOwnedConfig(value({ owned: 1 }), { present: false }, value({ unrelated: 2 })))
    .toEqual(value({ owned: 1, unrelated: 2 }))
  expect(() => reverseOwnedConfig(value({ owned: 1 }), value({ owned: 2 }), { present: false }))
    .toThrow('owned field changed')
})

it('preserves untouched array slots and refuses identity replacement by a scalar', () => {
  const before = [{ id: 'fixed', value: 1 }, { id: 'edited', value: 2 }]
  const after = [{ id: 'fixed', value: 1 }, { id: 'edited', value: 3 }]
  expect(reverseOwnedConfig(value(before), value(after), value([{ id: 'fixed', value: 4 }, { id: 'edited', value: 3 }])))
    .toEqual(value([{ id: 'fixed', value: 4 }, { id: 'edited', value: 2 }]))
  expect(() => reverseOwnedConfig(value(before), value(after), value([before[0], 'replacement'])))
    .toThrow('identity changed')
})

it('restores absence after removing the last owned key from a prototype-free raw object', () => {
  const current = { owned: 1 }
  Object.setPrototypeOf(current, null)
  expect(reverseOwnedConfig({ present: false }, value({ owned: 1 }), value(current))).toEqual({ present: false })
})
