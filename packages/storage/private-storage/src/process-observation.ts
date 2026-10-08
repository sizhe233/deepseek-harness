/** Bounded native birth observations; a missing or inaccessible process never implies confirmed exit. */
import { loadWindowsPrivateOwner } from '@deepseek-ai/node-addon-system/windows-private-owner'
import { loadPosixStoragePrimitives } from '@deepseek-ai/node-addon-system/private-storage'
import { PrivateStorageError } from './error.ts'

/** Kernel birth observations do not grant process signaling or permission to reclaim another writer's lease. */
export type ProcessBirthObservation = {
  readonly platform: 'win32'
  readonly pid: number
  readonly creationTime100ns: string
  readonly state: 'running' | 'exited'
  readonly mechanism: 'GetProcessTimes+WaitForSingleObject'
  readonly observationOnly: true
} | {
  readonly platform: 'darwin'
  readonly pid: number
  readonly parentPid: number
  readonly uid: string
  readonly scope: 'current-process' | 'direct-child'
  readonly mechanism: 'proc_pid_rusage(RUSAGE_INFO_V0)'
  readonly startAbstime: string
  readonly bootSessionUuid: string
  readonly observationOnly: true
}

/**
 * Observe an explicitly selected current or owned child process through the native provider.
 * @param pid Exact caller-owned process identifier; this method never enumerates or signals processes.
 * @returns Lossless kernel birth fields and any explicitly observed exit state.
 * @throws On missing, inaccessible, unsupported or unsettled observations; those errors never establish exit.
 */
export function observeProcessBirth(pid: number): ProcessBirthObservation {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw new RangeError('process identifier must be a positive uint32')
  if (process.platform === 'win32') return Object.freeze({ ...loadWindowsPrivateOwner().observeProcess(pid) })
  if (process.platform === 'darwin') return Object.freeze({ ...loadPosixStoragePrimitives().observeProcessBirth(pid) })
  throw new PrivateStorageError('unsupported', 'native process birth observation is unavailable on this platform')
}
