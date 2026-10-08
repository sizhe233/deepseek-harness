/** One bounded, read-only product probe on a caller-designated mounted local volume. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entry, volume, type] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.match(volume, /^[A-Za-z]:\\$/u, 'Only an explicitly designated drive root is allowed')
assert.ok([2, 3, 5, 6].includes(Number(type)), 'Remote and unknown drive types are excluded')
const path = `${volume}private-storage-admission-${randomUUID()}`
let absent = false
try { statSync(path) }
catch (error) {
  if (error.code === 'ENOENT') absent = true
  else if (['EACCES', 'EPERM', 'ENODEV', 'ENXIO', 'ENOTSUP'].includes(error.code)) {
    console.log(JSON.stringify({ complete: false, status: 'blocked', operation: 'read-only-volume-probe-stat', code: error.code,
      volume, driveType: Number(type), readOnly: true, create: false }))
    process.exit(3)
  } else throw error
}
assert.equal(absent, true, 'Fresh synthetic probe name must be absent')
const storage = await import(pathToFileURL(resolve(entry)).href)
let observed
try {
  const directory = storage.openPrivateDirectory(path, { create: false })
  directory.close()
  throw new Error('Unsupported volume was admitted')
} catch (error) {
  assert.equal(error.name, 'PrivateStorageError')
  assert.equal(error.code, 'unsupported', `Unexpected unsupported-volume rejection ${error.code}`)
  observed = { name: error.name, code: error.code, nativeStatus: error.nativeStatus ?? null, win32Code: error.win32Code ?? null }
}
assert.throws(() => statSync(path), error => error.code === 'ENOENT', 'Read-only probe must not create its synthetic name')
console.log(JSON.stringify({ complete: true, readOnly: true, create: false, volume, driveType: Number(type), nameAbsentBefore: true,
  nameAbsentAfter: true, rejection: observed, privilegesEnabled: false }))
