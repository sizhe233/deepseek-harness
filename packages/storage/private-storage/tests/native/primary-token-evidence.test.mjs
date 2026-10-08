import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePrimaryTokenPair } from './primary-token-evidence.mjs'

const expected = { userSid: 'synthetic-user-sid', entrySha256: 'a'.repeat(64), nativeBinarySha256: 'b'.repeat(64), recordSha256: 'c'.repeat(64) }
function evidence() {
  return Object.fromEntries(['ordinary', 'restricted'].map((mode, index) => {
    const restricted = index === 1, identity = { pid: 100 + index, userSid: expected.userSid, tokenType: 1,
      restricted, threadTokenAbsent: true, threadTokenError: 1008 }
    return [mode, { launch: { ...identity, complete: true, sameUser: true, restrictedSidCount: restricted ? 2 : 0,
      fixtureAdjustedPrivileges: false, handlesInherited: false, processExited: true, jobEmpty: true, exitCode: 0 },
    child: { ...identity, complete: true, mode, entrySha256: expected.entrySha256, nativeBinarySha256: expected.nativeBinarySha256,
      rawReadSha256: expected.recordSha256, publicReadSha256: restricted ? null : expected.recordSha256,
      observations: ['native-token-user', 'public-open'].map(operation => ({ operation, rejected: restricted, ...(restricted ? { code: 'unsupported' } : {}) })) } }]
  }))
}

test('primary token evidence requires matched ordinary success and restricted refusal', () => {
  const pair = evidence(); assert.equal(validatePrimaryTokenPair(pair, expected), pair)
})
for (const [name, mutate] of [
  ['thread token substituted for primary restriction', p => { p.restricted.child.tokenType = 2 }],
  ['thread impersonation present', p => { p.restricted.launch.threadTokenAbsent = false }],
  ['child not restricted', p => { p.restricted.child.restricted = false }],
  ['wrong primary subject', p => { p.restricted.child.userSid = 'different' }],
  ['native owner did not reject', p => { p.restricted.child.observations[0].rejected = false }],
  ['public storage did not reject', p => { p.restricted.child.observations[1].rejected = false }],
  ['ACL failure passed off as token refusal', p => { p.restricted.child.observations[1].code = 'privacy' }],
  ['ordinary control refused', p => { p.ordinary.child.observations[1].rejected = true }],
  ['raw restricted fixture inaccessible', p => { p.restricted.child.rawReadSha256 = null }],
  ['different native binary', p => { p.restricted.child.nativeBinarySha256 = 'd'.repeat(64) }],
  ['different entry', p => { p.ordinary.child.entrySha256 = 'd'.repeat(64) }],
  ['PID not bound', p => { p.restricted.child.pid++ }],
  ['missing child observation', p => { p.restricted.child.observations.pop() }],
  ['child timeout or failure', p => { p.restricted.launch.exitCode = 87 }],
  ['unconfirmed child exit', p => { p.restricted.launch.processExited = false }],
  ['descendant remains', p => { p.restricted.launch.jobEmpty = false }],
  ['ambient handles inherited', p => { p.restricted.launch.handlesInherited = true }],
  ['fixture enabled privileges', p => { p.restricted.launch.fixtureAdjustedPrivileges = true }],
  ['SDK restriction list absent', p => { p.restricted.launch.restrictedSidCount = 0 }],
  ['SDK failure', p => { p.restricted.launch.complete = false }],
]) test(`primary token evidence rejects ${name}`, () => {
  const pair = evidence(); mutate(pair); assert.throws(() => validatePrimaryTokenPair(pair, expected))
})
