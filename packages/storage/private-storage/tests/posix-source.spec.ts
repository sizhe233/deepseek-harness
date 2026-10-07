/** Actual native source reads; these do not assert supported persistent destination storage. */
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createPosixPrivateFileWriter, inspectPosixSourceFile, readPosixSourceDocument, openPosixPrivateDirectory, openPosixSourceDirectory, openPosixSourceFileReader } from '../src/native-posix.ts'
import type { SourceFileReaderOptions, StreamIdentity } from '../src/stream-types.ts'
import { openObservedSourceFileReader, openSourceDirectory, inspectSourceFile, inspectSourceLink,
  listSourceDirectory, openSourceChild } from '../src/index.ts'
import { symlinkSync, mkdirSync } from 'node:fs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'posix-source-facade-')); roots.push(root)
  const file = join(root, 'source'), data = Buffer.alloc(1024 * 1024 + 3, 41)
  writeFileSync(file, data, { mode: 0o444 }); linkSync(file, join(root, 'alias'))
  const stats = statSync(file, { bigint: true })
  const identity: StreamIdentity = { backend: 'posix', device: stats.dev.toString(), inode: stats.ino.toString() }
  const options: SourceFileReaderOptions = { expectedIdentity: identity, expectedBytes: data.length, expectedSha256: sha(data) }
  return { root, file, data, stats, options }
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('native POSIX source facade', () => {
  it('uses the canonical retained source facade for literal link inventory and computed streaming observations', () => {
    const f = fixture(); mkdirSync(join(f.root, 'child')); symlinkSync('../source', join(f.root, 'child', 'bin'))
    const root = openSourceDirectory(f.root), child = openSourceChild(root, 'child')
    const listed = listSourceDirectory(child, 1)
    expect(listed.entries[0]).toMatchObject({ name: 'bin', kind: 'unadmitted' })
    const link = inspectSourceLink(child, 'bin', { maxBytes: 32768 })
    expect(link).toMatchObject({ kind: 'symbolic-link', literalTarget: '../source', relative: true })
    expect(link.before).toEqual(link.after)
    const expectedSource = inspectSourceFile(root, 'source')
    const reader = openObservedSourceFileReader(root, 'source', { expectedSource, maxBytes: 1024 ** 3 })
    child.close(); root.close()
    let count = 0
    for (let bytes = reader.readChunk(1024 * 1024); bytes.length; bytes = reader.readChunk(1024 * 1024)) count += bytes.length
    expect(reader.finish()).toMatchObject({ verification: 'observed', release: 'released', observedBytes: count,
      actualSha256: f.options.expectedSha256 })
    expect(count).toBe(f.data.length)
  })
  it('reads a readonly multiply linked source after caller closes its retained parent', () => {
    const f = fixture(), directory = openPosixSourceDirectory(f.root)
    const reader = openPosixSourceFileReader(directory, 'alias', f.options)
    directory.close()
    const hash = createHash('sha256')
    for (let chunk = reader.readChunk(1024 * 1024); chunk.length; chunk = reader.readChunk(1024 * 1024)) hash.update(chunk)
    expect(hash.digest('hex')).toBe(f.options.expectedSha256)
    expect(reader.finish()).toMatchObject({ outcome: 'finished', verification: 'verified', eof: true, observations: 'unchanged', release: 'released' })
    const after = statSync(f.file, { bigint: true })
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) expect(after[key]).toBe(f.stats[key])
    expect(readFileSync(f.file).equals(f.data)).toBe(true)
    expect(() => openPosixSourceFileReader(directory, 'source', f.options)).toThrow('closed')
  })
  it('imports a previously observed readonly document without an artifact digest', () => {
    const f = fixture(), directory = openPosixSourceDirectory(f.root)
    try {
      const source = inspectPosixSourceFile(directory, 'alias')
      const result = readPosixSourceDocument(directory, 'alias', { maxBytes: f.data.length, expectedSource: source })
      expect(Buffer.from(result.bytes)).toEqual(f.data)
      expect(result.sha256).toBe(sha(f.data))
      const after = statSync(f.file, { bigint: true })
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) expect(after[key]).toBe(f.stats[key])
    } finally { directory.close() }
  })
  it('detects a same-size source rewrite and retains failure instead of reopening', () => {
    const f = fixture(), directory = openPosixSourceDirectory(f.root)
    const reader = openPosixSourceFileReader(directory, 'source', f.options)
    reader.readChunk(8)
    chmodSync(f.file, 0o644); writeFileSync(f.file, Buffer.alloc(f.data.length, 42))
    expect(() => reader.readChunk(8)).toThrow()
    expect(reader.receipt).toMatchObject({ outcome: 'failed', verification: 'failed', release: 'released' })
    reader.close(); directory.close()
  })
  it('does not let source authority create private output', () => {
    const f = fixture(), directory = openPosixSourceDirectory(f.root)
    try {
      expect(() => createPosixPrivateFileWriter(directory, 'output', { operationId: 'invalid' } as never)).toThrow('wrong-policy')
    } finally { directory.close() }
  })
  it('refuses an unsupported private destination before creating its final directory', (context) => {
    const f = fixture(), directory = openPosixSourceDirectory(f.root)
    const filesystem = directory.facts.filesystem.name; directory.close()
    if (filesystem !== 'overlayfs' && filesystem !== 'tmpfs') context.skip()
    expect(() => openPosixPrivateDirectory(join(f.root, 'new-private'), { create: true })).toThrow()
    expect(() => statSync(join(f.root, 'new-private'))).toThrow()
  })
})
