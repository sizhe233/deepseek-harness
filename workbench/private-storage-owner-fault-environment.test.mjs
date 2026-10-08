/** Portable replay of compiler environment parsing; no compiler or Windows execution is claimed. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ownerLibraryDirectories } from './private-storage-owner-fault-evidence.mjs'

const directories = [
  String.raw`C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC\14.51.36231\ATLMFC\lib\x64`,
  String.raw`C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC\14.51.36231\lib\x64`,
  String.raw`C:\Program Files (x86)\Windows Kits\NETFXSDK\4.8.1\lib\um\x64`,
  String.raw`C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\ucrt\x64`,
  String.raw`C:\Program Files (x86)\Windows Kits\10\\lib\10.0.26100.0\\um\x64`,
]
// The observed Windows builders emit both records for CMD's `set LIB` prefix query.
const capture = `LIB=${directories.join(';')}\r\nLIBPATH=${directories[0]};C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\r\n`

test('selects only the exact LIB record from the actual two-record compiler layout', () => {
  const legacy = capture.trim().slice(4).split(';').filter(Boolean)
  assert.ok(legacy.some(directory => directory.includes('\r\nLIBPATH=')), 'The original parser must reproduce the observed failure')
  assert.deepEqual(ownerLibraryDirectories(capture), directories)
  assert.deepEqual(ownerLibraryDirectories(capture.replaceAll('\r\n', '\n')), directories)
  assert.deepEqual(ownerLibraryDirectories(`LIBPATH=C:\\Managed\\References\r\nlib=${directories.join(';')};\r\n`), directories)
})

for (const [name, captured] of [
  ['missing LIB', 'LIBPATH=C:\\Managed\\References\r\n'],
  ['duplicate LIB', 'LIB=C:\\One\r\nLIB=C:\\Two\r\n'],
  ['case-folded duplicate LIB', 'LIB=C:\\One\r\nlib=C:\\Two\r\n'],
  ['empty search path', 'LIB=;;;\r\nLIBPATH=C:\\Managed\r\n'],
  ['relative path', 'LIB=relative\\lib\r\n'],
  ['drive-relative path', 'LIB=C:relative\\lib\r\n'],
  ['current-drive rooted path', 'LIB=\\relative\\lib\r\n'],
  ['embedded record separator', 'LIB=C:\\One\rLIBPATH=C:\\Managed\r\n'],
  ['NUL', 'LIB=C:\\One\0\r\n'],
  ['oversized capture', `LIB=C:\\${'a'.repeat(64 * 1024)}\r\n`],
]) test(`rejects ${name} without admitting a fallback search path`, () => {
  assert.throws(() => ownerLibraryDirectories(captured))
})

test('the PowerShell compiler executes this parser through its hashed native support module', t => {
  const source = readFileSync(new URL('private-storage-owner-fault.ps1', import.meta.url), 'utf8')
  const command = /^\s*\$librariesJson = & node --input-type=module -e '([^']+)' \$bindingModule \$librarySearch$/mu.exec(source)
  assert.ok(command, 'Compiler must invoke the tested shared parser')
  const temporary = mkdtempSync(join(tmpdir(), 'owner-library-capture-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const path = join(temporary, 'library-search.txt')
  const support = fileURLToPath(new URL('../packages/storage/private-storage/tests/native/owner-fault-support.mjs', import.meta.url))
  const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', command[1], support, path], {
    cwd: temporary, encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  })
  writeFileSync(path, capture)
  const result = invoke()
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), directories)
  assert.equal(readFileSync(path, 'utf8'), capture, 'Raw compiler capture must remain intact for hashing')
  writeFileSync(path, 'LIBPATH=C:\\Managed\\References\r\n')
  const rejected = invoke()
  assert.ifError(rejected.error); assert.equal(rejected.signal, null); assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /Exactly one LIB environment record is required/u)
})
