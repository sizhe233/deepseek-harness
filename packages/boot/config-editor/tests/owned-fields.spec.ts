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
