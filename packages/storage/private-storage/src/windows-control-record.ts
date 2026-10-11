/** Fixed generated-record replacement under an independently retained Windows management lease. */
import type { ControlRecordObjectObservation, ControlRecordReplacementFacts, ControlRecordResource } from './control-record.ts'
import { PrivateStorageError } from './error.ts'
import { sameIdentity } from './policy.ts'
import { SourceObservationError } from './stream-error.ts'
import type { SourceFileFacts } from './stream-types.ts'
import { openWindowsPrivateRecordResource } from './windows-private-record.ts'
import { createWindowsWriterResource } from './windows-stream-writer.ts'
import type { WindowsWriterParent } from './windows-stream-writer.ts'
import { withWindowsInspection } from './windows-stream-cleanup.ts'

function observations(parent: WindowsWriterParent): ControlRecordObjectObservation {
  parent.validate()
  const facts = parent.api.inspectSource(parent.handle)
  if (facts.kind !== 'directory' || !sameIdentity(facts.identity, parent.identity)) throw new PrivateStorageError('identity', 'control parent changed')
  return Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...facts.identity }), observations: Object.freeze({
    lastWriteTime: facts.lastWriteTime.toString(), changeTime: facts.changeTime.toString(), attributes: facts.attributes,
    securityDescriptorSha256: facts.securityDescriptorSha256,
  }) })
}
function sameSource(left: SourceFileFacts, right: SourceFileFacts): boolean {
  return left.changeToken === right.changeToken && left.identity.backend === 'windows-ntfs' && right.identity.backend === 'windows-ntfs'
    && sameIdentity(left.identity, right.identity) && left.sizeBytes === right.sizeBytes && left.links === right.links
}

/**
 * Open a private current record and retain its object through one generated-record replacement.
 * @param parent Independently retained private parent consumed by the returned current-record resource.
 * @param name Fixed name admitted by the generated-record owner.
 * @param assertLease Verifies the caller-owned same-parent management lease without closing it.
 * @param retainStageParent Factory retaining an additional private parent for staging and publication.
 * @returns Shared control resource; the current record is read once and cannot be replaced through an immutable writer.
 */
export function openWindowsControlRecordResource(
  parent: WindowsWriterParent, name: string, assertLease: () => void, retainStageParent: () => WindowsWriterParent,
): ControlRecordResource {
  const target = openWindowsPrivateRecordResource(parent, name, true)
  let closed = false
  let stagingCreated = false
  let admitted: SourceFileFacts | null = null
  const inspectCurrent = () => {
    if (closed) throw new PrivateStorageError('closed', 'current control record closed')
    assertLease()
    const facts = target.inspect()
    if (admitted !== null && !sameSource(admitted, facts)) throw new SourceObservationError(new PrivateStorageError('changed', 'control source changed'))
    admitted ??= facts
    return facts
  }
  return {
    inspectCurrent,
    readCurrent: count => target.read(count),
    createStaging: () => {
      if (stagingCreated) throw new PrivateStorageError('closed', 'control staging was already consumed')
      inspectCurrent()
      stagingCreated = true
      const stageParent = retainStageParent()
      let before: ReturnType<typeof inspectCurrent>
      let parentBefore: ControlRecordObjectObservation
      let replacement: ControlRecordReplacementFacts | null = null
      const afterReplacement = (): ControlRecordReplacementFacts => {
        assertLease()
        const retired = target.observeRetired()
        if (!sameIdentity(retired.identity, before.identity) || retired.kind !== 'file'
          || retired.sizeBytes !== BigInt(before.sizeBytes) || (!retired.deletePending && retired.links !== 0)) {
          throw new PrivateStorageError('changed', 'admitted current record retirement is not confirmed')
        }
        const parentAfter = observations(stageParent)
        return Object.freeze({ replacedBefore: Object.freeze({ identity: before.identity, observations: before.observations }),
          replacedAfter: Object.freeze({ identity: Object.freeze({ backend: 'windows-ntfs', ...retired.identity }),
            observations: Object.freeze({ sizeBytes: retired.sizeBytes.toString(), links: retired.links,
              lastWriteTime: retired.lastWriteTime.toString(), changeTime: retired.changeTime.toString(),
              deletePending: retired.deletePending, securityDescriptorSha256: retired.securityDescriptorSha256 }) }),
          stagingParent: parentBefore, targetParent: parentBefore, parentAfter })
      }
      const stage = createWindowsWriterResource(stageParent, name, {
        beforeRename() {
          before = inspectCurrent()
          parentBefore = observations(stageParent)
          const selected = stageParent.api.open(stageParent.handle, name, 'file', 'inspect', stageParent.sid)
          withWindowsInspection(stageParent.api, selected, () => {
            stageParent.api.verifyName(selected, name)
            const current = stageParent.api.inspect(selected, stageParent.sid)
            if (!sameIdentity(current.identity, before.identity)) {
              throw new PrivateStorageError('changed', 'current record binding changed before replacement')
            }
          })
        },
        afterRename() { replacement = afterReplacement() },
      })
      return {
        mechanism: stage.mechanism, stagingName: stage.stagingName,
        parentIdentity: stage.parentIdentity,
        inspect: () => stage.inspect(), write: (chunk) => { stage.write(chunk) },
        setExecutable: (value) => { stage.setExecutable(value) }, syncFile: () => { stage.syncFile() },
        syncDirectory: () => { stage.syncDirectory() }, verifyFinal: () => stage.verifyFinal(),
        removeUnpublished: () => stage.removeUnpublished(), close: () => { stage.close() },
        replaceCurrent: () => {
          stage.publish()
          return replacement as ControlRecordReplacementFacts
        },
        reconcileReplacement: () => {
          const publication = stage.reconcile()
          if (publication === 'published' && replacement === null) {
            try { replacement = afterReplacement() } catch (_error) { /* Retain published separately from unverified target retirement. */ }
          }
          return { publication, replacement }
        },
      }
    },
    close() { if (closed) return; closed = true; target.close() },
  }
}
