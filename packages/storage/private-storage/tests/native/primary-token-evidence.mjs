/** Bind separate ordinary/restricted child observations to SDK primary-token and quiescence evidence. */
import assert from 'node:assert/strict'

/** Derive the exact restricting SID set from separately observed caller membership. */
export function primaryRestrictingSids(userSid, groups) {
  const checkSid = sid => { assert.equal(typeof sid, 'string'); assert.match(sid, /^[0-9a-f]{16,136}$/u) }
  checkSid(userSid); assert.ok(Array.isArray(groups) && groups.length <= 4096)
  const result = new Set([userSid])
  for (const group of groups) {
    checkSid(group.sid); assert.ok(Number.isInteger(group.attributes) && group.attributes >= 0 && group.attributes <= 0xffffffff)
    if ((group.attributes & 4) && !(group.attributes & 16)) result.add(group.sid)
  }
  return [...result].sort()
}

export function validatePrimaryTokenPair(pair, expected) {
  assert.deepEqual(Object.keys(pair).sort(), ['ordinary', 'restricted'])
  for (const mode of ['ordinary', 'restricted']) {
    const { launch, child } = pair[mode], restricted = mode === 'restricted'
    assert.equal(launch.complete, true); assert.equal(child.complete, true)
    assert.equal(launch.pid, child.pid); assert.ok(Number.isInteger(child.pid) && child.pid > 0)
    assert.equal(child.mode, mode); assert.equal(launch.sameUser, true)
    for (const result of [launch, child]) {
      assert.equal(result.tokenType, 1); assert.equal(result.restricted, restricted)
      assert.equal(result.userSid, expected.userSid); assert.equal(result.threadTokenAbsent, true)
      assert.equal(result.threadTokenError, 1008)
    }
    const restrictingSids = restricted ? expected.restrictingSids : []
    assert.ok(Array.isArray(restrictingSids) && (!restricted || restrictingSids.length > 0))
    assert.equal(launch.restrictedSidCount, restrictingSids.length)
    assert.deepEqual([...launch.restrictingSids].sort(), restrictingSids)
    assert.equal(launch.restrictionSource, restricted ? 'caller-enabled-groups' : 'none')
    assert.equal(launch.logonSidPreserved, true)
    assert.equal(launch.fixtureAdjustedPrivileges, false); assert.equal(launch.handlesInherited, false)
    assert.equal(launch.processExited, true); assert.equal(launch.jobEmpty, true); assert.equal(launch.exitCode, 0)
    assert.equal(child.entrySha256, expected.entrySha256)
    assert.equal(child.nativeBinarySha256, expected.nativeBinarySha256)
    assert.equal(child.rawReadSha256, expected.recordSha256)
    assert.equal(child.publicReadSha256, restricted ? null : expected.recordSha256)
    assert.deepEqual(child.observations.map(row => row.operation), ['native-token-user', 'public-open'])
    for (const row of child.observations) {
      assert.equal(row.rejected, restricted)
      if (restricted) assert.equal(row.code, 'unsupported')
    }
  }
  return pair
}
