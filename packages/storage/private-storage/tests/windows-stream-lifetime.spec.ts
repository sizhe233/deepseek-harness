/** Synthetic actual-factory ownership controls; abrupt native Worker termination remains a separate required test. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { NativeStorageBackend as NativeStorage } from '../src/native.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'
import { FakeNative } from './fake-native.ts'

const selected = vi.hoisted(() => ({ api: undefined as unknown as NativeStorage }))
vi.mock('../src/native.ts', async original => ({ ...await original<object>(), loadNativeStorage: () => selected.api }))

it('the existing root directory is accepted by its stream facade after its caller closes it', async () => {
  const native = new FakeNative(); selected.api = native.asNative()
  const storage = await import('../src/index.ts')
  const parent = storage.openPrivateDirectory('C:\\private', { create: false })
  const writer = storage.createPrivateFileWriter(parent, 'record', { operationId: 'root-interop' as PrivateStreamOperationId,
    expectedBytes: 3, expectedSha256: createHash('sha256').update('abc').digest('hex'), replace: false, executable: false })
  parent.close()
  writer.append(Buffer.from('a')); writer.append(Buffer.from('bc'))
  expect(writer.finish().publication).toBe('published')
  expect(native.handles.size).toBe(0)
})

it('a directory from a different provider copy cannot authorize a stream', async () => {
  const native = new FakeNative(); selected.api = native.asNative()
  const first = await import('../src/index.ts')
  const parent = first.openPrivateDirectory('C:\\private', { create: false })
  vi.resetModules()
  const foreign = await import('../src/index.ts')
  const before = [...native.events]
  expect(() => foreign.createPrivateFileWriter(parent, 'record', { operationId: 'foreign-copy' as PrivateStreamOperationId,
    expectedBytes: 0, expectedSha256: createHash('sha256').digest('hex'), replace: false, executable: false })).toThrow(expect.objectContaining({ code: 'closed' }))
  expect(native.events).toEqual(before)
  parent.close()
})

it.each(['writer', 'source'])('actual dropped %s factories release retained handles without namespace mutation', (kind) => {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/stream-gc-worker.mjs', import.meta.url)), kind],
    { encoding: 'utf8', timeout: 25_000 })
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status, child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({ kind, explicitClose: true, collected: true, handles: 0, namespaceMutationByGc: false })
})
