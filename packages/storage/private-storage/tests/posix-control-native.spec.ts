/** Actual generated-record replacement; required persistent-volume runs cannot convert refusal into success. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { acquirePosixManagementLease, createPosixControlRecordOwner, openPosixPrivateDirectory } from '../src/native-posix.ts'
import type { PrivateStreamOperationId } from '../src/stream-types.ts'

function fixture(context: TestContext) {
  const root = mkdtempSync(join(realpathSync(process.env.PRIVATE_STORAGE_TEST_ROOT ?? tmpdir()), 'posix-control-native-'))
  context.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  let directory
  try { directory = openPosixPrivateDirectory(root, { create: false }) }
  catch (error) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOTSUP') throw error
    expect(process.env.PRIVATE_STORAGE_REQUIRE_DESTINATION, 'Required persistent local destination is unavailable').not.toBe('1')
    context.skip('Generated-record native replacement requires an admitted persistent destination')
  }
  context.onTestFinished(() => { directory.close() })
  const prior = Buffer.from('{"revision":1}')
  writeFileSync(join(root, 'selector.json'), prior, { mode: 0o600 })
  const lock = acquirePosixManagementLease(directory, 'management.lock')
  context.onTestFinished(() => { lock.close() })
  return { root, prior, lock, owner: createPosixControlRecordOwner(directory, lock, ['selector.json']) }
}
it.skipIf(!['linux', 'darwin'].includes(process.platform))('replaces and rolls back only generated records while preserving an original document', (context) => {
  const f = fixture(context)
  const original = join(f.root, 'original.patch.yml')
  writeFileSync(original, 'unchanged original', { mode: 0o444 })
  const before = statSync(original, { bigint: true })
  for (const [revision, bytes] of [[1, Buffer.from('{"revision":2}')], [2, f.prior]] as const) {
    const selected = f.owner.read('selector.json', { maxBytes: 1024 })
    const writer = f.owner.replace('selector.json', { operationId: brandString<PrivateStreamOperationId>(`revision-${revision}`),
      expectedCurrent: { source: selected.source, sha256: selected.sha256 }, expectedBytes: bytes.length,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      validateCurrent: (current) => { expect(JSON.parse(Buffer.from(current.bytes).toString())).toEqual({ revision }); return 'verified' },
    })
    writer.append(bytes)
    expect(writer.finish()).toMatchObject({ outcome: 'finished', replacementVerification: 'verified', release: 'released',
      staging: { publication: 'published', durability: 'synced', metadataVerification: 'verified' } })
    expect(readFileSync(join(f.root, 'selector.json'))).toEqual(bytes)
  }
  const after = statSync(original, { bigint: true })
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) expect(after[key]).toBe(before[key])
  expect(readFileSync(original, 'utf8')).toBe('unchanged original')
})
it.skipIf(!['linux', 'darwin'].includes(process.platform))('refuses conflicting revisions before native staging or replacement', (context) => {
  const f = fixture(context), selected = f.owner.read('selector.json', { maxBytes: 1024 })
  expect(() => f.owner.replace('selector.json', { operationId: brandString<PrivateStreamOperationId>('conflict'),
    expectedCurrent: { source: selected.source, sha256: selected.sha256 }, expectedBytes: 0,
    expectedSha256: createHash('sha256').digest('hex'), validateCurrent: () => { throw new Error('revision conflict') },
  })).toThrow('validate-revision')
  expect(readFileSync(join(f.root, 'selector.json'))).toEqual(f.prior)
})
