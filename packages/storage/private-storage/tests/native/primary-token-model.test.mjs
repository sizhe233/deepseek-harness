/** Portable responses test extracted SDK launcher control flow; actual Windows remains mandatory. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scenarios = ['quoting', 'ordinary', 'restricted', 'job-delayed-empty', 'caller-impersonation', 'caller-thread-error',
  'original-open-failure', 'original-logon-failure', 'logon-count', 'logon-attributes', 'child-logon-failure',
  'child-logon-mismatch', 'child-restricting-sid-mismatch', 'original-user-failure', 'original-restricted', 'world-sid-failure', 'restrict-failure',
  'job-create-failure', 'job-config-failure', 'create-failure', 'assign-failure', 'child-token-failure',
  'child-user-failure', 'child-groups-failure', 'child-type-query-failure', 'child-impersonation-type',
  'child-wrong-user', 'child-restrict-count', 'child-restriction-mismatch', 'child-thread-present', 'child-thread-error',
  'resume-failure', 'wait-failure', 'wait-timeout', 'exit-query-failure', 'terminate-process-failure',
  'terminate-wait-failure', 'terminate-job-failure', 'job-query-failure', 'job-never-empty', 'close-original-failure',
  'close-restricted-failure', 'close-job-failure', 'close-process-failure', 'close-thread-failure', 'close-child-token-failure']

test('actual primary-process launcher preserves token, ownership, quoting and failure obligations',
  { skip: process.platform !== 'linux' && 'Portable Linux C model; actual SDK execution is separate' }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-primary-token-model-'))
    try {
      const source = readFileSync(new URL('windows-oracle.c', import.meta.url), 'utf8')
      const helper = name => {
        const begin = source.indexOf(`static BOOL ${name}(`), end = source.indexOf('\n}', begin) + 2
        assert.ok(begin >= 0 && end > begin)
        return source.slice(begin, end)
      }
      const begin = source.indexOf('static BOOL primary_append_argument('), end = source.indexOf('\nint wmain(', begin)
      assert.ok(begin >= 0 && end > begin)
      writeFileSync(join(temporary, 'primary-process-source.inc'), `${helper('unavailable')}\n${helper('token_fixture_unavailable')}\n${source.slice(begin, end)}\n`)
      copyFileSync(fileURLToPath(new URL('primary-token-model.c', import.meta.url)), join(temporary, 'model.c'))
      const executable = join(temporary, 'model')
      const built = spawnSync('cc', ['-std=c17', '-Wall', '-Wextra', '-Werror', join(temporary, 'model.c'), '-o', executable],
        { encoding: 'utf8', timeout: 30_000 })
      assert.ifError(built.error); assert.equal(built.signal, null); assert.equal(built.status, 0, built.stderr)
      for (const scenario of scenarios) {
        const child = spawnSync(executable, [scenario], { encoding: 'utf8', timeout: 10_000 })
        assert.ifError(child.error); assert.equal(child.signal, null, `${scenario}: ${child.stderr}`)
        assert.equal(child.status, 0, `${scenario}: ${child.stderr}`)
        const result = JSON.parse(child.stdout.trim().split('\n').at(-1))
        assert.deepEqual(result, { evidence: 'synthetic-primary-process-model', nativeExecution: false, scenario, passed: true })
      }
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
