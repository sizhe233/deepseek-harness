/** Packed-root source diagnostic with bounded owned fixtures; it never certifies private destination persistence. */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statfsSync, writeFileSync, writeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const entry = resolve(process.argv[2])
const { inspectSourceFile, openSourceDirectory, openSourceFileReader } = await import(pathToFileURL(entry).href)

const evidenceRoot = resolve(process.argv[3] ?? '.runtime/posix-source-large')
mkdirSync(evidenceRoot, { recursive: true })
const chunkBytes = 1024 * 1024
const sizes = [64 * chunkBytes + 1, 257 * chunkBytes]
const results = []
for (const expectedBytes of sizes) {
  const space = statfsSync(evidenceRoot, { bigint: true })
  if (space.bavail * space.bsize < BigInt(expectedBytes + 256 * chunkBytes)) {
    throw new Error(`Insufficient fixture space for ${expectedBytes} bytes plus the retained reserve`)
  }
  const root = mkdtempSync(join(evidenceRoot, 'owned-source-'))
  writeFileSync(join(root, 'fixture.json'), JSON.stringify({ purpose: 'generated bounded source diagnostic', expectedBytes }))
  const path = join(root, 'source.bin')
  const fd = openSync(path, 'wx', 0o444)
  const expectedHash = createHash('sha256')
  const chunk = Buffer.alloc(chunkBytes, 0x6b)
  try {
    let remaining = expectedBytes
    while (remaining > 0) {
      const part = chunk.subarray(0, Math.min(chunkBytes, remaining))
      let offset = 0
      while (offset < part.length) {
        const written = writeSync(fd, part, offset, part.length - offset)
        if (written <= 0) throw new Error('synthetic source write made no progress')
        offset += written
      }
      expectedHash.update(part)
      remaining -= part.length
    }
    fsyncSync(fd)
    const before = fstatSync(fd, { bigint: true })
    const expectedSha256 = expectedHash.digest('hex')
    const directory = openSourceDirectory(root)
    const observed = inspectSourceFile(directory, 'source.bin')
    const reader = openSourceFileReader(directory, 'source.bin', { expectedIdentity: observed.identity, expectedBytes, expectedSha256 })
    directory.close()
    const independent = createHash('sha256')
    let maximumChunk = 0, total = 0
    try {
      while (true) {
        const data = reader.readChunk(chunkBytes)
        maximumChunk = Math.max(maximumChunk, data.length)
        if (data.length === 0) break
        independent.update(data); total += data.length
      }
      const receipt = reader.finish()
      if (receipt.verification !== 'verified' || receipt.outcome !== 'finished' || !receipt.eof
        || total !== expectedBytes || independent.digest('hex') !== expectedSha256 || maximumChunk > chunkBytes) {
        throw new Error('Generated source stream did not match independent length/digest observations')
      }
      const after = fstatSync(fd, { bigint: true })
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
        if (before[key] !== after[key]) throw new Error(`Source ${key} changed during readonly verification`)
      }
      results.push({ expectedBytes, expectedSha256, maximumChunk, source: receipt.source, sourceVerification: true,
        destinationAcceptance: false, persistentLocalAcceptance: false, fullOneGiBExecuted: false })
      writeFileSync(join(evidenceRoot, 'results.json'), JSON.stringify({ schemaVersion: 1, node: process.version,
        sourceOnly: true, accepted: false, results }, null, 2) + '\n')
    } finally { reader.close() }
  } finally {
    closeSync(fd)
    const marker = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
    if (marker.purpose !== 'generated bounded source diagnostic' || marker.expectedBytes !== expectedBytes) throw new Error('Fixture ownership changed')
    rmSync(root, { recursive: true })
  }
}
console.log(JSON.stringify({ sourceCases: results.length, sourceOnly: true, accepted: false }))
