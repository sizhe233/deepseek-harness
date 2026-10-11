/** Explicit collector entry; the closure library has no executable main guard when bundled. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectPrivateStorageNativeClosure } from './private-storage-closure.mjs'

const [command, root, destination, cache] = process.argv.slice(2)
assert.equal(command, 'collect', 'Usage: node private-storage-closure-cli.mjs collect ROOT DESTINATION [EXACT_ARCHIVE_CACHE]')
assert.ok(root && destination)
const result = await collectPrivateStorageNativeClosure(resolve(root), resolve(destination), cache ? { archiveDirectory: resolve(cache) } : {})
const manifest = join(resolve(destination), 'private-storage-native.json')
writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ manifest, packages: result.packages.map(item => ({ name: item.name, bytes: item.bytes, sha256: item.sha256 })) }))
