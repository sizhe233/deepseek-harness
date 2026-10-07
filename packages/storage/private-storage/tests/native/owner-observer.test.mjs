/** Portable observer protocol checks; these never claim native execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { methods, wrapOwner, ownerBinding } from './owner-observer.mjs'

test('observer forwards every native method with the actual frozen owner receiver', () => {
  const owner = {}, calls = [], capability = Object.freeze({})
  for (const name of methods) Object.defineProperty(owner, name, { value(...args) {
    assert.equal(this, owner)
    calls.push({ name, args })
    return capability
  } })
  Object.freeze(owner)
  const observed = [], wrapped = wrapOwner(owner, (name, args, invoke, receiver) => {
    assert.equal(receiver, owner); observed.push({ name, args }); return invoke()
  })
  for (const name of methods) assert.equal(wrapped[name](capability, 17), capability)
  assert.deepEqual(observed, calls); assert.equal(calls.length, methods.length)
  assert.equal(Object.isFrozen(wrapped), true)
})

test('before-call refusal and after-call lost return remain distinguishable', () => {
  let calls = 0
  const owner = Object.fromEntries(methods.map(name => [name, () => { calls++; return name }]))
  const error = new Error('labelled test fault')
  const before = wrapOwner(owner, () => { throw error })
  assert.throws(() => before.close({}), value => value === error); assert.equal(calls, 0)
  const after = wrapOwner(owner, (_name, _args, invoke) => { invoke(); throw error })
  assert.throws(() => after.close({}), value => value === error); assert.equal(calls, 1)
})

test('a missing native operation fails before an incomplete observer is exposed', () => {
  assert.throws(() => wrapOwner({}, () => {}), /method missing/u)
})

test('installed observer admits only the exact declared offline native bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-observer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entry = join(root, 'node_modules/@deepseek-ai/dsh-private-storage/lib/index.js')
  const platform = join(root, 'node_modules/@deepseek-ai/node-addon-system-win32-x64')
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh-private-storage/lib'), { recursive: true })
  mkdirSync(join(platform, 'bin'), { recursive: true })
  writeFileSync(entry, '// Synthetic entry, never executed.\n')
  writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: '@deepseek-ai/node-addon-system-win32-x64', version: '0.1.3' }))
  const bytes = Buffer.from('Synthetic native inventory, never executed.\n')
  const binary = join(platform, 'bin/windows-private-owner.node')
  writeFileSync(binary, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { name: '@deepseek-ai/node-addon-system-win32-x64', version: '0.1.3',
    nativeBinaries: [{ path: 'bin/windows-private-owner.node', sha256 }] }
  const inventory = { root, entry, platform: 'win32', architecture: 'x64', checkoutDependencyLinks: false,
    lifecycleScriptsExecuted: false, packages: [record] }
  const save = value => writeFileSync(join(root, 'consumer-inventory.json'), JSON.stringify(value))
  save(inventory)
  assert.equal(ownerBinding(entry).sha256, sha256)
  for (const packages of [[], [record, record], [{ ...record, version: '0.1.2' }],
    [{ ...record, nativeBinaries: [] }], [{ ...record, nativeBinaries: [...record.nativeBinaries, ...record.nativeBinaries] }]]) {
    save({ ...inventory, packages }); assert.throws(() => ownerBinding(entry))
  }
  for (const changed of [{ checkoutDependencyLinks: true }, { lifecycleScriptsExecuted: true }, { platform: 'linux' }]) {
    save({ ...inventory, ...changed }); assert.throws(() => ownerBinding(entry))
  }
  save(inventory); writeFileSync(binary, 'Changed bytes')
  assert.throws(() => ownerBinding(entry))
})
