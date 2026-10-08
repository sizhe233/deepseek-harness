/** Test subprocesses retain their own storage handles; no production module exposes hooks. */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [entry, mode, root, name] = process.argv.slice(2)
if (mode === 'monitor') {
  // The monitor has no writer handle and no authority to release a writer's lease.
  console.log(JSON.stringify({ complete: true, monitorReady: true }))
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'close') break
  }
} else {
  const storage = await import(pathToFileURL(entry).href)
  let directory
  let lease
  try {
    directory = storage.openPrivateDirectory(root, { create: false })
    if (mode === 'read') {
      const facts = storage.inspectPrivate(directory, name)
      const bytes = storage.readPrivateFile(directory, name, 65536)
      console.log(JSON.stringify({ complete: true, ownerSid: facts.ownerSid, identity: facts.identity, bytesHex: Buffer.from(bytes).toString('hex') }))
    } else if (mode === 'lease') {
      lease = storage.acquirePrivateWriterLease(directory, name)
      console.log(JSON.stringify({ complete: true, leaseReady: true, identity: lease.identity }))
      for await (const line of createInterface({ input: process.stdin })) {
        if (line === 'close') break
      }
    } else {
      throw new Error('Unknown native process fixture role')
    }
  } catch (error) {
    console.log(JSON.stringify({ complete: false, code: error.code ?? 'fixture-error', nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null }))
    process.exitCode = 1
  } finally {
    lease?.close()
    directory?.close()
  }
}
