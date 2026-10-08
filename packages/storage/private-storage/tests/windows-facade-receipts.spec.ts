/** Windows wrapper validation with synthetic legacy-owner receipts, without native platform acceptance. */
import { expect, it, vi } from 'vitest'
import { createWindowsStreamFacade, type WindowsStreamOwner } from '../src/windows-stream-facade.ts'
import type { PrivateDirectory, PublicationReceipt } from '../src/types.ts'
import type { PrivateStreamDirectory } from '../src/stream-directory-types.ts'

it('refuses a foreign wrapper before requesting any native parent', () => {
  const unavailable = vi.fn((): never => { throw new Error('Unrequested native operation') })
  const facade = createWindowsStreamFacade({ openDirectory: unavailable, openChild: unavailable, createChild: unavailable,
    retainParent: unavailable, rootParentIdentity: unavailable, acquireLease: unavailable, assertLease: unavailable })
  expect(() => facade.openChild({} as PrivateStreamDirectory, 'child')).toThrow(/another provider/u)
  expect(unavailable).not.toHaveBeenCalled()
})

it.each([false, true])('closes an incompletely published directory and preserves release uncertainty: %s', (failClose) => {
  const identity = { volumeSerial: '1', fileId: '2' }
  const close = vi.fn(() => { if (failClose) throw new Error('release failed') })
  const publications: readonly PublicationReceipt[] = []
  const directory = { identity, publications, close: () => { close() } } as PrivateDirectory
  const receipt: PublicationReceipt = { identity, parentIdentity: identity, phase: 'publish', publication: 'published',
    durability: 'unconfirmed', cleanup: 'withheld', nativeStatus: null }
  const unavailable = (): never => { throw new Error('Unrequested native operation') }
  const owner: WindowsStreamOwner = { openDirectory: () => directory, createChild: () => ({ directory, receipt }),
    openChild: unavailable, retainParent: unavailable, rootParentIdentity: unavailable,
    acquireLease: unavailable, assertLease: unavailable }
  const facade = createWindowsStreamFacade(owner), root = facade.openDirectory('C:\\model', { create: false })
  expect(() => facade.createChild(root, 'child')).toThrow(expect.objectContaining({ receipt, cleanupFailed: failClose }))
  expect(close).toHaveBeenCalledTimes(1)
})
