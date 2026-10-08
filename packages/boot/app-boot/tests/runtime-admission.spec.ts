/** Carrier qualification and actual native resolver call-kind regression coverage. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.resetModules() })
const request = { carrier: 'cli' as const, entryUrl: 'file:///installed/bin.js', home: '/home/example', profile: 'web', mode: 'application' as const }
describe('fixed carrier admission', () => {
  it('positively qualifies an absent management root without creating Home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-admission-')); roots.push(root)
    const { inspectUnenrolledRuntime } = await import('../src/runtime-admission.ts')
    expect(inspectUnenrolledRuntime(join(root, 'uninitialized'))).toEqual({ status: 'unenrolled' })
    mkdirSync(join(root, 'runtime-management'))
    expect(inspectUnenrolledRuntime(root).status).toBe('blocked')
  })
  it('never falls back after a provider blocks or fails discovery', async () => {
    const admission = await import('../src/runtime-admission.ts')
    admission.installRuntimeAdmissionProvider({ async admit() { return { status: 'blocked', reason: 'known enrollment changed' } } })
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('known enrollment changed')
    await expect(admission.admitRuntimeCarrier(request)).rejects.toThrow('already admitted')
  })
  it('locks the provider and returns positive native locator absence', async () => {
    const admission = await import('../src/runtime-admission.ts')
    const provider = { async admit() { return { status: 'unenrolled' as const } } }
    admission.installRuntimeAdmissionProvider(provider)
    expect(() => { admission.installRuntimeAdmissionProvider(provider) }).toThrow('already fixed')
    expect(await admission.admitRuntimeCarrier(request)).toEqual({ status: 'unenrolled' })
    expect(admission.currentRuntimeAdmission()).toEqual({ status: 'unenrolled' })
  })
})
describe('immutable ESM and CommonJS gate', () => {
  it.each(['ordinary', 'tamper', 'escape'])('executes %s call-kind coverage in an isolated real Node process', (mode) => {
    const script = fileURLToPath(new URL('./fixtures/runtime-code-gate.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, mode], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('verified\n')
  })
})


it('shares frozen outer authority across separately built copies and preserves real child IPC grammar', () => {
  const script = fileURLToPath(new URL('./fixtures/runtime-outer-bootstrap.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('verified\n')
})


it.each(['exports', 'imports', 'main', 'type', 'directory', 'refusal', 'scale'])('revalidates %s metadata through real Node resolution', (mode) => {
  const script = fileURLToPath(new URL('./fixtures/runtime-code-metadata.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, mode], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('verified\n')
})
