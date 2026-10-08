/** Same-process outer bootstrap registration shared by packaged/inlined copies of this application-free leaf. */
const REGISTRY = Symbol.for('@deepseek-ai/dsh/outer-bootstrap/v1')
interface OuterBootstrapRegistry {
  readonly protocol: 'dsh-outer-bootstrap-v1'
  register(slot: symbol, capability: object): void
  consume(slot: symbol): object | undefined
}
function registry(): OuterBootstrapRegistry {
  const current: unknown = Reflect.get(globalThis, REGISTRY)
  if (current !== undefined) {
    if (current === null || typeof current !== 'object' || !Object.isFrozen(current)
      || !('protocol' in current) || current.protocol !== 'dsh-outer-bootstrap-v1'
      || !('register' in current) || typeof current.register !== 'function'
      || !('consume' in current) || typeof current.consume !== 'function') throw new Error('Outer runtime bootstrap registry is incompatible')
    return current as OuterBootstrapRegistry
  }
  const capabilities = new Map<symbol, object>()
  let consumed = false
  const value: OuterBootstrapRegistry = Object.freeze({ protocol: 'dsh-outer-bootstrap-v1',
    register(slot: symbol, capability: object) {
      if (consumed || capabilities.has(slot)) throw new Error('Outer runtime bootstrap authority is already fixed')
      capabilities.set(slot, capability)
    },
    consume(slot: symbol) { consumed = true; return capabilities.get(slot) },
  })
  Object.defineProperty(globalThis, REGISTRY, { value, enumerable: false, configurable: false, writable: false })
  return value
}
/**
 * Register an in-memory installer capability before importing the outer application's main module.
 * Symbols are fixed public protocol slots, never values parsed from argv, environment or browser messages.
 * @param slot Fixed capability slot.
 * @param capability Native installer-owned object; no module discovery or deserialization occurs.
 */
export function registerRuntimeOuterCapability(slot: symbol, capability: object): void { registry().register(slot, capability) }
/**
 * Consume a fixed outer capability, sealing all registrations at the first application use.
 * @param slot Fixed capability slot owned by the consumer module.
 * @returns The same process-local object, shared with separately imported or bundled copies of this leaf.
 */
export function runtimeOuterCapability(slot: symbol): object | undefined { return registry().consume(slot) }
