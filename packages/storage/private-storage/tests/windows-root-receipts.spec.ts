/** Root receipts under injected provider failures; no native Windows admission is claimed. */
import { expect, it, vi } from 'vitest'
import { PrivateStorageError } from '../src/error.ts'
import { openWindowsPrivateStreamRoot } from '../src/windows-root-opening.ts'
import type { WindowsStreamOwner } from '../src/windows-stream-facade.ts'
import type { PrivateDirectory, PrivateIdentity, PublicationReceipt } from '../src/types.ts'
import type { SourceDirectoryFacts } from '../src/source-directory-types.ts'

const source = vi.hoisted(() => ({
  close: vi.fn(), inspect: vi.fn<() => SourceDirectoryFacts>(),
  identity: { backend: 'windows-ntfs' as const, volumeSerial: '1', fileId: '1' },
}))
vi.mock('../src/windows-source-reader.ts', () => ({
  openWindowsSourceDirectory: () => ({ identity: source.identity, close: source.close }),
  inspectWindowsSourceDirectory: () => source.inspect(),
}))
const parentIdentity: PrivateIdentity = { volumeSerial: '1', fileId: '1' }
const identity: PrivateIdentity = { volumeSerial: '1', fileId: '2' }
const observed: SourceDirectoryFacts = { identity: { backend: 'windows-ntfs', ...parentIdentity }, links: 1,
  observations: { securityDescriptorSha256: 'a'.repeat(64), attributes: 0 }, changeToken: 'a'.repeat(64) }
const publication: PublicationReceipt = { identity, parentIdentity, phase: 'complete', publication: 'published',
  durability: 'synced', cleanup: 'not-needed', nativeStatus: null }
function fixture(publications: readonly PublicationReceipt[] = []) {
  source.close.mockReset(); source.inspect.mockReset().mockReturnValue(observed)
  const close = vi.fn(), directory = { identity, publications, close: () => { close() } } as PrivateDirectory
  const unavailable = (): never => { throw new Error('Unrequested root operation') }
  const owner: WindowsStreamOwner = { openDirectory: () => directory, rootParentIdentity: () => parentIdentity,
    openChild: unavailable, createChild: unavailable, retainParent: unavailable, acquireLease: unavailable, assertLease: unavailable }
  return { owner, directory, close, run: () => openWindowsPrivateStreamRoot(owner, 'C:\\model\\managed', { create: true }) }
}
function caught(operation: () => unknown): unknown { try { operation() } catch (error) { return error }; throw new Error('Expected failure') }

it('rejects a drive-only enrollment before acquiring an existing parent', () => {
  const f = fixture()
  expect(() => openWindowsPrivateStreamRoot(f.owner, 'C:\\', { create: false })).toThrow()
  expect(source.inspect).not.toHaveBeenCalled()
})

it.each(['unconfirmed', 'cleanup-failed', 'wrong-parent', 'multiple'] as const)('refuses incomplete root publication: %s', (mode) => {
  const receipt = { ...publication,
    ...(mode === 'unconfirmed' ? { durability: 'unconfirmed' as const } : {}),
    ...(mode === 'cleanup-failed' ? { cleanup: 'failed' as const } : {}),
    ...(mode === 'wrong-parent' ? { parentIdentity: { ...parentIdentity, fileId: 'foreign' } } : {}) }
  const f = fixture(mode === 'multiple' ? [receipt, receipt] : [receipt])
  expect(caught(f.run)).toMatchObject({ receipt: { kind: 'created', bindingVerification: 'unverified', release: 'released' } })
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(source.close).toHaveBeenCalledTimes(1)
})

it.each([false, true])('preserves native opening publication evidence and cleanup status: %s', (cleanupFailed) => {
  const f = fixture(), incomplete = { ...publication, publication: 'indeterminate' as const, durability: 'unsupported' as const, identity: null,
    cleanup: cleanupFailed ? 'failed' as const : 'withheld' as const }
  const error = new PrivateStorageError('native', 'opening failed', { receipt: incomplete, directoryPublications: [publication], cleanupFailed })
  f.owner.openDirectory = () => { throw error }
  expect(caught(f.run)).toMatchObject({ cause: error, receipt: { release: cleanupFailed ? 'failed' : 'released',
    publications: [{ publication: 'published', bindingVerification: 'verified' },
      { publication: 'indeterminate', identity: null, durability: 'unconfirmed', bindingVerification: 'unverified', release: cleanupFailed ? 'failed' : 'retained' }] } })
  expect(f.close).not.toHaveBeenCalled(); expect(source.close).toHaveBeenCalledTimes(1)
})

it('retains a known ancestor publication when no last-entry receipt is available', () => {
  const f = fixture(), error = new PrivateStorageError('native', 'opening failed', { directoryPublications: [publication] })
  f.owner.openDirectory = () => { throw error }
  expect(caught(f.run)).toMatchObject({ receipt: { publications: [expect.objectContaining({ publication: 'published' })] } })
})

it('reports root and parent release failures together after a changed parent observation', () => {
  const f = fixture(), rootRelease = new Error('root close failed'), parentRelease = new Error('parent close failed')
  source.inspect.mockReturnValueOnce(observed).mockReturnValue({ ...observed, observations: { ...observed.observations, attributes: 1 } })
  f.close.mockImplementation(() => { throw rootRelease }); source.close.mockImplementation(() => { throw parentRelease })
  expect(caught(f.run)).toMatchObject({ receipt: { release: 'failed' }, cause: { errors: [expect.any(PrivateStorageError), rootRelease, parentRelease] } })
  expect(f.close).toHaveBeenCalledTimes(1); expect(source.close).toHaveBeenCalledTimes(1)
})

it('releases its parent after an ordinary open failure without inventing publication', () => {
  const f = fixture(), failure = new Error('open failed')
  f.owner.openDirectory = () => { throw failure }
  expect(caught(f.run)).toMatchObject({ cause: failure, receipt: { publications: [], release: 'released' } })
  expect(source.close).toHaveBeenCalledTimes(1)
})

it.each([null, { volumeSerial: '1', fileId: 'foreign' }])('refuses publication without the retained root identity: %j', (publishedIdentity) => {
  const f = fixture([{ ...publication, identity: publishedIdentity }])
  expect(caught(f.run)).toMatchObject({ receipt: { kind: 'created', bindingVerification: 'unverified', release: 'released' },
    cause: { code: 'changed' } })
  expect(f.close).toHaveBeenCalledTimes(1); expect(source.close).toHaveBeenCalledTimes(1)
})
