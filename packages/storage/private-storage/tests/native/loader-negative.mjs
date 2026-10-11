/** Real Windows loader failures against disposable clones of the verified offline consumer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const [consumerArgument, outputArgument] = process.argv.slice(2)
assert.ok(consumerArgument && outputArgument, 'Usage: node loader-negative.mjs CONSUMER_ROOT OUTPUT_JSON')
const consumerRoot = resolve(consumerArgument)
const output = resolve(outputArgument)
const report = { schemaVersion: 1, evidence: 'cloned-consumer-loader-negative', nativeExecution: process.platform === 'win32' && process.arch === 'x64',
  platform: process.platform, architecture: process.arch, node: process.version, results: [] }
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)
  && !['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())))

function requireRegularTree(path, count = { files: 0, bytes: 0 }) {
  const stat = lstatSync(path)
  assert.equal(stat.isSymbolicLink(), false, 'Loader test consumer must not contain developer links')
  if (stat.isDirectory()) for (const name of readdirSync(path)) requireRegularTree(join(path, name), count)
  else {
    assert.equal(stat.isFile(), true, 'Unexpected consumer entry type')
    count.files++; count.bytes += stat.size
    assert.ok(count.files <= 10000 && count.bytes <= 64 * 1024 * 1024, 'Loader fixture copy limit')
  }
}

function probeSource() {
  return `import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const [scenario,root]=process.argv.slice(2);
const require=createRequire(import.meta.url);
const marker=join(root,'marker-executed');
const fallback=resolve(root,'node_modules/koffi/build/koffi/win32_x64/koffi.node');
const extension=Module._extensions['.node'];
const attempts=[];
Module._extensions['.node']=(module,filename)=>{
  attempts.push(filename);
  if(resolve(filename)===fallback) writeFileSync(marker,'fallback native binary was attempted');
  return extension(module,filename);
};
const storage=await import('@deepseek-ai/dsh-private-storage');
const capabilities=storage.capabilities();
if(scenario==='baseline') {
  assert.equal(capabilities.available,true,capabilities.reason);
  assert.equal(capabilities.backend,'windows-ntfs');
  const binary=join(root,'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node');
  assert.equal(capabilities.nativeArtifact.nativeBinarySha256,createHash('sha256').update(readFileSync(binary)).digest('hex'));
} else {
  assert.equal(capabilities.available,false,'Corrupted or shadowed dependency must be unavailable');
  assert.equal(capabilities.backend,null);
  const target=join(root,'must-not-create');
  assert.equal(existsSync(target),false);
  assert.throws(()=>storage.openPrivateDirectory(target,{create:true}),error=>error.name==='PrivateStorageError'&&error.code==='unavailable');
  assert.equal(existsSync(target),false);
  assert.equal(existsSync(marker),false,'A shadow module, Koffi entry, or fallback binary executed');
  assert.equal(Object.keys(require.cache).filter(path=>path.endsWith('.node')).length,0,'No native binary may remain loaded after failed admission');
  if(scenario==='corrupt-binary') assert.ok(attempts.length>=1,'The real Node loader must reject the corrupted binary');
  else assert.equal(attempts.length,0,'Preflight must reject before native execution');
}
Module._extensions['.node']=extension;
console.log(JSON.stringify({complete:true,scenario,capabilities,nativeRequireAttempts:attempts.length,markerExecuted:existsSync(marker),realPlatform:process.platform,realArchitecture:process.arch}));
`
}

try {
  if (!report.nativeExecution) report.results.push({ name: 'native-runtime', status: 'blocked', reason: 'Real Windows x64 required; no platform mocking is accepted' })
  else {
    requireRegularTree(consumerRoot)
    for (const scenario of ['baseline', 'missing-binary', 'corrupt-binary', 'shadow-object', 'shadow-throw']) {
      const scratch = mkdtempSync(join(tmpdir(), 'dsh-loader-negative-'))
      const clone = join(scratch, 'consumer')
      try {
        cpSync(consumerRoot, clone, { recursive: true, dereference: false, errorOnExist: true, force: false })
        const koffi = join(clone, 'node_modules/koffi')
        const binary = join(clone, 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node')
        assert.ok(lstatSync(binary).isFile(), 'Pristine Windows payload is missing before negative mutation')
        const marker = join(clone, 'marker-executed')
        if (scenario === 'missing-binary' || scenario === 'corrupt-binary') {
          if (scenario === 'missing-binary') unlinkSync(binary)
          else writeFileSync(binary, 'synthetic invalid Windows native binary\n')
          const fallback = join(koffi, 'build/koffi/win32_x64/koffi.node')
          mkdirSync(dirname(fallback), { recursive: true })
          writeFileSync(fallback, 'synthetic fallback marker payload\n', { flag: 'wx' })
          const entry = join(koffi, 'index.cjs')
          writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'Koffi loader entry executed before admission');\n${readFileSync(entry, 'utf8')}`)
        } else if (scenario === 'shadow-object' || scenario === 'shadow-throw') {
          const shadow = join(koffi, 'src/koffi/src/node_modules/@koromix/koffi-win32-x64')
          mkdirSync(shadow, { recursive: true })
          writeFileSync(join(shadow, 'package.json'), JSON.stringify({ name: '@koromix/koffi-win32-x64', version: '3.1.1', main: 'index.js' }), { flag: 'wx' })
          writeFileSync(join(shadow, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'nested static loader shadow executed');\n${scenario === 'shadow-object' ? 'module.exports = { version: "3.1.1" };' : 'throw new Error("synthetic shadow failure");'}\n`, { flag: 'wx' })
        }
        const probe = join(clone, 'loader-probe.mjs')
        writeFileSync(probe, probeSource(), { flag: 'wx' })
        const child = spawnSync(process.execPath, [probe, scenario, clone], { cwd: clone, env: environment, encoding: 'utf8', timeout: 60_000, windowsHide: true })
        assert.ifError(child.error)
        assert.equal(child.signal, null)
        assert.equal(child.status, 0, child.stderr)
        const result = JSON.parse(child.stdout)
        assert.equal(result.complete, true)
        assert.equal(result.markerExecuted, false)
        report.results.push({ name: scenario, status: 'passed', detail: result })
      } catch (error) {
        report.results.push({ name: scenario, status: 'failed', reason: error.message })
      } finally {
        // Windows can release a just-exited process's mapped image asynchronously.
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
} catch (error) {
  report.results.push({ name: 'fixture-preparation', status: 'failed', reason: error.message })
} finally {
  report.summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, report.results.filter(result => result.status === status).length]))
  report.complete = report.summary.failed === 0 && report.summary.blocked === 0
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ complete: report.complete, summary: report.summary, report: output }))
  process.exitCode = report.summary.failed ? 1 : report.summary.blocked ? 2 : 0
}
