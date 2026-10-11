/** Real bundled-copy/ChildProcess regression; injected authorities do not claim native storage qualification. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'tsdown'
const root = mkdtempSync(join(tmpdir(), 'dsh-outer-bootstrap-'))
try {
  const entry = fileURLToPath(new URL('../../src/runtime-admission.ts', import.meta.url))
  for (const name of ['separate', 'bundled-main']) {
    const results = await build({ config: false, entry: { [name]: entry }, outDir: root, format: 'esm', platform: 'node',
      dts: false, clean: false, logLevel: 'silent', outputOptions: { entryFileNames: '[name].mjs' } })
    const modules = results.flatMap(result => result.chunks.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []))
    assert.ok(modules.length > 0 && modules.every(path => /runtime-(?:admission|code-gate|outer-bootstrap)\.ts$/.test(path)))
  }
  const separate = await import(pathToFileURL(join(root, 'separate.mjs')).href)
  const bundled = await import(pathToFileURL(join(root, 'bundled-main.mjs')).href)
  const children = new WeakSet(), observed = []
  const authority = {
    spawn(request) { const child = spawn(request.executable, request.args, request.options); children.add(child); return child },
    consumeMessage(child, message) { observed.push(message.type); return children.has(child) && message.token === 'inherited-test-channel' },
  }
  separate.installRuntimeChildLaunchAuthority(authority)
  let prepared = 0
  const profile = { async prepare() { prepared++ }, async disableThirdParty() { return '/private/generated-backup' } }
  const profiles = { async qualify() { return { status: 'managed', ...profile } } }
  separate.installRuntimeProfileAuthority(profiles)
  authority.spawn = () => { throw new Error('accidental late method replacement') }
  profiles.qualify = () => { throw new Error('accidental late profile replacement') }
  const qualification = await bundled.qualifyRuntimeProfile({ home: '/logical', profileDir: '/logical/profiles/desktop', runtimeDir: '/installed' })
  await qualification.prepare(); assert.equal(prepared, 1)
  assert.equal(await qualification.disableThirdParty([]), '/private/generated-backup')
  const code = `process.once('message',()=>{ process.send({type:'ready',token:'inherited-test-channel'}); process.send({type:'dsh-runtime-ready',token:'wrong'}); process.send({type:'dsh-runtime-ready',token:'inherited-test-channel'},()=>process.disconnect()); })`
  const child = bundled.spawnRuntimeChild({ carrier: 'desktop-host', executable: process.execPath, args: ['-e', code], options: { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] } })
  const results = []
  child.on('message', message => results.push(bundled.consumeRuntimeChildMessage(child, message)))
  child.send({ start: true })
  const [status] = await once(child, 'exit')
  assert.equal(status, 0); assert.deepEqual(results, [false, false, true]); assert.deepEqual(observed, ['dsh-runtime-ready', 'dsh-runtime-ready'])
  assert.throws(() => bundled.installRuntimeChildLaunchAuthority(authority), /already fixed/)
  assert.throws(() => bundled.installRuntimeProfileAuthority(profiles), /already fixed/)
  process.stdout.write('verified\n')
} finally { rmSync(root, { recursive: true, force: true }) }
