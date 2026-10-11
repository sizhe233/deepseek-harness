/** Real Node resolver checks with synthetic byte authority, never native filesystem admission evidence. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installRuntimeCodeGate } from '../../src/runtime-code-gate.ts'
const root = mkdtempSync(join(tmpdir(), 'dsh-code-metadata-'))
const selected = join(root, 'generation'), original = join(root, 'original'), mode = process.argv[2]
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const json = value => JSON.stringify(value)
const url = path => pathToFileURL(path).href
const packagePath = join(selected, 'package.json')
const conditional = join(selected, 'node_modules/conditional/package.json')
const nestedType = join(selected, 'lib/package.json')
const parent = join(selected, 'node_modules/parent/package.json')
const directory = join(selected, 'directory/package.json')
try {
  put(packagePath, json({ name: 'entry', type: 'module', exports: { './self': './self.cjs' }, imports: { '#external': 'conditional', '#self': './self.cjs' } }))
  put(join(selected, 'entry.mjs'), "export async function external() { return (await import('conditional')).default }; export async function indirect() { return (await import('#external')).default }")
  put(join(selected, 'self.cjs'), "module.exports='self'")
  put(conditional, json({ name: 'conditional', type: 'module', exports: { '.': { import: './esm.js', require: './cjs.cjs' }, './wild/*': './wild/*.cjs' } }))
  put(join(selected, 'node_modules/conditional/esm.js'), "export default 'esm'")
  put(join(selected, 'node_modules/conditional/cjs.cjs'), "module.exports='cjs'")
  put(join(selected, 'node_modules/conditional/wild/one.cjs'), "module.exports='wildcard'")
  put(parent, json({ name: 'parent', main: './index.cjs' }))
  put(join(selected, 'node_modules/parent/index.cjs'), "module.exports=require('conditional')")
  put(join(selected, 'node_modules/parent/node_modules/conditional/package.json'), json({ name: 'conditional', main: './index.cjs' }))
  put(join(selected, 'node_modules/parent/node_modules/conditional/index.cjs'), "module.exports='nested'")
  put(join(selected, 'node_modules/escaped-main/package.json'), json({ main: '../destination/index.cjs' }))
  put(join(selected, 'node_modules/destination/package.json'), json({ type: 'commonjs' }))
  put(join(selected, 'node_modules/destination/index.cjs'), "module.exports='escaped-main'")
  put(join(selected, 'node_modules/.hidden/package.json'), json({ main: './index.cjs' }))
  put(join(selected, 'node_modules/.hidden/index.cjs'), "module.exports='hidden'")
  put(nestedType, json({ type: 'commonjs' }))
  put(join(selected, 'lib/typed.js'), "module.exports='typed'")
  put(directory, json({ type: 'commonjs', main: './inner' }))
  put(join(selected, 'directory/inner/index.js'), "module.exports='directory'")
  if (mode === 'scale') for (let index = 0; index < 554; index++) put(join(selected, `node_modules/unused-${index}/package.json`), json({ name: `unused-${index}` }))
  function inventory(path) {
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      const target = join(path, entry.name)
      if (entry.isDirectory()) return inventory(target)
      const bytes = readFileSync(target)
      return [{ path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
    })
  }
  const files = inventory(selected), reads = []
  let refused
  installRuntimeCodeGate({ roots: [selected], files, aliases: [{ logical: original, physical: selected }], source: {
    read(file) { if (file.path === refused) throw new Error('synthetic native identity refusal'); reads.push(file.path); return readFileSync(file.path) },
  } })
  assert.equal(reads.length, files.filter(file => file.path.endsWith('package.json')).length)
  const require = createRequire(join(original, 'entry.mjs'))
  const entry = await import(url(join(original, 'entry.mjs')))
  assert.equal(await entry.external(), 'esm'); assert.equal(await entry.indirect(), 'esm')
  assert.equal(require('conditional'), 'cjs'); assert.equal(require('conditional/wild/one'), 'wildcard')
  assert.equal(require('parent'), 'nested'); assert.equal(require('entry/self'), 'self'); assert.equal(require('#self'), 'self')
  assert.equal(require('escaped-main'), 'escaped-main'); assert.equal(require('.hidden'), 'hidden')
  assert.equal(require('./lib/typed.js'), 'typed'); assert.equal(require('./directory'), 'directory')
  if (mode === 'exports') {
    put(conditional, json({ type: 'module', exports: './esm.js' }))
    await assert.rejects(entry.external(), /Admitted runtime bytes changed/)
  } else if (mode === 'imports') {
    put(packagePath, json({ name: 'entry', type: 'module', imports: { '#external': './self.cjs' } }))
    await assert.rejects(entry.indirect(), /Admitted runtime bytes changed/)
  } else if (mode === 'main') {
    put(parent, json({ main: '../destination/index.cjs' }))
    assert.throws(() => require.resolve('parent'), /Admitted runtime bytes changed/)
  } else if (mode === 'type') {
    put(nestedType, json({ type: 'module' }))
    await assert.rejects(import(url(join(original, 'lib/typed.js'))), /Admitted runtime bytes changed/)
  } else if (mode === 'directory') {
    put(directory, json({ main: '../self.cjs' }))
    assert.throws(() => require.resolve('./directory'), /Admitted runtime bytes changed/)
  } else if (mode === 'refusal') {
    refused = conditional
    await assert.rejects(entry.external(), /synthetic native identity refusal/)
    assert.throws(() => require.resolve('conditional'), /synthetic native identity refusal/)
  } else if (mode === 'scale') {
    reads.length = 0
    for (let index = 0; index < 100; index++) {
      assert.equal(require.resolve('conditional'), join(selected, 'node_modules/conditional/cjs.cjs'))
      assert.equal(await entry.external(), 'esm')
    }
    assert.ok(reads.length >= 1000, `Every resolution must reread current metadata and code: ${reads.length}`)
    assert.ok(reads.length <= 2500, `Unrelated package scans returned: ${reads.length}`)
    assert.equal(reads.some(path => path.includes('unused-')), false)
  } else throw new Error(`Unknown metadata fixture mode: ${mode}`)
  assert.equal(reads.some(path => path.startsWith(original)), false)
  process.stdout.write('verified\n')
} finally { rmSync(root, { recursive: true, force: true }) }
