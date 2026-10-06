import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = 'sizhe233/deepseek-harness'
const upstream = 'deepseek-ai/deepseek-harness'
export async function proposeSync(api, { dryRun = false } = {}) {
  const base = await api('GET', `/repos/${repo}/branches/workbench`)
  const head = await api('GET', `/repos/${upstream}/commits/master`)
  for (const sha of [base.commit.sha, head.sha]) assert.match(sha, /^[a-f0-9]{40}$/)
  const comparison = await api('GET', `/repos/${repo}/compare/${base.commit.sha}...${head.sha}`)
  if (comparison.ahead_by === 0) return { state: 'current', upstream: head.sha }
  assert.ok(Number.isInteger(comparison.ahead_by) && comparison.ahead_by > 0)
  const branch = `codex/upstream-${head.sha.slice(0, 12)}-${base.commit.sha.slice(0, 8)}`
  const plan = { branch, base: base.commit.sha, upstream: head.sha, commits: comparison.ahead_by }
  if (dryRun) return { state: 'proposed', ...plan }
  const prs = await api('GET', `/repos/${repo}/pulls?state=all&head=sizhe233:${branch}&base=workbench`)
  if (prs.length) return { state: 'existing-pr', url: prs[0].html_url, ...plan }
  try { await api('GET', `/repos/${repo}/git/ref/heads/${branch}`) }
  catch (error) {
    if (error.status !== 404) throw error
    await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.commit.sha })
  }
  let conflict = false
  try {
    await api('POST', `/repos/${repo}/merges`, { base: branch, head: head.sha, commit_message: `Merge official upstream ${head.sha.slice(0, 12)} for compatibility review` })
  } catch (error) {
    if (error.status !== 409) throw error
    conflict = true
  }
  if (conflict) {
    const marker = `<!-- upstream-sync:${head.sha}:${base.commit.sha} -->`
    const issues = await api('GET', `/repos/${repo}/issues?state=all&per_page=100`)
    const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(marker))
    if (existing) return { state: 'existing-conflict', url: existing.html_url, ...plan }
    const issue = await api('POST', `/repos/${repo}/issues`, {
      title: `Agent task: reconcile upstream ${head.sha.slice(0, 12)}`,
      body: `${marker}\nOfficial commit: ${head.sha}\nFork base: ${base.commit.sha}\nCandidate: ${branch}\n\nThe GitHub merge API reported conflicts. An external agent must inspect the conflict in an isolated checkout, preserve every item in workbench/compatibility.json, follow workbench/README.md, and open a PR against workbench. Do not reset the fork to upstream or deploy production. Run relevant tests and Fork CI; link private plugin acceptance without exposing private code. No agent executor is configured by this workflow.`,
    })
    return { state: 'needs-agent', url: issue.html_url, ...plan }
  }
  const pr = await api('POST', `/repos/${repo}/pulls`, {
    title: `Sync official upstream ${head.sha.slice(0, 12)}`, head: branch, base: 'workbench', draft: true,
    body: `Official commit: ${head.sha}\nFork base: ${base.commit.sha}\n\nThe merge was conflict-free; compatibility is NOT yet accepted. Review the local patch inventory, run Fork CI, and link private plugin compatibility evidence before merging. No production deployment is authorized. External-agent execution remains separately configured.`,
  })
  await api('POST', `/repos/${repo}/actions/workflows/fork-ci.yml/dispatches`, { ref: branch })
  return { state: 'draft-pr', url: pr.html_url, ...plan }
}
async function github(method, path, body) {
  const response = await fetch('https://api.github.com' + path, {
    method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) { const error = new Error(`GitHub ${method} ${path}: ${response.status}`); error.status = response.status; throw error }
  return response.status === 204 ? null : response.json()
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required')
  console.log(JSON.stringify(await proposeSync(github, { dryRun: process.argv.includes('--dry-run') }), null, 2))
}
