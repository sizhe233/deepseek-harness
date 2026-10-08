/** Executed only in a disposable subprocess: filesystem reads are synthetic, not native admission evidence. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installRuntimeCodeGate } from '../../src/runtime-code-gate.ts'
const root = mkdtempSync(join(tmpdir(), 'dsh-code-gate-'))
const original = join(root, 'original'), selected = join(root, 'generation')
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const packageJson = JSON.stringify({ name: 'conditional', type: 'module', exports: { '.': { import: './esm.js', require: './cjs.cjs' }, './data': './data.json' } })
for (const [location, label] of [[original, 'original-poison'], [selected, 'selected']]) {
  put(join(location, 'package.json'), JSON.stringify({ name: 'entry', type: 'module', exports: { './self': './self.cjs' } }))
  put(join(location, 'capsule.mjs'), `export const identity={capsule:true}`)
  put(join(location, 'capsule.cjs'), `module.exports={capsule:true}`)
  put(join(location, 'self.cjs'), `module.exports='${label}-self'`)
  put(join(location, 'node_modules/parent/package.json'), JSON.stringify({ name: 'parent', main: './index.cjs' }))
  put(join(location, 'node_modules/parent/index.cjs'), `module.exports=require('conditional')`)
  put(join(location, 'node_modules/parent/node_modules/conditional/package.json'), JSON.stringify({ name: 'conditional', main: './index.cjs' }))
  put(join(location, 'node_modules/parent/node_modules/conditional/index.cjs'), `module.exports='${label}-nested'`)
  put(join(location, 'entry.mjs'), `import value from 'conditional'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export default {esm:value,cjs:require('conditional'),json:require('conditional/data').value};`)
  put(join(location, 'node_modules/conditional/package.json'), packageJson)
  put(join(location, 'node_modules/conditional/esm.js'), `export default '${label}-esm'`)
  put(join(location, 'node_modules/conditional/cjs.cjs'), `module.exports='${label}-cjs'`)
  put(join(location, 'node_modules/conditional/data.json'), JSON.stringify({ value: label + '-json' }))
}
function inventory(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const target = join(path, entry.name)
    if (entry.isDirectory()) return inventory(target)
    const bytes = readFileSync(target)
    return [{ path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })
}
try {
  const originalCapsule = await import(pathToFileURL(join(original, 'capsule.mjs')).href)
  const originalRequire = createRequire(join(original, 'capsule.cjs'))
  const originalCommonJs = originalRequire('./capsule.cjs')
  const files = [...inventory(selected), ...inventory(original).filter(file => /capsule\.(mjs|cjs)$/.test(file.path))], reads = []
  installRuntimeCodeGate({ roots: [selected, original], files, bootstrapFiles: [join(original, 'capsule.mjs'), join(original, 'capsule.cjs')], sharedModules: ['capsule.mjs', 'capsule.cjs'].map(name => ({ generated: join(selected, name), bootstrap: join(original, name) })), aliases: [{ logical: original, physical: selected }], source: {
    read(file) { reads.push(file.path); return readFileSync(file.path) },
  } })
  if (process.argv[2] === 'tamper') {
    writeFileSync(join(selected, 'node_modules/conditional/esm.js'), `throw new Error('executed-tamper')`)
    await assert.rejects(import(pathToFileURL(join(original, 'entry.mjs')).href), /Admitted runtime bytes changed/)
  } else if (process.argv[2] === 'escape') {
    put(join(root, 'escape.cjs'), `throw new Error('executed-escape')`)
    const require = createRequire(join(original, 'entry.mjs'))
    assert.throws(() => require('../escape.cjs'), /outside the admitted runtime inventory/)
  } else {
    assert.equal((await import(pathToFileURL(join(selected, 'capsule.mjs')).href)).identity, originalCapsule.identity)
    assert.equal(originalRequire('./capsule.cjs'), originalCommonJs)
    const entry = await import(pathToFileURL(join(original, 'entry.mjs')).href)
    assert.deepEqual(entry.default, { esm: 'selected-esm', cjs: 'selected-cjs', json: 'selected-json' })
    const require = createRequire(join(original, 'entry.mjs'))
    assert.equal(require('conditional'), 'selected-cjs')
    assert.equal(require.resolve('conditional'), join(selected, 'node_modules/conditional/cjs.cjs'))
    assert.equal(require('node:path').join, join)
    assert.equal(require('parent'), 'selected-nested')
    assert.equal(require('entry/self'), 'selected-self')
    assert.equal(require.resolve('conditional', { paths: [join(original, 'node_modules/parent')] }), join(selected, 'node_modules/parent/node_modules/conditional/index.cjs'))
    assert.throws(() => installRuntimeCodeGate({ roots: [], files: [], aliases: [], source: { read() { throw new Error('unused') } } }), /already installed/)
  }
  assert.equal(reads.some(path => path.startsWith(original) && !/capsule\.(mjs|cjs)$/.test(path)), false)
  process.stdout.write('verified\n')
} finally { rmSync(root, { recursive: true, force: true }) }
