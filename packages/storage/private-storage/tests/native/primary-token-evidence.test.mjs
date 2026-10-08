import test from 'node:test'
import assert from 'node:assert/strict'
import { primaryRestrictingSids, validatePrimaryTokenPair } from './primary-token-evidence.mjs'

const expected = { userSid: '010100000000000515000000', entrySha256: 'a'.repeat(64), nativeBinarySha256: 'b'.repeat(64), recordSha256: 'c'.repeat(64) }
expected.restrictingSids = [expected.userSid, '010100000000000100000000', '01010000000000050b000000'].sort()
function evidence() {
  return Object.fromEntries(['ordinary', 'restricted'].map((mode, index) => {
    const restricted = index === 1, identity = { pid: 100 + index, userSid: expected.userSid, tokenType: 1,
      restricted, threadTokenAbsent: true, threadTokenError: 1008 }
    return [mode, { launch: { ...identity, complete: true, sameUser: true, restrictedSidCount: restricted ? expected.restrictingSids.length : 0,
      restrictingSids: restricted ? [...expected.restrictingSids] : [], restrictionSource: restricted ? 'caller-enabled-groups' : 'none',
      fixtureAdjustedPrivileges: false, logonSidPreserved: true, handlesInherited: false, processExited: true, jobEmpty: true, exitCode: 0 },
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
  ['extra restricting SID', p => { p.restricted.launch.restrictingSids.push('010100000000000507000000') }],
  ['substituted restricting SID', p => { p.restricted.launch.restrictingSids[0] = '010100000000000507000000' }],
  ['duplicate restricting SID', p => { p.restricted.launch.restrictingSids[1] = p.restricted.launch.restrictingSids[0] }],
  ['three-SID diagnostic substituted', p => { p.restricted.launch.restrictionSource = 'fixed-three-sids' }],
  ['SDK restriction list absent', p => { p.restricted.launch.restrictedSidCount = 0 }],
  ['caller logon identity not retained', p => { p.restricted.launch.logonSidPreserved = false }],
  ['SDK failure', p => { p.restricted.launch.complete = false }],
]) test(`primary token evidence rejects ${name}`, () => {
  const pair = evidence(); mutate(pair); assert.throws(() => validatePrimaryTokenPair(pair, expected))
})


test('restricting SID derivation includes only caller user and enabled non-deny-only groups', () => {
  const user = expected.userSid, enabled = '010100000000000100000000', excluded = '010100000000000507000000'
  assert.deepEqual(primaryRestrictingSids(user, [
    { sid: user, attributes: 4 }, { sid: enabled, attributes: 7 }, { sid: enabled, attributes: 4 },
    { sid: excluded, attributes: 20 }, { sid: excluded, attributes: 0 },
  ]), [user, enabled].sort())
  assert.deepEqual(primaryRestrictingSids(user, []), [user])
  assert.throws(() => primaryRestrictingSids(user, [{ sid: excluded, attributes: -1 }]))
  assert.throws(() => primaryRestrictingSids(user, [{ sid: excluded, attributes: 0x100000000 }]))
  assert.throws(() => primaryRestrictingSids(user, [{ sid: 'invalid', attributes: 4 }]))
})
