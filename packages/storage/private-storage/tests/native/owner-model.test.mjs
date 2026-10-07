/** Synthetic C ownership checks. Run with: node owner-model.test.mjs <Node include directory>. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('owner-model.c', import.meta.url))
const header = fileURLToPath(new URL('owner-windows-model.h', import.meta.url))
const nodeHeaders = process.argv[2] ?? join(dirname(process.execPath), '../include/node')
const scenarios = ['reparse-copied', 'reparse-refusal', 'reparse-pending', 'reparse-exposure', 'reparse-truncated', 'reparse-overlong',
  'open-policy-read-link', 'process-running', 'process-exited', 'process-open-refusal', 'process-query-refusal',
  'process-identity-refusal', 'process-zero-birth', 'process-invalid-pid', 'process-wait-refusal', 'process-unexpected-wait',
  'process-close-unconfirmed', 'open-policy-create', 'open-policy-log', 'open-policy-read-source', 'open-policy-read',
  'open-policy-lock', 'open-policy-delete', 'open-policy-inspect', 'token-query-copied', 'token-query-impersonation', 'token-query-restricted', 'token-query-partial',
  'token-query-pointer', 'token-query-length', 'explicit-close', 'environment-cleanup', 'close-unconfirmed', 'token-release', 'token-unconfirmed',
  'local-release', 'local-unconfirmed', 'pending-settled', 'pending-cancelled', 'pending-quarantine',
  'sequential-closed-limit', 'simultaneous-live-limit', 'open-exposure-rollback', 'open-partial-rollback', 'open-registered', 'open-pending-quarantine']

test('actual C owner passes synthetic ownership responses without claiming Windows execution',
  { skip: process.platform !== 'linux' && 'Linux GCC ownership model; Windows uses the actual SDK and lifecycle runner' }, () => {
    assert.ok(existsSync(join(nodeHeaders, 'node_api.h')), 'Supply the actual Node include directory as argv[2]')
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-owner-model-'))
    try {
      for (const name of ['windows.h', 'winternl.h', 'aclapi.h']) {
        writeFileSync(join(temporary, name), `#include ${JSON.stringify(header)}\n`)
      }
      const executable = join(temporary, 'owner-model')
      const built = spawnSync('cc', ['-std=c17', '-fshort-wchar', '-Wall', '-Wextra', '-Werror',
        '-Wno-unused-function', '-ffunction-sections', '-fdata-sections', '-D_WIN64', '-D_M_X64', '-DNAPI_VERSION=8',
        '-I', temporary, '-I', nodeHeaders, fixture, '-Wl,--gc-sections', '-o', executable], { encoding: 'utf8', timeout: 30_000 })
      assert.ifError(built.error)
      assert.equal(built.signal, null)
      assert.equal(built.status, 0, built.stderr)
      for (const scenario of scenarios) {
        const child = spawnSync(executable, [scenario], { encoding: 'utf8', timeout: 10_000 })
        assert.ifError(child.error)
        assert.equal(child.signal, null, `${scenario}: ${child.stderr}`)
        assert.equal(child.status, 0, `${scenario}: ${child.stderr}`)
        assert.deepEqual(JSON.parse(child.stdout), { evidence: 'synthetic-c-ownership-model', nativeExecution: false, scenario, passed: true })
      }
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
