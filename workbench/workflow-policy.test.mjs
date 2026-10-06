import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import yaml from 'js-yaml'
const directory = new URL('../.github/workflows/', import.meta.url)
const own = new Set(['fork-ci.yml', 'upstream-sync.yml'])
const prefix = "${{ github.repository == 'deepseek-ai/deepseek-harness'"
function assertGuard(job) {
  assert.ok(typeof job.if === 'string' && (job.if === prefix + ' }}' || (job.if.startsWith(prefix + ' && (') && job.if.endsWith(') }}'))), 'official-only job guard required')
}
test('every inherited workflow job is guarded, including release and issue automation', () => {
  let jobs = 0
  for (const file of readdirSync(directory).filter(f => f.endsWith('.yml') && !own.has(f))) {
    const workflow = yaml.load(readFileSync(new URL(file, directory), 'utf8'))
    for (const job of Object.values(workflow.jobs)) { assertGuard(job); jobs++ }
  }
  assert.ok(jobs > 20)
})
test('guard check rejects missing and broadened repository conditions', () => {
  assert.throws(() => assertGuard({}), /guard required/)
  assert.throws(() => assertGuard({ if: prefix + ' || true }}' }), /guard required/)
})
test('candidate CI is read-only and never runs in pull_request_target context', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.deepEqual(workflow.on.push.branches, ['workbench'])
})

test('official job conditions retain their original event and disabled-state semantics', async () => {
  const { execFileSync } = await import('node:child_process')
  const baseline = JSON.parse(readFileSync(new URL('compatibility.json', import.meta.url), 'utf8')).upstreamBase
  for (const file of readdirSync(directory).filter(f => f.endsWith('.yml') && !own.has(f))) {
    const before = yaml.load(execFileSync('git', ['show', `${baseline}:.github/workflows/${file}`], { encoding: 'utf8' }))
    const after = yaml.load(readFileSync(new URL(file, directory), 'utf8'))
    for (const [name, job] of Object.entries(before.jobs)) {
      const original = typeof job.if === 'string' ? job.if.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replaceAll('\n', ' ') : job.if
      const expected = original === undefined ? prefix + ' }}' : prefix + ` && (${String(original)}) }}`
      assert.equal(after.jobs[name].if, expected, file + ':' + name)
    }
  }
})
