/** Synthetic TAP applicability parsing; no report here is native acceptance. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { evaluatePosixNativeTap } from './private-storage-posix-native.mjs'
const contract=JSON.parse(readFileSync(new URL('./private-storage-posix-contract.json',import.meta.url),'utf8'))
function report(platform,change=()=>{}){
 const skips=new Set([...(platform==='linux'?contract.darwinOnly:contract.linuxOnly),...Object.keys(contract.conditionalFilesystemOnly)])
 const rows=contract.inventory.map(name=>({name,status:skips.has(name)?'SKIP':'passed'}));change(rows)
 const passed=rows.filter(row=>row.status==='passed').length,failed=rows.filter(row=>row.status==='failed').length,skipped=rows.filter(row=>row.status==='SKIP').length
 return 'TAP version 13\n'+rows.map((row,index)=>`${row.status==='failed'?'not ok':'ok'} ${index+1} - ${row.name}${row.status==='SKIP'||row.status==='TODO'?` # ${row.status}`:''}`).join('\n')+`\n1..${rows.length}\n# tests ${rows.length}\n# pass ${passed}\n# fail ${failed}\n# skipped ${skipped}\n`
}
for(const [platform,passed,skipped]of[['linux',60,3],['darwin',57,6]])test(`requires the exact ${platform} persistent native inventory`,()=>{
 const result=evaluatePosixNativeTap(report(platform),contract,platform,false)
 assert.equal(result.passed,passed);assert.equal(result.skipped,skipped)
})
for(const[name,change]of[
 ['a skipped required test',rows=>rows[0].status='SKIP'],
 ['a failed required test',rows=>rows[0].status='failed'],
 ['a TODO test',rows=>rows[0].status='TODO'],
 ['a missing test',rows=>rows.pop()],
 ['an extra test',rows=>rows.push({name:'extra',status:'passed'})],
 ['a duplicate test',rows=>rows[1].name=rows[0].name],
 ['a platform test falsely counted as a pass',rows=>rows.find(row=>row.name===contract.darwinOnly[0]).status='passed'],
])test(`refuses ${name}`,()=>assert.throws(()=>evaluatePosixNativeTap(report('linux',change),contract,'linux',false)))
test('does not allow a skipped unsupported-filesystem refusal when its actual volume requires that case',()=>{
 assert.throws(()=>evaluatePosixNativeTap(report('linux'),contract,'linux',true),/Undeclared native skip/)
})
test('refuses absent or inconsistent aggregate totals',()=>{
 for(const text of[report('linux').replace('# pass 60','# pass 61'),report('linux').replace('# tests 63',''),report('linux').replace('# skipped 3','# skipped 0')])assert.throws(()=>evaluatePosixNativeTap(text,contract,'linux',false))
})
