/** Instrumented process-registry validation and immutable outer capability lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest'

const registrySlot = Symbol.for('@deepseek-ai/dsh/outer-bootstrap/v1')
const protocol = 'dsh-outer-bootstrap-v1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('outer runtime bootstrap registry compatibility', () => {
  it.each([
    { name: 'null', value: null },
    { name: 'a primitive', value: protocol },
    { name: 'a mutable registry', value: { protocol, register: vi.fn(), consume: vi.fn() } },
    { name: 'a missing protocol', value: Object.freeze({ register: vi.fn(), consume: vi.fn() }) },
    { name: 'a different protocol', value: Object.freeze({ protocol: 'dsh-outer-bootstrap-v0', register: vi.fn(), consume: vi.fn() }) },
    { name: 'a missing registration method', value: Object.freeze({ protocol, consume: vi.fn() }) },
    { name: 'a non-callable registration method', value: Object.freeze({ protocol, register: true, consume: vi.fn() }) },
    { name: 'a missing consumption method', value: Object.freeze({ protocol, register: vi.fn() }) },
    { name: 'a non-callable consumption method', value: Object.freeze({ protocol, register: vi.fn(), consume: true }) },
  ])('rejects $name before either capability operation', async ({ value }) => {
    const originalGet = Reflect.get
    vi.spyOn(Reflect, 'get').mockImplementation((...args): unknown => {
      if (args[0] === globalThis && args[1] === registrySlot) return value
      return originalGet(...args)
    })
    const bootstrap = await import('../src/runtime-outer-bootstrap.ts')
    const slot = Symbol('incompatible-registry-slot')
    expect(() => { bootstrap.registerRuntimeOuterCapability(slot, {}) }).toThrow('Outer runtime bootstrap registry is incompatible')
    expect(() => bootstrap.runtimeOuterCapability(slot)).toThrow('Outer runtime bootstrap registry is incompatible')
  })
})

it('shares immutable capabilities across module copies and seals every slot on first consumption', async () => {
  const first = await import('../src/runtime-outer-bootstrap.ts')
  const firstSlot = Symbol('outer-first')
  const secondSlot = Symbol('outer-second')
  const missingSlot = Symbol('outer-missing')
  const firstCapability = { install: vi.fn() }
  const secondCapability = { install: vi.fn() }

  expect(Object.getOwnPropertyDescriptor(globalThis, registrySlot)).toBeUndefined()
  first.registerRuntimeOuterCapability(firstSlot, firstCapability)
  const registry: unknown = Reflect.get(globalThis, registrySlot)
  expect(Object.getOwnPropertyDescriptor(globalThis, registrySlot)).toEqual({
    value: registry,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  expect(Object.isFrozen(registry)).toBe(true)
  expect(registry).toHaveProperty('protocol', protocol)
  expect(registry).toHaveProperty('register', expect.any(Function))
  expect(registry).toHaveProperty('consume', expect.any(Function))
  expect(Reflect.set(globalThis, registrySlot, {})).toBe(false)
  expect(Reflect.deleteProperty(globalThis, registrySlot)).toBe(false)
  expect(() => Object.defineProperty(globalThis, registrySlot, { value: {} })).toThrow(TypeError)

  expect(() => { first.registerRuntimeOuterCapability(firstSlot, {}) }).toThrow('Outer runtime bootstrap authority is already fixed')
  vi.resetModules()
  const second = await import('../src/runtime-outer-bootstrap.ts')
  expect(second.registerRuntimeOuterCapability).not.toBe(first.registerRuntimeOuterCapability)
  expect(second.runtimeOuterCapability).not.toBe(first.runtimeOuterCapability)
  second.registerRuntimeOuterCapability(secondSlot, secondCapability)
  expect(Reflect.get(globalThis, registrySlot)).toBe(registry)
  expect(() => { second.registerRuntimeOuterCapability(firstSlot, {}) }).toThrow('Outer runtime bootstrap authority is already fixed')

  expect(second.runtimeOuterCapability(missingSlot)).toBeUndefined()
  expect(first.runtimeOuterCapability(firstSlot)).toBe(firstCapability)
  expect(first.runtimeOuterCapability(secondSlot)).toBe(secondCapability)
  expect(second.runtimeOuterCapability(firstSlot)).toBe(firstCapability)
  expect(second.runtimeOuterCapability(secondSlot)).toBe(secondCapability)
  expect(() => { first.registerRuntimeOuterCapability(missingSlot, {}) }).toThrow('Outer runtime bootstrap authority is already fixed')
  expect(() => { second.registerRuntimeOuterCapability(Symbol('outer-late'), {}) }).toThrow('Outer runtime bootstrap authority is already fixed')
  expect(() => { second.registerRuntimeOuterCapability(firstSlot, firstCapability) }).toThrow('Outer runtime bootstrap authority is already fixed')
  expect(firstCapability.install).not.toHaveBeenCalled()
  expect(secondCapability.install).not.toHaveBeenCalled()
})
