import test from 'node:test'
import assert from 'node:assert/strict'
import { collectPrimaryStartupDiagnostics } from './primary-token-diagnostics.mjs'

test('SDK startup observations retain all attempts without asserting addon acceptance', () => {
  const calls = [], result = collectPrimaryStartupDiagnostics((...args) => { calls.push(args); return { complete: true, exitCode: 0 } })
  assert.deepEqual(calls, [['token-group-facts'], ['primary-probe', 'ordinary'], ['primary-probe', 'restricted'], ['primary-probe', 'restricted-caller-groups'], ['primary-node-probe', 'restricted']])
  assert.equal(result.evidence, 'sdk-startup-diagnostic-only'); assert.equal(result.nativeAddonAcceptance, false)
  assert.equal(result.observations.length, 5)
})
for (const failed of [0, 1, 2, 3, 4]) test(`SDK diagnostic retains failure ${failed} and remaining independent probes`, () => {
  let count = 0
  const result = collectPrimaryStartupDiagnostics(() => { if (count++ === failed) throw new Error('synthetic unavailable'); return { exitCode: 3221225794 } })
  assert.equal(count, 5); assert.equal(result.nativeAddonAcceptance, false)
  assert.equal(result.observations[failed].error, 'synthetic unavailable')
  assert.equal(result.observations.filter(x => x.result?.exitCode === 3221225794).length, 4)
})
