/** New root enrollment retains the existing parent without changing its security. */
import { win32 } from 'node:path'
import { PrivateStorageError } from './error.ts'
import { sameIdentity, splitRootPath } from './policy.ts'
import { openWindowsSourceDirectory, inspectWindowsSourceDirectory } from './windows-source-reader.ts'
import { PrivateStreamRootError } from './root-opening.ts'
import type { PrivateStreamRootReceipt } from './root-opening.ts'
import type { PrivateDirectory, PublicationReceipt } from './types.ts'
import type { PrivateStreamDirectoryPublication } from './stream-directory-types.ts'
import type { WindowsStreamOwner } from './windows-stream-facade.ts'

function publication(value: PublicationReceipt, name: string): PrivateStreamDirectoryPublication {
  const complete = value.phase === 'complete' && value.publication === 'published' && value.durability === 'synced'
    && value.cleanup === 'not-needed'
  return Object.freeze({ name, mechanism: 'windows-ntfs-write-through-directory-rename-v1',
    parentIdentity: Object.freeze({ backend: 'windows-ntfs', ...value.parentIdentity }),
    identity: value.identity === null ? null : Object.freeze({ backend: 'windows-ntfs', ...value.identity }),
    publication: value.publication, durability: value.durability === 'synced' ? 'synced' : 'unconfirmed',
    bindingVerification: complete ? 'verified' : 'unverified', privacyVerification: complete ? 'verified' : 'unverified',
    synchronization: Object.freeze({ child: 'not-required', parent: 'not-required' }),
    release: value.cleanup === 'failed' ? 'failed' : 'retained' })
}
/**
 * Open or create only the final root below an existing independently retained parent.
 * @param owner Root-owned Windows capability domain.
 * @param path Literal local path whose parent already exists.
 * @param options Whether an absent final component may be privately published.
 * @returns Legacy capability with publication identities matched to that retained root and parent.
 */
export function openWindowsPrivateStreamRoot(owner: WindowsStreamOwner, path: string, options: { create: boolean }): {
  directory: PrivateDirectory
  receipt: PrivateStreamRootReceipt
} {
  splitRootPath(path)
  const name = win32.basename(path), parent = openWindowsSourceDirectory(win32.dirname(path))
  let directory: PrivateDirectory | undefined
  let parentReleaseAttempted = false, parentReleased = false
  let receipt: PrivateStreamRootReceipt = { kind: 'indeterminate', name, identity: null, parentIdentity: parent.identity,
    parentBefore: null, parentAfter: null, bindingVerification: 'unverified', privacyVerification: 'unverified',
    durability: 'unconfirmed', publications: [], release: 'released' }
  try {
    const before = inspectWindowsSourceDirectory(parent)
    receipt = { ...receipt, parentBefore: before }
    directory = owner.openDirectory(path, options)
    const rootIdentity = directory.identity
    const publications = directory.publications.map(value => publication(value, name))
    receipt = { ...receipt, identity: Object.freeze({ backend: 'windows-ntfs', ...directory.identity }), publications,
      kind: publications.length === 0 ? 'existing-root' : 'created', release: 'retained', privacyVerification: 'verified',
      durability: publications.length === 0 ? 'not-attempted' : 'unconfirmed' }
    const after = inspectWindowsSourceDirectory(parent)
    const retainedParent = owner.rootParentIdentity(directory)
    receipt = { ...receipt, parentAfter: after }
    if (before.identity.backend !== 'windows-ntfs' || after.identity.backend !== 'windows-ntfs'
      || !sameIdentity(before.identity, after.identity)
      || !sameIdentity(before.identity, retainedParent)
      || before.observations.securityDescriptorSha256 !== after.observations.securityDescriptorSha256
      || before.observations.attributes !== after.observations.attributes || publications.length > 1
      || directory.publications.some(value => value.identity === null || !sameIdentity(value.identity, rootIdentity))
      || publications.some(value => value.publication !== 'published' || value.durability !== 'synced'
        || value.bindingVerification !== 'verified' || value.parentIdentity.backend !== 'windows-ntfs'
        || !sameIdentity(value.parentIdentity, retainedParent))) throw new PrivateStorageError('changed', 'root parent or publication changed')
    receipt = { ...receipt, bindingVerification: 'verified', durability: publications.length === 0 ? 'not-attempted' : 'synced' }
    parentReleaseAttempted = true
    parent.close()
    parentReleased = true
    return { directory, receipt: Object.freeze(receipt) }
  } catch (error) {
    const failures = [error]
    if (error instanceof PrivateStorageError && receipt.publications.length === 0) {
      const known = [...error.directoryPublications, ...error.receipt === undefined ? [] : [error.receipt]]
      receipt = { ...receipt, publications: known.map(value => publication(value, name)) }
    }
    for (const capability of [directory, ...parentReleaseAttempted ? [] : [parent]]) {
      try { capability?.close() } catch (releaseError) { failures.push(releaseError) }
    }
    receipt = { ...receipt, release: failures.length > 1 || (parentReleaseAttempted && !parentReleased)
      || error instanceof PrivateStorageError && error.cleanupFailed ? 'failed' : 'released' }
    throw new PrivateStreamRootError(receipt, failures.length === 1 ? error : new AggregateError(failures))
  }
}
