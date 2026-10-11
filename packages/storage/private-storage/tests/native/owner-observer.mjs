/** Test-process-only interception of the admitted Node-API module; no production hooks or raw handles. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const methods = Object.freeze(['tokenUser', 'open', 'close', 'query', 'fileType', 'fileId', 'volumeInfo',
  'security', 'read', 'write', 'flush', 'rename', 'remove', 'lock', 'unlock', 'names', 'statistics', 'observeProcess', 'reparse'])

/** Forward a real native receiver even when its method descriptors cannot be redefined. */
export function wrapOwner(owner, intercept) {
  const wrapped = {}
  for (const name of methods) {
    assert.equal(typeof owner[name], 'function', `Native owner method missing: ${name}`)
    wrapped[name] = (...args) => intercept(name, args, () => Reflect.apply(owner[name], owner, args), owner)
  }
  return Object.freeze(wrapped)
}

/** Bind the exact offline native payload before loading it; an extra/missing inventory record fails. */
export function ownerBinding(entry) {
  const actual = realpathSync(entry), require = createRequire(actual)
  const consumer = dirname(dirname(dirname(dirname(dirname(actual)))))
  const inventoryPath = join(consumer, 'consumer-inventory.json')
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  assert.equal(realpathSync(inventory.entry), actual)
  assert.equal(realpathSync(inventory.root), realpathSync(consumer))
  assert.equal(inventory.platform, 'win32'); assert.equal(inventory.architecture, 'x64')
  assert.equal(inventory.checkoutDependencyLinks, false); assert.equal(inventory.lifecycleScriptsExecuted, false)
  const nativeName = '@deepseek-ai/node-addon-system-win32-x64'
  const manifestPath = require.resolve(`${nativeName}/package.json`)
  assert.equal(realpathSync(manifestPath), realpathSync(join(consumer, 'node_modules', nativeName, 'package.json')))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, nativeName); assert.equal(manifest.version, '0.1.3')
  const records = inventory.packages.filter(record => record.name === nativeName)
  assert.equal(records.length, 1); assert.equal(records[0].version, '0.1.3')
  const binary = realpathSync(join(dirname(manifestPath), 'bin/windows-private-owner.node'))
  assert.ok(Array.isArray(records[0].binaries), 'Native platform binary inventory is required')
  const expected = records[0].binaries.filter(record => record.path === 'bin/windows-private-owner.node')
  assert.equal(expected.length, 1)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const bytes = readFileSync(binary), sha256 = digest(bytes)
  assert.equal(bytes.length, expected[0].bytes)
  assert.equal(sha256, expected[0].sha256)
  return Object.freeze({ binary, sha256, bytes: bytes.length, platformPackage: nativeName, version: '0.1.3',
    inventorySha256: digest(readFileSync(inventoryPath)) })
}

/** Replace only this test process's cached module facade, preserving the actual native creator and receiver. */
export function installOwnerObserver(entry, intercept) {
  const binding = ownerBinding(entry), require = createRequire(entry)
  const loaded = require(binding.binary)
  assert.equal(typeof loaded.createOwner, 'function')
  const cached = require.cache[binding.binary]
  assert.ok(cached); assert.equal(cached.exports, loaded)
  let installed = true
  const owners = []
  const replacement = Object.freeze({ ...loaded, createOwner() {
    const owner = Reflect.apply(loaded.createOwner, loaded, [])
    owners.push(owner)
    return wrapOwner(owner, intercept)
  } })
  cached.exports = replacement
  return Object.freeze({ binding, owners,
    restore() {
      if (!installed) return
      installed = false
      assert.equal(cached.exports, replacement, 'Another test changed the native module cache')
      cached.exports = loaded
    },
  })
}
