/** Independent process observing access sharing on one controller-owned synthetic staging or final file. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { ownerBinding } from './owner-observer.mjs'

const [entry, rootPath, name] = process.argv.slice(2)
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
assert.match(name, /^(?:\.dsh-private-[0-9a-f]{40}|fault-[a-z-]+\.bin)$/u)
const binding = ownerBinding(entry), k = createRequire(entry)('koffi')
assert.equal(k.version, '3.1.1')
const kernel = k.load('kernel32.dll')
const open = kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'])
const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
const observations = []
for (const [role, access] of [['delete', 0x10000], ['write', 2], ['read', 0x120081]]) {
  const handle = open(join(rootPath, name), access, 7, null, 3, 0x00200080, null)
  const opened = handle !== null && handle !== 0n && handle !== 0xffffffffffffffffn
  const error = opened ? null : lastError()
  let released = null
  if (opened) { released = close(handle) !== 0; assert.equal(released, true, 'Only this probe owns and closes its successful open') }
  observations.push({ role, desiredAccess: access, shareAccess: 7, opened, win32Error: error, released })
}
writeSync(1, `${JSON.stringify({ event: 'access', independentProcess: true, binding, observations })}\n`)
