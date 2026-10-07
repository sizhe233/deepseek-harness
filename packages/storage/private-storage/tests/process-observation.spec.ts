/** Public process observation routing; synthetic native results never establish platform acceptance. */
import { afterEach, expect, it, vi } from 'vitest'
import { observeProcessBirth } from '../src/process-observation.ts'
const fixture = vi.hoisted(() => ({ calls: [] as number[], error: undefined as unknown }))
vi.mock('@deepseek-ai/node-addon-system/windows-private-owner', () => ({ loadWindowsPrivateOwner: () => ({ observeProcess(pid: number) {
  fixture.calls.push(pid); if (fixture.error !== undefined) throw fixture.error
  return { platform: 'win32', pid, creationTime100ns: '18446744073709551608', state: 'running',
    mechanism: 'GetProcessTimes+WaitForSingleObject', observationOnly: true }
} }) }))
vi.mock('@deepseek-ai/node-addon-system/private-storage', () => ({ loadPosixStoragePrimitives: () => ({ observeProcessBirth(pid: number) {
  fixture.calls.push(pid); if (fixture.error !== undefined) throw fixture.error
  return { platform: 'darwin', pid, parentPid: 1, uid: '501', scope: 'current-process',
    mechanism: 'proc_pid_rusage(RUSAGE_INFO_V0)', startAbstime: '123', bootSessionUuid: 'synthetic-boot', observationOnly: true }
} }) }))
const actual = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', actual); fixture.calls.length = 0; fixture.error = undefined })
it.each(['win32', 'darwin'])('preserves lossless native birth identity on %s', (platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  const observed = observeProcessBirth(42)
  expect(observed).toMatchObject({ platform, pid: 42, observationOnly: true })
  if (observed.platform === 'win32') expect(observed.creationTime100ns).toBe('18446744073709551608')
  expect(Object.isFrozen(observed)).toBe(true); expect(fixture.calls).toEqual([42])
})
it.each(['win32', 'darwin'])('retains inaccessible and missing process refusals rather than producing an exit claim on %s', (platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  for (const code of [5, 87]) {
    const failure = Object.assign(new Error('observation unresolved'), { win32Code: code }); fixture.error = failure
    expect(() => observeProcessBirth(42)).toThrow(failure)
  }
})
it('refuses unsupported platforms and invalid process identifiers before loading a provider', () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  expect(() => observeProcessBirth(42)).toThrow(expect.objectContaining({ code: 'unsupported' }))
  for (const pid of [0, -1, 0.5, Infinity, NaN, 0x100000000]) expect(() => observeProcessBirth(pid)).toThrow(RangeError)
  expect(fixture.calls).toEqual([])
})
