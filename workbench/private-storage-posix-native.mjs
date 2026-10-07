/** Packed native POSIX execution with exact test inventory and explicit platform applicability. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeMatrixEnvironment } from './private-storage-matrix-process.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
/** Refuse missing/extra/failed tests and any skip outside the actual platform/volume applicability. */
export function evaluatePosixNativeTap(text, contract, platform, unsupportedFilesystem) {
  assert.ok(['linux','darwin'].includes(platform))
  const rows = [...text.matchAll(/^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: .*)?)?$/gmu)].map(row => ({name:row[2],status:row[1]==='ok'?(row[3]??'passed'):'failed'}))
  assert.equal(rows.length, contract.total)
  assert.equal(new Set(rows.map(row=>row.name)).size, rows.length)
  assert.deepEqual(rows.map(row=>row.name).sort(), [...contract.inventory].sort(), 'POSIX test inventory changed')
  const platformSkips = platform==='linux'?contract.darwinOnly:contract.linuxOnly
  const allowed = new Set([...platformSkips,...unsupportedFilesystem?[]:Object.keys(contract.conditionalFilesystemOnly)])
  for (const row of rows) {
    assert.notEqual(row.status,'failed',`Native case failed: ${row.name}`)
    assert.notEqual(row.status,'TODO',`Native case is incomplete: ${row.name}`)
    if(row.status==='SKIP')assert.ok(allowed.has(row.name),`Undeclared native skip: ${row.name}`)
    if(platformSkips.includes(row.name))assert.equal(row.status,'SKIP','A different platform test cannot become this platform proof')
  }
  const passed=rows.filter(row=>row.status==='passed').length,skipped=rows.length-passed
  for(const [key,value]of [['tests',rows.length],['pass',passed],['fail',0],['skipped',skipped]]){
    const match=new RegExp(`^# ${key} (\\d+)$`,'mu').exec(text);assert.ok(match,`Missing TAP ${key} total`);assert.equal(Number(match[1]),value)
  }
  return {passed,skipped,rows,applicability:{platformSkips,conditionalFilesystemRefusalRequired:unsupportedFilesystem}}
}
/** Execute the same installed binary through native lifecycle, link and bounded-large-source fixtures. */
export function runPackedPosixStorage({ toolkit, consumer, candidateNative, evidence }) {
  assert.ok(['linux','darwin'].includes(process.platform))
  mkdirSync(evidence,{recursive:true})
  const platform=candidateNative.platformPackages.find(row=>row.platform===`${process.platform}-${process.arch}`)
  assert.ok(platform)
  const libc=process.platform==='linux'?(process.report.getReport().header.glibcVersionRuntime?'glibc':'musl'):null
  const binaryPath=process.platform==='linux'?`bin/${libc}/private-storage.node`:'bin/private-storage.node'
  const declared=platform.binaries.find(row=>row.path===binaryPath);assert.ok(declared)
  const binary=join(consumer.root,'node_modules',platform.name,binaryPath)
  assert.equal(hash(readFileSync(binary)),declared.sha256)
  const env={...nativeMatrixEnvironment(process.env),PRIVATE_STORAGE_TEST_BINARY:binary,
    PRIVATE_STORAGE_REQUIRE_DESTINATION:'1',PRIVATE_STORAGE_TEST_ROOT:realpathSync(evidence)}
  const runs=[]
  const run=(name,args,timeout=10*60_000)=>{
    const result=spawnSync(process.execPath,args,{cwd:toolkit,env,encoding:'utf8',timeout,maxBuffer:16*1024*1024})
    writeFileSync(join(evidence,`${name}.stdout.log`),result.stdout??'',{flag:'wx'})
    writeFileSync(join(evidence,`${name}.stderr.log`),result.stderr??'',{flag:'wx'})
    runs.push({name,exitCode:result.status,signal:result.signal,error:result.error?.message??null})
    writeFileSync(join(evidence,'processes.json'),JSON.stringify(runs,null,2)+'\n')
    assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr||`${name} failed`)
    return result.stdout
  }
  const core=join(toolkit,'native/system/test/private-storage.test.js')
  const contract=JSON.parse(readFileSync(join(toolkit,'workbench/private-storage-posix-contract.json'),'utf8'))
  assert.equal(hash(readFileSync(core)),contract.sourceSha256,'Native POSIX test source differs from its reviewed inventory')
  run('compile-posix-oracles',[join(toolkit,'native/system/scripts/build-test-oracle.mjs'),'--host-libc-only'])
  const output=run('posix-storage-core',['--test','--test-reporter=tap',core])
  const filesystem=statfsSync(evidence,{bigint:true}).type
  const coreResult=evaluatePosixNativeTap(output,contract,process.platform,[0x794c7630n,0x01021994n].includes(filesystem))
  const linkOutput=run('posix-retained-source-link',['--test','--test-reporter=tap',join(toolkit,'native/system/test/private-storage-source-link.test.js')])
  assert.match(linkOutput,/^# tests 1$/mu);assert.match(linkOutput,/^# pass 1$/mu);assert.match(linkOutput,/^# fail 0$/mu);assert.match(linkOutput,/^# skipped 0$/mu)
  const largeOutput=run('posix-bounded-large-source',[join(toolkit,'packages/storage/private-storage/tests/native/posix-source-large.mjs'),consumer.entry,join(evidence,'large-source')])
  assert.deepEqual(JSON.parse(largeOutput),{sourceCases:2,sourceOnly:true,accepted:false})
  const large=JSON.parse(readFileSync(join(evidence,'large-source/results.json'),'utf8'))
  assert.deepEqual(large.results.map(row=>row.expectedBytes),[64*1024*1024+1,257*1024*1024])
  for(const row of large.results){assert.equal(row.sourceVerification,true);assert.ok(row.maximumChunk<=1024*1024);assert.equal(row.fullOneGiBExecuted,false)}
  const report={schemaVersion:1,nativeExecution:true,platform:process.platform,architecture:process.arch,sourceBinarySha256:declared.sha256,
    status:'passed-required-posix-cases',core:coreResult,retainedLink:{passed:1,skipped:0},largeSourceCases:2,fullOneGiBExecuted:false,runs}
  writeFileSync(join(evidence,'posix-native.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  return report
}
