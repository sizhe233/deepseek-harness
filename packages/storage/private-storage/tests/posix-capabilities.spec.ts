/** Availability shape checks do not establish destination or native-platform acceptance. */
import { expect, it, vi } from 'vitest'
import { posixStreamCapabilities } from '../src/native-posix.ts'
const fixture = vi.hoisted(() => ({ error: undefined as unknown }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({
  inspectPosixStorageRuntime: () => { if (fixture.error !== undefined) throw fixture.error; return { platform: 'linux', architecture: 'x64', nodeApi: 8 } },
  loadPosixStoragePrimitives: () => { throw new Error('Destination open is not part of availability') },
}))
it('reports native observed platform identity with separately declared limits', () => {
  fixture.error = undefined
  expect(posixStreamCapabilities()).toMatchObject({ available: true, platform: 'linux', architecture: 'x64', backend: 'posix',
    maxStreamBytes: 1024 * 1024 * 1024, maxChunkBytes: 1024 * 1024, acceptance: 'unverified', nativeIdentity: { nodeApi: 8 } })
})
it('retains unavailable native failure and actual host identity without inventing a backend success', () => {
  const error = new Error('Exact native payload missing'); fixture.error = error
  expect(posixStreamCapabilities()).toMatchObject({ available: false, backend: 'posix', platform: process.platform, architecture: process.arch,
    error, reason: error.message, maxStreamBytes: 1024 * 1024 * 1024, maxChunkBytes: 1024 * 1024, acceptance: 'unverified' })
  fixture.error = 'non-error failure'
  expect(posixStreamCapabilities()).toMatchObject({ available: false, error: 'non-error failure', reason: 'POSIX native provider unavailable' })
})
