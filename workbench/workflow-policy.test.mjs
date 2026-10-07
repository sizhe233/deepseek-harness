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

const regressionPaths = [
  'packages/boot/hmr/tests/workbench-config.spec.ts',
  'packages/client/ui-sidebar-documentpreview/tests/pdf-smoke.client.spec.ts',
  'packages/subprocess/subprocess-local/tests/local.spec.ts',
  'packages/subprocess/subprocess-local/tests/linux-scope.spec.ts',
  'packages/subprocess/subprocess-local/tests/native-containment.spec.ts',
  'packages/shell/pwsh-local/tests/executor.spec.ts',
  'packages/terminal/terminal-bash/tests/local.spec.ts',
  'packages/terminal/terminal-bash/tests/index.spec.ts',
  'packages/terminal/terminal-bash/tests/session.spec.ts',
  'packages/terminal/terminal-bash/tests/config.spec.ts',
]
function assertEarlyRegressions(steps) {
  const early = steps.findIndex(step => step.name === 'Check migration regressions before the full build')
  const build = steps.findIndex(step => step.run === 'pnpm run build')
  assert.ok(early >= 0 && build > early, 'migration regressions must precede the full build')
  const command = steps[early].run.split(/\s+/)
  for (const path of regressionPaths) assert.ok(command.includes(path), `missing regression: ${path}`)
}
test('candidate CI checks migration regressions before the full build', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  assertEarlyRegressions(workflow.jobs['linux-build-and-test'].steps)
})
test('early regression check rejects missing suites and late execution', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  for (const path of regressionPaths) {
    const steps = structuredClone(workflow.jobs['linux-build-and-test'].steps)
    const early = steps.find(step => step.name === 'Check migration regressions before the full build')
    early.run = early.run.replace(path, '')
    assert.throws(() => assertEarlyRegressions(steps), /missing regression:/)
  }
  const steps = structuredClone(workflow.jobs['linux-build-and-test'].steps)
  const early = steps.findIndex(step => step.name === 'Check migration regressions before the full build')
  steps.push(...steps.splice(early, 1))
  assert.throws(() => assertEarlyRegressions(steps), /must precede the full build/)
})

test('official job conditions retain their original event and disabled-state semantics', async () => {
  const { execFileSync } = await import('node:child_process')
  const compatibility = JSON.parse(readFileSync(new URL('compatibility.json', import.meta.url), 'utf8'))
  const baseline = compatibility.upstreamWorkflowBase ?? compatibility.upstreamBase
  for (const file of readdirSync(directory).filter(f => f.endsWith('.yml') && !own.has(f))) {
    const before = yaml.load(execFileSync('git', ['show', `${compatibility.retainedWorkflowBases?.[file] ?? baseline}:.github/workflows/${file}`], { encoding: 'utf8' }))
    const after = yaml.load(readFileSync(new URL(file, directory), 'utf8'))
    for (const [name, job] of Object.entries(before.jobs)) {
      const original = typeof job.if === 'string' ? job.if.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replaceAll('\n', ' ') : job.if
      const expected = original === undefined ? prefix + ' }}' : prefix + ` && (${String(original)}) }}`
      assert.equal(after.jobs[name].if, expected, file + ':' + name)
    }
  }
})

test('required fork status waits for Linux and native platform acceptance', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  assert.deepEqual(workflow.jobs['build-and-test'].needs, ['linux-build-and-test', 'source-coverage', 'node-22-compatibility', 'native-platforms', 'private-storage-packed'])
  assert.equal(workflow.jobs['build-and-test'].if, '${{ !cancelled() }}')
  assert.deepEqual(workflow.jobs['native-platforms'].strategy.matrix.os, ['macos-15', 'windows-2025'])
  assert.equal(workflow.jobs['native-platforms']['continue-on-error'], undefined)
  assert.equal(workflow.jobs['linux-build-and-test']['continue-on-error'], undefined)
  assert.equal(workflow.jobs['build-and-test'].steps[0].env.RESULTS, '${{ toJSON(needs) }}')
  assert.match(workflow.jobs['build-and-test'].steps[0].run, /job.result!=="success"/)
})

function assertBrowserAcceptance(workflow) {
  assert.equal(workflow.jobs['linux-build-and-test'].env.DSH_SNAPSHOT, 'replay')
  const steps = workflow.jobs['linux-build-and-test'].steps
  assert.ok(steps.some(step => step.run === 'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium'), 'workspace-pinned Chromium required')
  const browser = steps.find(step => step.name === 'Replay settings and plan browser acceptance')
  assert.ok(browser && !browser['continue-on-error'], 'strict browser replay required')
  for (const path of ['settings-chrome.e2e.ts', 'plan-control-row.e2e.ts']) assert.ok(browser.run.includes(path), `missing browser acceptance: ${path}`)
  assert.ok(!browser.run.includes('refresh'), 'CI must not rewrite goldens')
  const artifact = steps.find(step => step.name === 'Preserve browser failure evidence')
  assert.equal(artifact.if, '${{ failure() }}')
  for (const script of ['pnpm run typecheck', 'pnpm run lint:contracts-ready', 'pnpm run doc-sync']) assert.ok(steps.some(step => step.run === script), `missing static acceptance: ${script}`)
}
test('candidate CI requires pinned strict browser replay and static acceptance', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  assertBrowserAcceptance(workflow)
  const relaxed = structuredClone(workflow)
  relaxed.jobs['linux-build-and-test'].env.DSH_SNAPSHOT = 'refresh'
  assert.throws(() => assertBrowserAcceptance(relaxed))
  const missing = structuredClone(workflow)
  missing.jobs['linux-build-and-test'].steps = missing.jobs['linux-build-and-test'].steps.filter(step => step.name !== 'Replay settings and plan browser acceptance')
  assert.throws(() => assertBrowserAcceptance(missing), /strict browser replay required/)
})

test('each native runner explicitly requires real PowerShell PTY cases', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  for (const job of ['linux-build-and-test', 'native-platforms']) {
    const step = workflow.jobs[job].steps.find(step => step.name === 'Require real PowerShell PTY acceptance')
    assert.equal(step?.run, 'pnpm exec vitest run --config workbench/vitest.native-pwsh.config.ts')
    assert.equal(step?.['continue-on-error'], undefined)
  }
  const config = readFileSync(new URL('vitest.native-pwsh.config.ts', import.meta.url), 'utf8')
  assert.match(config, /if \(probe.status !== 0\) throw new Error/)
  assert.ok(config.includes('terminal-bash/tests/local.spec.ts'))
})

test('coverage, recorded Sessions, SDKs, and built expectations remain blocking', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const coverage = workflow.jobs['source-coverage']
  assert.equal(coverage['continue-on-error'], undefined)
  assert.ok(coverage.steps.some(step => step.run === 'pnpm run check:ci:coverage'))
  const steps = workflow.jobs['linux-build-and-test'].steps
  for (const command of ['pnpm run hygiene', 'pnpm run test:snapshot', 'pnpm run test:expected']) {
    const step = steps.find(step => step.run === command)
    assert.ok(step, `missing consumer acceptance: ${command}`)
    assert.equal(step['continue-on-error'], undefined)
  }
})

test('candidate producer jobs check out the exact PR source and packed jobs consume its verified artifact', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const source = '${{ github.event.pull_request.head.sha || github.sha }}'
  assert.equal(workflow.env.CANDIDATE_SHA, source)
  assert.equal(workflow.env.DSH_ARCHIVE_BASE_REF, "${{ github.event.pull_request.base.sha || github.event.before || 'origin/workbench' }}")
  for (const name of ['linux-build-and-test', 'source-coverage', 'node-22-compatibility', 'native-platforms']) {
    const checkout = workflow.jobs[name].steps.find(step => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, source)
    assert.equal(checkout.with['persist-credentials'], false)
  }
  const packed = workflow.jobs['private-storage-packed']
  assert.deepEqual(packed.needs, ['private-storage-artifact'])
  assert.equal(packed['continue-on-error'], undefined)
  assert.equal(packed.if, undefined)
  assert.ok(!packed.steps.some(step => step.uses?.startsWith('actions/checkout@')))
  assert.equal(packed.env.EXPECTED_MANIFEST_SHA256, '${{ needs.private-storage-artifact.outputs.manifest-sha256 }}')
  assert.equal(packed.env.CANDIDATE_ARTIFACT_DIGEST, '${{ needs.private-storage-artifact.outputs.artifact-digest }}')
  assert.deepEqual(packed.steps.find(step => step.uses === 'actions/download-artifact@v4').with, {
    'artifact-ids': '${{ needs.private-storage-artifact.outputs.artifact-id }}', 'merge-multiple': true, path: 'candidate',
  })
  const upload = workflow.jobs['linux-build-and-test'].steps.find(step => step.with?.name?.startsWith('host-candidate-'))
  assert.equal(upload.with.name, 'host-candidate-${{ env.CANDIDATE_SHA }}')
})

test('native platforms exercise the adjacent Session upgrade and generation retention', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const step = workflow.jobs['native-platforms'].steps.find(step => step.name === 'Check native watcher and terminal compatibility')
  for (const path of ['packages/session/session-format-v4-to-v5/tests/migration.spec.ts', 'packages/session/session-persistence-jsonl/tests/v5-checkpoints.spec.ts']) assert.ok(step.run.includes(path), `missing native persistence test: ${path}`)
})

test('the minimum supported Node runtime is a required native compatibility job', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const job = workflow.jobs['node-22-compatibility']
  assert.equal(job['continue-on-error'], undefined)
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '22.19.0')
  assert.ok(job.steps.some(step => step.run === 'pnpm run check:node-compat'))
})

test('Linux acceptance cannot silently pass without the native user manager', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const step = workflow.jobs['linux-build-and-test'].steps.find(step => step.name === 'Require Linux native containment availability')
  assert.equal(step?.run, 'systemd-run --user --scope --quiet --collect --expand-environment=no -- /usr/bin/true')
  assert.equal(step?.['continue-on-error'], undefined)
})

test('candidate bytes are available for parallel private acceptance while every final check stays required', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const steps = workflow.jobs['linux-build-and-test'].steps
  const seams = steps.findIndex(step => step.run === 'node --test workbench/*.test.mjs')
  const patch = steps.findIndex(step => step.run === 'node workbench/apply-runtime-seams.mjs')
  const pack = steps.findIndex(step => step.name === 'Package candidate host and web artifacts')
  const browser = steps.findIndex(step => step.name === 'Replay settings and plan browser acceptance')
  assert.ok(seams >= 0 && patch > seams && pack > patch && browser > pack)
  const unit = steps.find(step => step.name === 'Run the complete built unit inventory')
  assert.equal(unit?.run, 'time pnpm test --maxWorkers=2')
  assert.equal(unit.env.DSH_COVERAGE_TEST_TIMEOUT_MS, '90000')
  assert.equal(unit.if, undefined)
  assert.equal(unit['continue-on-error'], undefined)
  assert.equal(steps[browser]['continue-on-error'], undefined)
})


test('minimum Node acceptance builds its native sandbox before source worker execution', () => {
  const source = readFileSync(new URL('../.github/workflows/fork-ci.yml', import.meta.url), 'utf8')
  const job = source.split('  node-22-compatibility:')[1].split('  native-platforms:')[0]
  const native = job.indexOf('bash workbench/prepare-linux-sandbox.sh')
  assert.ok(native > job.indexOf('pnpm install --frozen-lockfile'))
  assert.ok(native < job.indexOf('pnpm run check:node-compat'))
})

test('macOS requires real default-shell acceptance independently of optional PowerShell', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const steps = workflow.jobs['native-platforms'].steps
  const native = steps.findIndex(step => step.run === 'pnpm run build:native-system')
  const shell = steps.findIndex(step => step.name === 'Require macOS default and configured zsh acceptance')
  const compatibility = steps.findIndex(step => step.name === 'Check native watcher and terminal compatibility')
  assert.ok(native >= 0 && shell > native && compatibility > shell)
  assert.equal(steps[shell].if, "${{ runner.os == 'macOS' }}")
  assert.equal(steps[shell].run, 'pnpm exec vitest run packages/api/terminal-controller/tests/native-macos-shell.spec.ts --maxWorkers=1')
  assert.equal(steps[shell].env.DSH_COVERAGE_TEST_TIMEOUT_MS, '90000')
  assert.equal(steps[shell]['continue-on-error'], undefined)
})


test('Linux build and coverage require a real enforcing sandbox without security-setting changes', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  for (const name of ['linux-build-and-test', 'source-coverage', 'node-22-compatibility']) {
    const steps = workflow.jobs[name].steps
    const sandbox = steps.findIndex(step => step.run === 'bash workbench/prepare-linux-sandbox.sh')
    assert.ok(sandbox > steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'))
    assert.equal(steps[sandbox].if, undefined)
    assert.equal(steps[sandbox]['continue-on-error'], undefined)
  }
  const script = readFileSync(new URL('./prepare-linux-sandbox.sh', import.meta.url), 'utf8')
  assert.match(script, /set -euo pipefail/)
  assert.match(script, /pnpm --dir native\/system run build:native/)
  assert.match(script, /NALR_REQUIRE_LANDLOCK=1 pnpm --dir native\/system run test:launcher/)
  assert.doesNotMatch(script, /sysctl|danger-full-access|unshare|host-addon-only/)
})


test('candidate packaging depends on the complete same-source native prebuild matrix', () => {
  const workflow = yaml.load(readFileSync(new URL('fork-ci.yml', directory), 'utf8'))
  const matrix = workflow.jobs['native-build-matrix'], native = workflow.jobs['native-prebuilds']
  assert.equal(native.needs, 'native-build-matrix')
  assert.equal(native.strategy['fail-fast'], false)
  assert.equal(native.strategy.matrix, '${{ fromJSON(needs.native-build-matrix.outputs.matrix) }}')
  assert.ok(matrix.steps.some(step => step.run?.includes('github-matrix.mjs release-prebuild')))
  for (const job of [matrix, native]) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}')
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(job['continue-on-error'], undefined)
  }
  assert.equal(workflow.jobs['linux-build-and-test'].needs, 'native-prebuilds')
  assert.equal(workflow.jobs['private-storage-artifact'].needs, 'native-prebuilds')
  assert.ok(native.steps.some(step => step.run === 'node workbench/native-build-artifact.mjs prepare . workbench-artifacts/native-output'))
  const upload = native.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload.with.name, 'candidate-native-${{ matrix.package }}')
  assert.equal(upload.with.path, 'workbench-artifacts/native-output/')
  const download = workflow.jobs['linux-build-and-test'].steps.find(step => step.with?.pattern === 'candidate-native-*')
  assert.equal(download.with.path, 'workbench-artifacts/native-candidate-inputs')
  assert.match(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^workbench-artifacts\/$/mu)
  assert.equal(upload.with['if-no-files-found'], 'error')
  const pack = workflow.jobs['linux-build-and-test'].steps.find(step => step.name === 'Package candidate host and web artifacts')
  assert.equal(pack.env.CANDIDATE_NATIVE_ARTIFACTS, 'workbench-artifacts/native-candidate-inputs')
})
