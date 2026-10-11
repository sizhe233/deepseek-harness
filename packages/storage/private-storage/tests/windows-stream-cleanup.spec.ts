/** Cleanup composition preserves established operation diagnostics and attempts every owned release. */
import { expect, it, vi } from 'vitest'
import { PrivateStorageError } from '../src/error.ts'
import { SourceObservationError } from '../src/stream-error.ts'
import { failWithWindowsCleanup, releaseWindowsResources } from '../src/windows-stream-cleanup.ts'
import type { PublicationReceipt } from '../src/types.ts'

it('retains a known publication receipt when an owned release fails', () => {
  const receipt: PublicationReceipt = { phase: 'publish', publication: 'published', durability: 'unconfirmed', cleanup: 'withheld',
    identity: null, parentIdentity: { volumeSerial: '1', fileId: '2' }, nativeStatus: null }
  const original = new PrivateStorageError('native', 'publication acknowledgement lost', { receipt, win32Code: 5 })
  const close = vi.fn(() => { throw new Error('close failed') })
  expect(() => failWithWindowsCleanup(original, close)).toThrow(expect.objectContaining({ receipt, win32Code: 5, cleanupFailed: true }))
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps a proven source change when cleanup also fails and still attempts every independent close', () => {
  const changed = new SourceObservationError(new PrivateStorageError('changed', 'source changed'))
  const close = vi.fn()
  const cause: unknown = expect.objectContaining({ cleanupFailed: true, cause: changed })
  expect(() =>{  releaseWindowsResources([() => { throw changed }, close]) }).toThrow(expect.objectContaining({
    name: 'SourceObservationError', cause }))
  expect(close).toHaveBeenCalledTimes(1)
})
