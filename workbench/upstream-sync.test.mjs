import test from 'node:test'
import assert from 'node:assert/strict'
import { proposeSync } from './upstream-sync.mjs'
const base = 'a'.repeat(40), head = 'b'.repeat(40)
function mock({ ahead = 3, conflict = false, existing = false } = {}) {
  const writes = []
  return { writes, api: async (method, path, body) => {
    if (method !== 'GET') writes.push({ method, path, body })
    if (path.endsWith('/branches/workbench')) return { commit: { sha: base } }
    if (path.endsWith('/commits/master')) return { sha: head }
    if (path.includes('/compare/')) return { ahead_by: ahead }
    if (method === 'GET' && path.includes('/pulls?')) return existing ? [{ html_url: 'existing' }] : []
    if (path.includes('/git/ref/')) throw Object.assign(new Error('missing'), { status: 404 })
    if (path.endsWith('/merges') && conflict) throw Object.assign(new Error('conflict'), { status: 409 })
    if (method === 'GET' && path.includes('/issues?')) return []
    if (path.endsWith('/pulls') || path.endsWith('/issues')) return { html_url: 'created' }
    return null
  } }
}
test('current and dry-run paths never write remote state', async () => {
  for (const config of [{ ahead: 0 }, { ahead: 3 }]) {
    const m = mock(config); await proposeSync(m.api, { dryRun: true }); assert.deepEqual(m.writes, [])
  }
})
test('clean merge creates a draft review and explicitly dispatches read-only CI', async () => {
  const m = mock(); assert.equal((await proposeSync(m.api)).state, 'draft-pr')
  assert.equal(m.writes.find(x => x.path.endsWith('/pulls')).body.draft, true)
  assert.equal(m.writes.at(-1).path.endsWith('/fork-ci.yml/dispatches'), true)
  assert.equal(m.writes.some(x => x.method === 'PATCH' || x.method === 'DELETE'), false)
})
test('conflict creates a task but never creates a PR or dispatches candidate execution', async () => {
  const m = mock({ conflict: true }); assert.equal((await proposeSync(m.api)).state, 'needs-agent')
  assert.equal(m.writes.at(-1).path.endsWith('/issues'), true)
  assert.equal(m.writes.some(x => x.path.includes('/dispatches')), false)
})
test('existing PR is never overwritten', async () => {
  const m = mock({ existing: true }); assert.equal((await proposeSync(m.api)).state, 'existing-pr'); assert.deepEqual(m.writes, [])
})
