/** Readonly source enumeration adapter models; no persistent-destination or native-platform acceptance claim. */
import { PrivateStreamRootError } from '../src/root-opening.ts'
import { expect, it, vi } from 'vitest'
import type { PosixStorageDirectory, PosixStorageFacts, PosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import { openPosixSourceDirectory, openPosixSourceChild, listPosixSourceDirectory, openPosixPrivateStreamRoot } from '../src/native-posix.ts'
const selected = vi.hoisted(() => ({ native: undefined as PosixStoragePrimitives | undefined }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({ loadPosixStoragePrimitives: () => selected.native }))
const facts: PosixStorageFacts = { kind: 'directory', dev: '1', ino: '1', uid: '1000', gid: '1000', mode: 0o40755,
  nlink: '2', size: '0', mtimeNs: '1', ctimeNs: '1', platform: 'linux',
  filesystem: { type: '61267', name: 'ext-family', readOnly: false, fsid: 'source', blockSize: '4096' },
  acl: { model: 'linux-posix-mode-mask', entries: 0, defaultEntries: 0, supported: true }, bindingVerified: true,
  created: false, creationSync: { directory: false, parent: false }, bytesRead: '0', bytesWritten: '0', published: false, removed: false }
function fixture(rootMode?: 'existing' | 'created' | 'unsynced' | 'wrong-parent' | 'close-failure') {
  const parent = {} as PosixStorageDirectory, child = {} as PosixStorageDirectory
  const open = new Set([parent, child])
  let changed = false, childInvalid = false, failClose = false, didList = false
  const unavailable = (): never => { throw new Error('Unrequested native operation') }
  const inspect = (value: object): PosixStorageFacts => {
    if (!open.has(value as PosixStorageDirectory)) throw new Error('Native directory is closed')
    return { ...facts, ino: value === child ? '2' : '1', bindingVerified: !(value === child && childInvalid),
      ctimeNs: changed && didList ? '2' : '1', ...rootMode !== undefined && value === child ? {
        created: rootMode !== 'existing', creationSync: { directory: rootMode !== 'unsynced', parent: rootMode !== 'unsynced' },
        parentBinding: { name: 'managed', before: { ...facts, ino: rootMode === 'wrong-parent' ? '9' : '1' }, after: facts },
      } : {} }
  }
  selected.native = {
    observeProcessBirth: unavailable, inspectSourceLink: unavailable, openDirectory: (_path, policy, create) => {
      if (rootMode !== undefined && policy === 'private') { expect(create).toBe(true); return child }
      expect(policy).toBe('source'); expect(create).toBe(false); return parent
    }, openChild: (value, name) => { expect(value).toBe(parent); expect(name).toBe('child'); return child },
    createPrivateChild: unavailable, openPrivateOutput: unavailable,
    listDirectory: unavailable, listSourceDirectory: (value, maximum) => {
      expect(maximum).toBe(3); didList = true
      return { complete: true, parentBeforeFacts: { ...facts, ino: value === child ? '2' : '1' },
        parentAfterFacts: { ...facts, ino: value === child ? '2' : '1', ctimeNs: changed ? '2' : '1' }, entries: [
          { name: 'file', facts: { ...facts, ino: '3', kind: 'regular', mode: 0o100644, nlink: '3' } },
          { name: 'directory', facts: { ...facts, ino: '4' } },
          { name: 'bin-link', facts: { ...facts, ino: '5', kind: 'symlink', mode: 0o120777 } },
        ] }
    }, observeCapacity: unavailable, openSource: unavailable, openPrivateRecord: unavailable, createFile: unavailable,
    acquireLease: unavailable, replacePrivateRecord: unavailable, inspect, inspectBinding: unavailable, inspectFileBinding: unavailable,
    read: unavailable, write: unavailable, setExecutable: unavailable, syncFile: unavailable, syncDirectory: unavailable,
    publish: unavailable, removeUnpublished: unavailable,
    close: (value) => { open.delete(value as PosixStorageDirectory)
      if (failClose || rootMode === 'close-failure' && value === parent) throw new Error('Unconfirmed close')
      return { closed: true } },
  }
  return { root: openPosixSourceDirectory('/synthetic'), open,
    changed() { changed = true }, badChild() { childInvalid = true }, failClose() { failClose = true } }
}
it('preserves ordinary source permissions, lists all names, and withholds link copy authority', () => {
  const f = fixture(), child = openPosixSourceChild(f.root, 'child')
  f.root.close()
  const listed = listPosixSourceDirectory(child, 3)
  expect(listed).toMatchObject({ complete: true, admission: 'unadmitted-entries' })
  expect(listed.before.observations.mode).toBe(0o40755); expect(listed.before).not.toHaveProperty('privateVerified')
  expect(listed.entries.map(value => value.kind)).toEqual(['file', 'directory', 'unadmitted'])
  expect(listed.entries[2]).toMatchObject({ identity: { backend: 'posix', device: '1', inode: '5' },
    reason: 'Source symlink has no admitted copy or link-target authority' })
  child.close(); expect(f.open.size).toBe(0)
})
it('rejects directory mutation and invalid ceilings without presenting a partial inventory as complete', () => {
  const f = fixture(); f.changed()
  expect(() => listPosixSourceDirectory(f.root, 3)).toThrow(expect.objectContaining({ name: 'SourceObservationError' }))
  expect(() => listPosixSourceDirectory(f.root, -1)).toThrow(RangeError)
  f.root.close()
})
it('releases a child that fails admission and reports an uncertain close separately', () => {
  const first = fixture(); first.badChild()
  expect(() => openPosixSourceChild(first.root, 'child')).toThrow()
  expect(first.open.size).toBe(1); first.root.close()
  const second = fixture(); second.badChild(); second.failClose()
  expect(() => openPosixSourceChild(second.root, 'child')).toThrow(AggregateError)
})
it('qualifies root creation only from actual retained-parent and two-directory synchronization facts', () => {
  for (const mode of ['existing', 'created'] as const) {
    const f = fixture(mode), result = openPosixPrivateStreamRoot('/synthetic/managed', { create: true })
    expect(result.receipt).toMatchObject({ kind: mode === 'existing' ? 'existing-root' : 'created',
      durability: mode === 'existing' ? 'not-attempted' : 'synced', bindingVerification: 'verified', release: 'retained' })
    expect(result.receipt.publications).toHaveLength(mode === 'created' ? 1 : 0)
    result.directory.close(); expect(f.open.size).toBe(0)
  }
})
it('withholds successful enrollment for unsynced, different-parent and uncertain-close observations', () => {
  for (const mode of ['unsynced', 'wrong-parent', 'close-failure'] as const) {
    const f = fixture(mode)
    let failure: unknown
    try { openPosixPrivateStreamRoot('/synthetic/managed', { create: true }) } catch (error) { failure = error }
    if (!(failure instanceof PrivateStreamRootError)) throw new Error('Expected root opening failure')
    expect(failure.receipt.release).toBe(mode === 'close-failure' ? 'failed' : 'released')
    expect(f.open.size).toBe(0)
  }
})
