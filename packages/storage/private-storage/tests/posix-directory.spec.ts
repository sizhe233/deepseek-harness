/** Native-return conformance models; no model is persistent-filesystem acceptance. */
import { expect, it, vi } from 'vitest'
import type { PosixStorageDirectory, PosixStorageFacts, PosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import { createPosixPrivateStreamChild, listPosixPrivateStreamDirectory, observePosixPrivateStreamCapacity, openPosixPrivateDirectory } from '../src/native-posix.ts'
const provider = vi.hoisted(() => ({ native: undefined as PosixStoragePrimitives | undefined }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({ loadPosixStoragePrimitives: () => provider.native }))
const facts: PosixStorageFacts = { kind: 'directory', dev: '1', ino: '1', uid: '1000', gid: '1000', mode: 0o40700,
  nlink: '2', size: '0', mtimeNs: '1', ctimeNs: '1', platform: 'linux',
  filesystem: { type: '61267', name: 'ext-family', readOnly: false, fsid: 'observed', blockSize: '4096' },
  acl: { model: 'linux-posix-mode-mask', entries: 0, defaultEntries: 0, supported: true }, bindingVerified: true,
  created: false, creationSync: { directory: false, parent: false }, bytesRead: '0', bytesWritten: '0', published: false, removed: false }
function fixture() {
  const parent = {} as PosixStorageDirectory, child = {} as PosixStorageDirectory
  const state = { synced: true, changed: false, closed: 0, afterList: false, failClose: false, emptyOnly: -1 }
  const unavailable = (): never => { throw new Error('Unrequested native operation') }
  provider.native = {
    observeProcessBirth: unavailable, openDirectory: () => parent, openChild: unavailable,
    createPrivateChild: () => ({ capability: child, facts: { ...facts, ino: '2' }, parentBeforeFacts: facts, parentAfterFacts: facts,
      published: true, mechanism: 'mkdirat', creationSync: { directory: state.synced, parent: state.synced } }),
    openPrivateOutput: unavailable,
    listDirectory: (_parent: PosixStorageDirectory, max: number) => { state.emptyOnly = max; state.afterList = true
      return { entries: [], parentBeforeFacts: facts, parentAfterFacts: facts, complete: true } },
    observeCapacity: () => ({ filesystem: facts.filesystem, allocationUnitBytes: '4096', availableBytes: '8192', freeEntries: '10',
      availableEntries: '7', parentBeforeFacts: facts, parentAfterFacts: facts, reservation: false }),
    openSource: unavailable, openPrivateRecord: unavailable, createFile: unavailable, acquireLease: unavailable,
    replacePrivateRecord: unavailable,
    inspect: (value: PosixStorageDirectory) => ({ ...facts, ino: value === child ? '2' : '1', ctimeNs: state.changed && state.afterList ? '2' : '1' }),
    inspectBinding: unavailable, inspectFileBinding: unavailable, read: unavailable, write: unavailable, setExecutable: unavailable,
    syncFile: unavailable, syncDirectory: unavailable, publish: unavailable, removeUnpublished: unavailable,
    close: () => { state.closed++; if (state.failClose) throw new Error('Unconfirmed native release'); return { closed: true } },
  } as unknown as PosixStoragePrimitives
  return { state, directory: openPosixPrivateDirectory('/model-private', { create: false }) }
}
it('preserves admitted directory identity and distinct successful child/parent sync', () => {
  const f = fixture(), result = createPosixPrivateStreamChild(f.directory, 'child')
  expect(result.directory.identity).toEqual({ backend: 'posix', device: '1', inode: '2' })
  expect(result.receipt).toMatchObject({ publication: 'published', durability: 'synced', privacyVerification: 'verified',
    synchronization: { child: 'succeeded', parent: 'succeeded' }, release: 'retained' })
  result.directory.close(); f.directory.close(); expect(f.state.closed).toBe(2)
})
it('does not manufacture synchronized facts from an incomplete native child result', () => {
  const f = fixture(); f.state.synced = false
  let failure: unknown
  try { createPosixPrivateStreamChild(f.directory, 'child') } catch (error) { failure = error }
  expect(failure).toMatchObject({ receipt: {
    publication: 'published', durability: 'unconfirmed', privacyVerification: 'unverified', release: 'released' } })
  expect(f.state.closed).toBe(1); f.directory.close()
})
it('keeps unconfirmed release separate from observed child publication', () => {
  const f = fixture(); f.state.synced = false; f.state.failClose = true
  let failure: unknown
  try { createPosixPrivateStreamChild(f.directory, 'child') } catch (error) { failure = error }
  expect(failure).toMatchObject({ receipt: { publication: 'published', durability: 'unconfirmed', release: 'failed' } })
  expect(f.state.closed).toBe(1); f.state.failClose = false; f.directory.close()
})
it('passes zero as an empty-only native listing bound and records actual directory links', () => {
  const f = fixture(), result = listPosixPrivateStreamDirectory(f.directory, { maxEntries: 0 })
  expect(f.state.emptyOnly).toBe(0); expect(result.entries).toEqual([]); expect(result.before.links).toBe(2); f.directory.close()
})
it('refuses a changed complete listing instead of returning a complete success', () => {
  const f = fixture(); f.state.changed = true
  expect(() => listPosixPrivateStreamDirectory(f.directory, { maxEntries: 10 })).toThrow('changed')
  f.directory.close()
})
it('reports native available capacity without upgrading it to a reservation', () => {
  const f = fixture(), result = observePosixPrivateStreamCapacity(f.directory)
  expect(result).toEqual({ directoryIdentity: { backend: 'posix', device: '1', inode: '1' }, filesystemId: 'observed',
    allocationUnitBytes: '4096', availableBytes: '8192', availableEntries: '7', scope: 'observed-filesystem-capacity' })
  f.directory.close()
})
