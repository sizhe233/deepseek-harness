/** Retained directory observations for cooperative complete generation audits. */
import { createHash } from 'node:crypto'
import { PrivateStorageError } from './error.ts'
import { sameIdentity, validateName } from './policy.ts'
import type { PrivateStreamDirectoryFacts, PrivateStreamDirectoryListing, PrivateStreamEntry } from './stream-directory-types.ts'
import type { WindowsWriterParent } from './windows-stream-writer.ts'
import { failWithWindowsCleanup, releaseWindowsResources, withWindowsInspection } from './windows-stream-cleanup.ts'

function directoryFacts(parent: WindowsWriterParent): PrivateStreamDirectoryFacts {
  parent.validate()
  const privateFacts = parent.api.inspect(parent.handle, parent.sid)
  const source = parent.api.inspectSource(parent.handle)
  if (privateFacts.kind !== 'directory' || source.kind !== 'directory' || !Number.isSafeInteger(source.links) || source.links < 1
    || !sameIdentity(privateFacts.identity, parent.identity) || !sameIdentity(source.identity, parent.identity)
    || privateFacts.lastWriteTime !== source.lastWriteTime || privateFacts.changeTime !== source.changeTime
    || privateFacts.attributes !== source.attributes) throw new PrivateStorageError('changed', 'private directory observations changed')
  const observations = Object.freeze({ volumeSerial: source.identity.volumeSerial, fileId: source.identity.fileId,
    lastWriteTime: source.lastWriteTime.toString(), changeTime: source.changeTime.toString(), attributes: source.attributes,
    ownerSid: privateFacts.ownerSid, daclProtected: true, securityDescriptorSha256: source.securityDescriptorSha256 })
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...source.identity }),
    links: source.links, observations, changeToken: createHash('sha256').update(JSON.stringify(observations)).digest('hex'), privateVerified: true })
}

/**
 * Enumerate every current child under a retained private parent and reject observed mutation.
 * @param parent Independently retained admitted private parent, consumed on every result.
 * @param maximum Explicit complete enumeration ceiling, from 0 through 100000.
 * @returns Complete current names and identities; callers separately admit each leaf and hold their management lease.
 */
export function listWindowsPrivateStreamDirectory(parent: WindowsWriterParent, maximum: number): PrivateStreamDirectoryListing {
  let result: PrivateStreamDirectoryListing
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100_000) throw new RangeError('directory entry ceiling must be from 0 through 100000')
    const before = directoryFacts(parent)
    const names = parent.api.names(parent.handle, maximum)
    const seen = new Set<string>()
    const entries: PrivateStreamEntry[] = []
    for (const name of names) {
      validateName(name)
      const key = name.toLowerCase()
      if (seen.has(key)) throw new PrivateStorageError('name', 'duplicate directory component')
      seen.add(key)
      const handle = parent.api.open(parent.handle, name, 'any', 'inspect', parent.sid)
      const entry = withWindowsInspection(parent.api, handle, () => {
        parent.api.verifyName(handle, name)
        const facts = parent.api.inspectSource(handle)
        if (facts.identity.volumeSerial !== parent.identity.volumeSerial) throw new PrivateStorageError('identity', 'directory child volume changed')
        return Object.freeze({ name, kind: facts.kind, identity: Object.freeze({ backend: 'windows-ntfs' as const, ...facts.identity }) })
      })
      entries.push(entry)
    }
    const after = directoryFacts(parent)
    if (before.changeToken !== after.changeToken) throw new PrivateStorageError('changed', 'directory changed during enumeration')
    result = Object.freeze({ before, after, entries: Object.freeze(entries), complete: true })
  } catch (error) { failWithWindowsCleanup(error, () => { parent.release() }) }
  releaseWindowsResources([() => { parent.release() }])
  return result
}

/**
 * Observe one already admitted retained private directory.
 * @param parent Independently retained private parent, consumed on every outcome.
 * @returns Full current directory metadata without implying enumeration or capacity reservation.
 */
export function inspectWindowsPrivateStreamDirectory(parent: WindowsWriterParent): PrivateStreamDirectoryFacts {
  let facts: PrivateStreamDirectoryFacts
  try { facts = directoryFacts(parent) }
  catch (error) { failWithWindowsCleanup(error, () => { parent.release() }) }
  releaseWindowsResources([() => { parent.release() }])
  return facts
}
