/** Injected generated-record replacement checks; these establish no native filesystem acceptance. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { ControlRecordWriterError, createBoundedControlRecordWriter, MAX_CONTROL_RECORD_BYTES } from '../src/control-record.ts'
import type { ControlRecordObjectObservation, ControlRecordReplacementFacts, ControlRecordResource,
  ControlRecordStagingResource, ControlRecordWriterOptions } from '../src/control-record.ts'
import { MAX_STREAM_CHUNK_BYTES } from '../src/stream-policy.ts'
import type { StreamFileFacts } from '../src/stream-native.ts'
import type { PrivateStreamOperationId, SourceFileFacts, StreamIdentity, StreamMechanism } from '../src/stream-types.ts'

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const currentId = { backend: 'posix' as const, device: '7', inode: '11' }
const stagingId = { backend: 'posix' as const, device: '7', inode: '12' }
const parentId = { backend: 'posix' as const, device: '7', inode: '10' }
const original = Buffer.from('{"revision":1}\n')
const next = Buffer.from('{"revision":2}\n')
const mechanism: StreamMechanism = 'linux-file-directory-fsync-v1'

function fixture(input = original, output = next, selectedMechanism = mechanism) {
  const calls: string[] = [], faults = new Set<string>(), readBounds: number[] = []
  const originalProfile = Buffer.from('original Profile bytes')
  const state = { cursor: 0, sourceContent: input, sourceClosed: 0, stageClosed: 0, created: 0, reads: 0,
    accepted: Buffer.alloc(0), published: false, removed: false, leaseHeld: true, leaseReleases: 0,
    target: input, originalProfile, revision: 1, shared: false, oversized: false, sourceFactsChanged: false,
    reconcilePublication: 'published' as 'published' | 'not-published' | 'indeterminate', reconcileFacts: true }
  const fault = (phase: string): void => { if (faults.has(phase)) throw new Error(`injected ${phase}`) }
  const sourceFacts = (): SourceFileFacts => ({ identity: currentId, sizeBytes: input.length, links: 1,
    changeToken: 'same-object-token', observations: { mode: 0o100600, uid: 1000, mtimeNs: state.sourceFactsChanged ? 'changed' : '42' } })
  const objectFacts = (identity: StreamIdentity, links: number): ControlRecordObjectObservation => ({
    identity, observations: { mode: identity === parentId ? 0o40700 : 0o100600, nlink: links, ctimeNs: String(links), nativeOnly: null },
  })
  const replacementFacts = (): ControlRecordReplacementFacts => ({
    replacedBefore: objectFacts(currentId, 1), replacedAfter: objectFacts(currentId, 0),
    stagingParent: objectFacts(parentId, 1), targetParent: objectFacts(parentId, 1), parentAfter: objectFacts(parentId, 1),
  })
  const stageFacts = (): StreamFileFacts => ({ identity: stagingId, parentIdentity: parentId,
    sizeBytes: state.accepted.length, links: 1, privateVerified: true,
    executable: selectedMechanism === 'windows-ntfs-write-through-rename-v1' ? null : false })
  const stage: ControlRecordStagingResource = {
    mechanism: selectedMechanism, stagingName: '.private-control-own', parentIdentity: parentId,
    inspect: () => { fault('inspect-stage'); return stageFacts() },
    write: (chunk) => {
      calls.push('write'); fault('write')
      if (faults.has('partial-write')) {
        state.accepted = Buffer.concat([state.accepted, chunk.subarray(0, 2)])
        throw Object.assign(new Error('partial native write'), { confirmedBytes: 2 })
      }
      state.accepted = Buffer.concat([state.accepted, chunk])
    },
    setExecutable: (value) => { calls.push('metadata'); expect(value).toBe(false); fault('metadata') },
    syncFile: () => { calls.push(state.published ? 'post-sync' : 'pre-sync'); fault(state.published ? 'post-sync' : 'pre-sync') },
    syncDirectory: () => { calls.push('directory-sync'); fault('directory-sync') },
    replaceCurrent: () => {
      calls.push('replace'); expect(state.sourceClosed).toBe(0)
      if (!state.leaseHeld) throw new Error('management lease is not live')
      expect(state.cursor).toBe(input.length); expect(calls).toContain('source-eof'); expect(calls).toContain('pre-sync')
      fault('before-replace')
      state.published = true; state.target = Buffer.from(state.accepted)
      fault('lost-ack')
      return replacementFacts()
    },
    reconcileReplacement: () => {
      calls.push('reconcile'); fault('reconcile')
      return { publication: state.reconcilePublication, replacement: state.reconcileFacts ? replacementFacts() : null }
    },
    verifyFinal: () => { calls.push('verify-final'); fault('verify-final'); return stageFacts() },
    removeUnpublished: () => {
      calls.push('remove'); fault('remove'); expect(state.published).toBe(false)
      state.removed = true; return { deletion: 'removed', directorySynced: true }
    },
    close: () => { calls.push('close-stage'); state.stageClosed++; fault('close-stage') },
  }
  const resource: ControlRecordResource = {
    inspectCurrent: () => { calls.push('inspect-current'); fault('inspect-current'); return sourceFacts() },
    readCurrent: (bound) => {
      calls.push('read-current'); readBounds.push(bound); state.reads++; fault('read-current')
      const chunk = Buffer.from(state.sourceContent.subarray(state.cursor, state.cursor + bound)); state.cursor += chunk.length
      if (faults.has('change-source')) state.sourceFactsChanged = true
      if (state.shared) return new Uint8Array(new SharedArrayBuffer(chunk.length))
      if (state.oversized) return Buffer.alloc(bound + 1)
      if (chunk.length === 0) { calls.push('source-eof'); fault('source-eof') }
      return chunk
    },
    createStaging: () => { calls.push('create-staging'); state.created++; fault('create-staging'); return stage },
    close: () => { calls.push('close-source'); state.sourceClosed++; fault('close-source') },
  }
  const options: ControlRecordWriterOptions = {
    operationId: brandString<PrivateStreamOperationId>('control-replacement'),
    expectedCurrent: { source: sourceFacts(), sha256: sha(input) }, expectedBytes: output.length, expectedSha256: sha(output),
    validateCurrent: (value) => {
      calls.push('validate-revision'); expect(Buffer.from(value.bytes)).toEqual(input); expect(value.sha256).toBe(sha(input))
      if (state.revision !== 1) throw new Error('stale application revision')
      fault('validate-revision'); return 'verified'
    },
  }
  const make = (selected = options) => createBoundedControlRecordWriter('generated.json', selected, selectedMechanism, () => {
    calls.push('open'); if (!state.leaseHeld) throw new Error('management lease is not live'); return resource
  })
  return { state, calls, faults, readBounds, sourceFacts, stage, resource, options, make, replacementFacts }
}

function capture(action: () => unknown): ControlRecordWriterError {
  let result: unknown
  try { action() } catch (error) { result = error }
  expect(result).toBeInstanceOf(ControlRecordWriterError)
  if (!(result instanceof ControlRecordWriterError)) throw new Error('expected a control record failure')
  return result
}

describe('generated private control record replacement', () => {
  it('verifies exact EOF and the application revision before staging while retaining the native source and caller lease', () => {
    const f = fixture(), writer = f.make()
    expect(f.calls.indexOf('source-eof')).toBeLessThan(f.calls.indexOf('validate-revision'))
    expect(f.calls.indexOf('validate-revision')).toBeLessThan(f.calls.indexOf('create-staging'))
    expect(f.state.sourceClosed).toBe(0)
    expect(f.state.target).toEqual(original)
    writer.append(next)
    expect(f.state.target).toEqual(original)
    const receipt = writer.finish()
    expect(receipt).toMatchObject({ currentVerification: 'verified', revisionVerification: 'verified',
      current: { observedBytes: original.length, eof: true, actualSha256: sha(original), verification: 'verified' },
      outcome: 'finished', release: 'released', managementLease: 'caller-owned', replacementVerification: 'verified',
      staging: { publication: 'published', acceptedBytes: next.length, actualSha256: sha(next), contentVerification: 'verified',
        bindingVerification: 'verified', release: 'released', durability: 'synced',
        synchronization: { preFile: 'succeeded', directory: 'succeeded', postFile: 'not-required' } } })
    expect(receipt.replacement).toEqual(f.replacementFacts())
    expect(receipt.current).not.toHaveProperty('release')
    expect(f.state.target).toEqual(next)
    expect(f.state.originalProfile).toEqual(Buffer.from('original Profile bytes'))
    expect(f.state.sourceClosed).toBe(1); expect(f.state.stageClosed).toBe(1)
    expect(f.state.leaseHeld).toBe(true); expect(f.state.leaseReleases).toBe(0)
    const calls = [...f.calls]
    expect(writer.finish()).toEqual(receipt); writer.close(); expect(writer.abort()).toEqual(receipt)
    expect(f.calls).toEqual(calls)
    expect(() => { writer.append(next) }).toThrow(ControlRecordWriterError)
    expect(Object.isFrozen(receipt.replacement?.replacedAfter.observations)).toBe(true)
  })

  it.each(['identity', 'size', 'links', 'changeToken', 'observation-value', 'observation-extra', 'observation-missing'])
  ('refuses wrong full current %s before staging', (field) => {
    const f = fixture(), initial = f.sourceFacts()
    f.resource.inspectCurrent = () => ({ ...initial,
      ...field === 'identity' ? { identity: { ...currentId, inode: '99' } } : {},
      ...field === 'size' ? { sizeBytes: initial.sizeBytes + 1 } : {},
      ...field === 'links' ? { links: 2 } : {},
      ...field === 'changeToken' ? { changeToken: 'different' } : {},
      ...field === 'observation-value' ? { observations: { ...initial.observations, mode: 0o100644 } } : {},
      ...field === 'observation-extra' ? { observations: { ...initial.observations, added: true } } : {},
      ...field === 'observation-missing' ? { observations: { mode: 0o100600 } } : {},
    })
    const error = capture(() => f.make())
    expect(error.receipt).toMatchObject({ currentVerification: 'failed', revisionVerification: 'unverified',
      staging: null, replacement: null, release: 'released' })
    expect(f.state.created).toBe(0); expect(f.state.reads).toBe(0); expect(f.state.sourceClosed).toBe(1)
    expect(f.state.target).toEqual(original); expect(f.state.leaseHeld).toBe(true)
  })

  it('refuses a wrong digest and a stale application revision before staging', () => {
    const digest = fixture()
    const wrong = { ...digest.options, expectedCurrent: { ...digest.options.expectedCurrent, sha256: '0'.repeat(64) } }
    const digestError = capture(() => digest.make(wrong))
    expect(digestError.receipt).toMatchObject({ currentVerification: 'failed', revisionVerification: 'unverified',
      current: { eof: true, actualSha256: sha(original), verification: 'failed' } })
    expect(digest.state.created).toBe(0)
    const revision = fixture(); revision.state.revision = 2
    expect(capture(() => revision.make()).receipt).toMatchObject({ currentVerification: 'verified', revisionVerification: 'failed' })
    expect(revision.state.created).toBe(0); expect(revision.state.sourceClosed).toBe(1)
  })

  it.each([undefined, Promise.resolve('verified')])('refuses incomplete synchronous revision result %s before staging', (result) => {
    const f = fixture()
    const options = Object.assign({}, f.options, { validateCurrent: () => result })
    expect(capture(() => f.make(options as ControlRecordWriterOptions)).receipt).toMatchObject({
      currentVerification: 'verified', revisionVerification: 'failed', release: 'released', staging: null,
    })
    expect(f.state.created).toBe(0)
  })

  it('uses inspected parent identity when staging does not expose a creation observation', () => {
    const f = fixture(), { parentIdentity: _parentIdentity, ...stage } = f.stage
    f.resource.createStaging = () => stage
    const writer = f.make(); writer.append(next)
    expect(writer.finish()).toMatchObject({ replacementVerification: 'verified', staging: { parentIdentity: parentId } })
  })

  it.each(['change-source', 'read-current', 'source-eof', 'inspect-current'])
  ('refuses %s without staging and retains failure details', (failure) => {
    const f = fixture(); f.faults.add(failure)
    const error = capture(() => f.make())
    expect(error.receipt.currentVerification).toBe('failed')
    expect(f.state.created).toBe(0); expect(f.state.sourceClosed).toBe(1)
  })

  it.each(['underflow', 'overflow', 'shared', 'oversized'])('refuses %s source data before revision or staging', (failure) => {
    const f = fixture()
    if (failure === 'underflow') f.state.sourceContent = original.subarray(1)
    if (failure === 'overflow') f.state.sourceContent = Buffer.concat([original, Buffer.from('x')])
    if (failure === 'shared') f.state.shared = true
    if (failure === 'oversized') f.state.oversized = true
    capture(() => f.make())
    expect(f.calls).not.toContain('validate-revision'); expect(f.state.created).toBe(0)
    expect(Math.max(...f.readBounds)).toBeLessThanOrEqual(MAX_STREAM_CHUNK_BYTES)
  })

  it('freezes the complete expected source facts before opening native resources', () => {
    const f = fixture(), supplied = { ...f.options, expectedCurrent: { source: { ...f.sourceFacts(),
      identity: { ...currentId }, observations: { ...f.sourceFacts().observations } }, sha256: sha(original) } }
    const writer = createBoundedControlRecordWriter('generated.json', supplied, mechanism, () => {
      supplied.expectedCurrent.source.identity.inode = '99'
      supplied.expectedCurrent.source.observations.mode = 0o100644
      supplied.expectedCurrent.sha256 = '0'.repeat(64)
      return f.resource
    })
    writer.append(next); expect(writer.finish().currentVerification).toBe('verified')
  })

  it.each([-1, 0.5, NaN, Infinity, MAX_CONTROL_RECORD_BYTES + 1])
  ('refuses current or output byte limit %s before opening', (size) => {
    for (const current of [true, false]) {
      const f = fixture()
      const options = current ? { ...f.options, expectedCurrent: { ...f.options.expectedCurrent,
        source: { ...f.options.expectedCurrent.source, sizeBytes: size } } } : { ...f.options, expectedBytes: size }
      expect(() => f.make(options)).toThrow(RangeError)
      expect(f.calls).not.toContain('open')
    }
  })

  it('admits the exact control-record ceiling and bounds each source allocation to 1 MiB', () => {
    const input = Buffer.alloc(MAX_CONTROL_RECORD_BYTES, 17), f = fixture(input, Buffer.alloc(0))
    const writer = f.make({ ...f.options, validateCurrent: () => 'verified' })
    expect(Math.max(...f.readBounds)).toBe(MAX_STREAM_CHUNK_BYTES)
    expect(f.readBounds.at(-1)).toBe(1)
    expect(writer.finish().current?.observedBytes).toBe(MAX_CONTROL_RECORD_BYTES)
    const exactOutput = fixture()
    const admitted = exactOutput.make({ ...exactOutput.options, expectedBytes: MAX_CONTROL_RECORD_BYTES })
    expect(admitted.abort().outcome).toBe('aborted')
  })

  it.each([Buffer.alloc(0), Buffer.alloc(MAX_STREAM_CHUNK_BYTES + 1), new Uint8Array(new SharedArrayBuffer(1))])
  ('rejects invalid staging buffers before any native write', (chunk) => {
    const f = fixture(), writer = f.make()
    expect(capture(() => { writer.append(chunk) }).receipt.staging).toMatchObject({
      publication: 'not-published', acceptedBytes: 0, cleanup: 'removed', release: 'released' })
    expect(f.calls).not.toContain('write'); expect(f.state.target).toEqual(original)
    expect(f.state.sourceClosed).toBe(1); expect(f.state.leaseHeld).toBe(true)
  })

  it('copies accepted output and detects overflow, underflow and wrong output digest before replacement', () => {
    const f = fixture(), writer = f.make(), chunk = Buffer.from(next)
    writer.append(chunk); chunk.fill(0); expect(writer.finish().staging?.actualSha256).toBe(sha(next))
    for (const bytes of [next.subarray(1), Buffer.alloc(next.length), Buffer.alloc(next.length + 1)]) {
      const bad = fixture(), output = bad.make()
      capture(() => { output.append(bytes); output.finish() })
      expect(bad.calls).not.toContain('replace'); expect(bad.state.target).toEqual(original)
    }
  })

  it('reports partial writes independently of accepted bytes and retains the original target', () => {
    const f = fixture(), writer = f.make(); f.faults.add('partial-write')
    const error = capture(() => { writer.append(next) })
    expect(error.receipt.staging).toMatchObject({ acceptedBytes: 0, confirmedPartialBytes: 2, observedSizeBytes: 2,
      publication: 'not-published', cleanup: 'removed' })
    expect(f.state.target).toEqual(original)
  })

  it.each(['published', 'not-published', 'indeterminate'] as const)
  ('reconciles lost acknowledgement as %s without retrying replacement or deleting possible publication', (publication) => {
    const f = fixture(), writer = f.make(); writer.append(next)
    f.state.reconcilePublication = publication
    if (publication === 'not-published') { f.faults.add('before-replace'); f.state.reconcileFacts = false }
    else f.faults.add('lost-ack')
    const failure = capture(() => writer.finish())
    expect(failure.receipt.staging).toMatchObject({ publication,
      cleanup: publication === 'not-published' ? 'removed' : 'withheld', durability: 'unconfirmed' })
    expect(capture(() => writer.finish())).toBe(failure)
    writer.close(); writer.abort()
    expect(f.calls.filter(call => call === 'replace')).toHaveLength(1)
    expect(f.state.sourceClosed).toBe(1); expect(f.state.stageClosed).toBe(1)
    expect(f.state.leaseHeld).toBe(true)
  })

  it('keeps published facts without fabricating native observations after a lost acknowledgement', () => {
    const f = fixture(), writer = f.make(); writer.append(next); f.faults.add('lost-ack'); f.state.reconcileFacts = false
    expect(capture(() => writer.finish()).receipt).toMatchObject({ replacement: null, replacementVerification: 'unverified',
      staging: { publication: 'published', cleanup: 'withheld' } })
    expect(f.state.target).toEqual(next)
  })

  it('withholds cleanup when acknowledgement and binding reconciliation both fail', () => {
    const f = fixture(), writer = f.make(); writer.append(next); f.faults.add('lost-ack'); f.faults.add('reconcile')
    expect(capture(() => writer.finish()).receipt.staging).toMatchObject({ publication: 'indeterminate', cleanup: 'withheld' })
    expect(f.state.removed).toBe(false); expect(f.state.target).toEqual(next)
  })

  it.each(['pre-sync', 'directory-sync', 'post-sync', 'verify-final', 'close-stage', 'close-source'])
  ('preserves orthogonal publication and release facts after %s fails', (failure) => {
    const f = fixture(original, next, 'darwin-file-directory-fullsync-v1'), writer = f.make(); writer.append(next)
    f.faults.add(failure)
    const receipt = capture(() => writer.finish()).receipt
    expect(receipt.staging?.publication).toBe(failure === 'pre-sync' ? 'not-published' : 'published')
    expect(receipt.staging?.synchronization.preFile).toBe(failure === 'pre-sync' ? 'failed' : 'succeeded')
    if (failure === 'directory-sync') expect(receipt.staging?.synchronization.directory).toBe('failed')
    if (failure === 'post-sync') expect(receipt.staging?.synchronization.postFile).toBe('failed')
    if (failure === 'verify-final') expect(receipt.staging?.bindingVerification).toBe('failed')
    if (failure === 'close-stage' || failure === 'close-source') expect(receipt.staging?.durability).toBe('synced')
    expect(receipt.release).toBe(failure === 'close-source' ? 'failed' : 'released')
    expect(receipt.staging?.release).toBe(failure === 'close-stage' ? 'failed' : 'released')
    writer.close(); writer.abort(); capture(() => writer.finish())
    expect(f.state.sourceClosed).toBe(1); expect(f.state.stageClosed).toBe(1); expect(f.state.leaseHeld).toBe(true)
  })

  it.each(['replacedBefore', 'replacedAfter', 'stagingParent', 'targetParent', 'parentAfter'] as const)
  ('rejects mismatched %s observations without erasing the successful replacement', (field) => {
    const f = fixture(), originalReplace = f.stage.replaceCurrent.bind(f.stage)
    f.stage.replaceCurrent = () => {
      const facts = originalReplace()
      return { ...facts, [field]: { ...facts[field], identity: { ...currentId, inode: '99' } } }
    }
    const writer = f.make(); writer.append(next)
    expect(capture(() => writer.finish()).receipt).toMatchObject({ replacementVerification: 'failed',
      staging: { publication: 'published', bindingVerification: 'failed', cleanup: 'withheld' } })
    expect(f.state.target).toEqual(next); expect(f.state.removed).toBe(false)
  })

  it('checks the live lease again before replacement without releasing the caller lease', () => {
    const unopened = fixture(); unopened.state.leaseHeld = false
    expect(capture(() => unopened.make()).receipt.release).toBe('not-attempted')
    const f = fixture(), writer = f.make(); writer.append(next); f.state.leaseHeld = false
    f.state.reconcilePublication = 'not-published'; f.state.reconcileFacts = false
    expect(capture(() => writer.finish()).receipt.staging?.publication).toBe('not-published')
    expect(f.state.target).toEqual(original); expect(f.state.leaseReleases).toBe(0)
  })

  it('aborts only own staging and explicit close releases without deleting either record', () => {
    const f = fixture(), writer = f.make(); writer.append(next)
    expect(writer.abort()).toMatchObject({ outcome: 'aborted', release: 'released', staging: { cleanup: 'removed' } })
    expect(f.state.target).toEqual(original); expect(f.state.leaseHeld).toBe(true)
    const abandoned = fixture(), other = abandoned.make(); other.close(); other.close()
    expect(other.receipt).toMatchObject({ outcome: 'closed', release: 'released', staging: { cleanup: 'withheld' } })
    expect(abandoned.state.removed).toBe(false); expect(abandoned.state.sourceClosed).toBe(1)
    expect(() => { other.append(next) }).toThrow(ControlRecordWriterError)
    expect(() => other.finish()).toThrow(ControlRecordWriterError)
  })

  it('records setup and independent cleanup failures without retrying either release', () => {
    const beforeStage = fixture(); beforeStage.faults.add('validate-revision'); beforeStage.faults.add('close-source')
    expect(capture(() => beforeStage.make())).toMatchObject({ cleanupFailed: true,
      receipt: { currentVerification: 'verified', revisionVerification: 'failed', release: 'failed', staging: null } })
    expect(beforeStage.state.sourceClosed).toBe(1)
    const duringStage = fixture(); duringStage.faults.add('inspect-stage'); duringStage.faults.add('remove')
    duringStage.faults.add('close-stage'); duringStage.faults.add('close-source')
    expect(capture(() => duringStage.make())).toMatchObject({ cleanupFailed: true,
      receipt: { release: 'failed', staging: { cleanup: 'failed', release: 'failed' } } })
    expect(duringStage.state.sourceClosed).toBe(1); expect(duringStage.state.stageClosed).toBe(1)
  })

  it.each(['abort', 'close'] as const)('keeps %s release failures terminal with no repeated native close', (operation) => {
    const f = fixture(), writer = f.make(); f.faults.add('close-source'); f.faults.add('close-stage')
    expect(capture(() => writer[operation]()).receipt).toMatchObject({ outcome: 'failed', release: 'failed',
      staging: { release: 'failed', publication: 'not-published' } })
    writer.close(); writer.abort()
    expect(f.state.sourceClosed).toBe(1); expect(f.state.stageClosed).toBe(1)
  })
})
