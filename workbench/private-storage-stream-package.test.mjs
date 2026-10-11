/** Extracted-package entry identity only; actual Windows directory/stream operations require native fixtures. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as tar from 'tar'
import { inspectArchiveEntries } from './private-storage-closure.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('one actual packed root owns both entries and an independent copied provider stays distinct', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'storage-stream-package-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/iu.test(key)
    && !['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase())))
  const packed = spawnSync('pnpm', ['--dir', join(root, 'packages/storage/private-storage'), 'pack', '--pack-destination', scratch],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(packed.error); assert.equal(packed.signal, null); assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const archives = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(scratch, archives[0])
  inspectArchiveEntries(archive)
  for (const copy of ['first', 'second']) {
    const directory = join(scratch, copy); mkdirSync(directory)
    tar.x({ file: archive, cwd: directory, strip: 1, strict: true, sync: true })
    for (const entry of ['index.js', 'streams.js']) assert.equal(digest(join(directory, 'lib', entry)), digest(join(root, 'packages/storage/private-storage/lib', entry)))
  }
  const brandPacked = spawnSync('pnpm', ['--dir', join(root, 'packages/util/brand'), 'pack', '--pack-destination', scratch],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(brandPacked.error); assert.equal(brandPacked.signal, null)
  assert.equal(brandPacked.status, 0, brandPacked.stderr || brandPacked.stdout)
  const brandArchives = readdirSync(scratch).filter(name => name.endsWith('.tgz') && join(scratch, name) !== archive)
  assert.equal(brandArchives.length, 1)
  const brandArchive = join(scratch, brandArchives[0]); inspectArchiveEntries(brandArchive)
  const nativePacked = spawnSync('pnpm', ['--dir', join(root, 'native/system/packages/entry'), 'pack', '--pack-destination', scratch],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(nativePacked.error); assert.equal(nativePacked.signal, null)
  assert.equal(nativePacked.status, 0, nativePacked.stderr || nativePacked.stdout)
  const nativeArchives = readdirSync(scratch).filter(name => name.endsWith('.tgz') && ![archive, brandArchive].includes(join(scratch, name)))
  assert.equal(nativeArchives.length, 1)
  const nativeArchive = join(scratch, nativeArchives[0]); inspectArchiveEntries(nativeArchive)
  for (const copy of ['first', 'second']) {
    const directory = join(scratch, copy, 'node_modules/@deepseek-ai/node-addon-system'); mkdirSync(directory, { recursive: true })
    tar.x({ file: nativeArchive, cwd: directory, strip: 1, strict: true, sync: true })
  }
  const installed = join(scratch, 'installed'); mkdirSync(installed)
  const modules = join(installed, 'node_modules', '@deepseek-ai'); mkdirSync(modules, { recursive: true })
  for (const [name, input] of [['dsh-private-storage', archive], ['dsh-brand', brandArchive], ['node-addon-system', nativeArchive]]) {
    const directory = join(modules, name); mkdirSync(directory)
    tar.x({ file: input, cwd: directory, strip: 1, strict: true, sync: true })
  }
  const manifest = JSON.parse(readFileSync(join(modules, 'dsh-private-storage/package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-brand'], JSON.parse(readFileSync(join(modules, 'dsh-brand/package.json'), 'utf8')).version)
  const nativeManifest = JSON.parse(readFileSync(join(modules, 'node-addon-system/package.json'), 'utf8'))
  assert.equal(nativeManifest.version, '0.1.3')
  assert.equal(manifest.dependencies['@deepseek-ai/node-addon-system'], `~${nativeManifest.version}`)
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(installed, 'consumer.ts'), `import { PrivateStorageError, type PublicationReceipt } from '@deepseek-ai/dsh-private-storage';
import { createPrivateFileWriter, type PrivateFileWriterOptions, type PrivateStreamOperationId, type PrivateStreamDirectory } from '@deepseek-ai/dsh-private-storage/streams';
declare const error: unknown;
if(error instanceof PrivateStorageError) {
 const receipt: PublicationReceipt | undefined = error.receipt;
 // @ts-expect-error The existing error's receipt must never narrow to any.
 const unsafe: string = error.receipt;
 void receipt;void unsafe;
}
declare const operationId: PrivateStreamOperationId;
const options: PrivateFileWriterOptions = {operationId, expectedBytes:0, expectedSha256:'0'.repeat(64), replace:false, executable:false};
// @ts-expect-error Operation IDs retain their public compile-time brand.
const unbranded: PrivateStreamOperationId = 'operation';
// @ts-expect-error A public identity alone cannot construct an opaque directory capability.
const forged: PrivateStreamDirectory = {identity:{backend:'windows-ntfs',volumeSerial:'0'.repeat(16),fileId:'1'.repeat(32)},policy:'private',close(){}};
void createPrivateFileWriter;void options;void unbranded;void forged;
`)
  writeFileSync(join(installed, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false,
    types: [], noEmit: true,
  }, files: ['consumer.ts'] }))
  const declarations = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(installed, 'tsconfig.json')],
    { cwd: installed, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(declarations.error); assert.equal(declarations.signal, null)
  assert.equal(declarations.status, 0, declarations.stderr || declarations.stdout)
  // A missing declared dependency must be observed by this isolated consumer, rather than resolved from the checkout.
  rmSync(join(modules, 'dsh-brand'), { recursive: true, force: true })
  const missing = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(installed, 'tsconfig.json')],
    { cwd: installed, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(missing.error); assert.equal(missing.signal, null); assert.notEqual(missing.status, 0)
  assert.match(missing.stdout, /TS2307: Cannot find module '@deepseek-ai\/dsh-brand'/u)
  const script = join(scratch, 'consumer.mjs')
  writeFileSync(script, `import assert from 'node:assert/strict';
const first=await import('./first/lib/index.js'), forward=await import('./first/lib/streams.js');
const second=await import('./second/lib/index.js'), secondForward=await import('./second/lib/streams.js');
for(const name of ['createPrivateFileWriter','openSourceDirectory','openSourceFileReader','inspectSourceFile','PrivateStreamError',
 'openPrivateStreamDirectory','openPrivateStreamChild','createPrivateStreamChild','listPrivateStreamDirectory','inspectPrivateStreamEntry',
 'openPrivateFileReader','readPrivateRecord','observePrivateStreamCapacity','acquireManagementLease','assertManagementLease',
 'createControlRecordOwner','openPrivateLogSink','PrivateLogSinkError','ControlRecordWriterError','streamCapabilities','readSourceDocument',
 'observeProcessBirth','openSourceChild','listSourceDirectory','inspectSourceLink','openPrivateStreamRoot','PrivateStreamRootError',
 'openObservedSourceFileReader','ObservedSourceFileReaderError']) {
 assert.equal(first[name],forward[name],name);assert.equal(second[name],secondForward[name],name);assert.notEqual(first[name],second[name],name);
}
assert.equal(first.PrivateStorageError,forward.PrivateStorageError);
console.log(JSON.stringify({sameProvider:true,foreignProviderDistinct:true,nativeExecution:false}));
`)
  const child = spawnSync(process.execPath, [script], { cwd: scratch, env, encoding: 'utf8', timeout: 10_000 })
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { sameProvider: true, foreignProviderDistinct: true, nativeExecution: false })
})
