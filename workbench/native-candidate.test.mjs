/** Synthetic archive/source binding checks; no fixture is a native executable. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inspectNativeCandidateArchive } from './native-candidate.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t, platform = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-candidate-archive-')), pkg = join(root, 'package')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = platform ? { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.3', os: ['linux'], cpu: ['x64'] }
    : { name: '@deepseek-ai/node-addon-system', version: '0.1.3', exports: Object.fromEntries(['flock','landlock-run','private-storage','windows-private-owner'].map(name=>[`./${name}`,`./lib/${name}.js`])) }
  const files = platform ? { 'bin/synthetic.node': 'synthetic binary', 'prebuilds.json': JSON.stringify({platform:'linux-x64',binaries:[{path:'bin/synthetic.node',kind:'node-api'}]}) }
    : Object.fromEntries(['src/main.c','src/flock.c','src/private-storage.c','src/windows-private-owner.c','lib/private-storage.js','lib/windows-private-owner.js'].map(path=>[path,'synthetic source '+path]))
  files['package.json'] = JSON.stringify(manifest)
  for (const [name, bytes] of Object.entries(files)) { mkdirSync(dirname(join(pkg,name)),{recursive:true});writeFileSync(join(pkg,name),bytes) }
  const archive = join(root, 'native-0.1.3.tgz')
  const pack = () => execFileSync('tar',['-czf',archive,'-C',root,'package'])
  pack()
  const build = platform ? { package:manifest.name,version:manifest.version,platform:'linux-x64',prebuildsSha256:hash(Buffer.from(files['prebuilds.json'])),
    binaries:[{path:'bin/synthetic.node',bytes:Buffer.byteLength(files['bin/synthetic.node']),sha256:hash(Buffer.from(files['bin/synthetic.node'])),executable:false}] } : undefined
  return {root,pkg,archive,manifest,files,build,pack}
}
test('entry archive identifies exact packed source/runtime bytes and strong archive integrity',t=>{
 const f=fixture(t), row=inspectNativeCandidateArchive(f.archive,f.pkg)
 assert.equal(row.verifiedCandidateFiles.length,6);assert.equal(row.sha256,hash(readFileSync(f.archive)))
 assert.equal(row.integrity,'sha512-'+createHash('sha512').update(readFileSync(f.archive)).digest('base64'))
 writeFileSync(join(f.pkg,'src/windows-private-owner.c'),'changed after packing')
 assert.throws(()=>inspectNativeCandidateArchive(f.archive,f.pkg),/changed during pack/)
})
test('platform archive binds its exact declared payload to the source-build record',t=>{
 const f=fixture(t,true), row=inspectNativeCandidateArchive(f.archive,f.pkg,f.build)
 assert.equal(row.platform,'linux-x64');assert.deepEqual(row.binaries,f.build.binaries)
 const wrong=structuredClone(f.build);wrong.binaries[0].sha256='0'.repeat(64)
 assert.throws(()=>inspectNativeCandidateArchive(f.archive,f.pkg,wrong),/differs from the same-source build/)
})
test('platform archive refuses missing inventory, changed metadata and foreign identity',t=>{
 const f=fixture(t,true)
 for(const change of [row=>row.binaries=[],row=>row.prebuildsSha256='0'.repeat(64),row=>row.package='@fixture/other']){
  const wrong=structuredClone(f.build);change(wrong);assert.throws(()=>inspectNativeCandidateArchive(f.archive,f.pkg,wrong))
 }
})
test('entry refuses unexported capabilities and older package generation',t=>{
 const f=fixture(t)
 delete f.manifest.exports['./windows-private-owner'];writeFileSync(join(f.pkg,'package.json'),JSON.stringify(f.manifest));f.pack()
 assert.throws(()=>inspectNativeCandidateArchive(f.archive,f.pkg),/export missing/)
 f.manifest.version='0.1.2';writeFileSync(join(f.pkg,'package.json'),JSON.stringify(f.manifest));f.pack()
 assert.throws(()=>inspectNativeCandidateArchive(f.archive,f.pkg))
})
