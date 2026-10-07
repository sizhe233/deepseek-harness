/** Probe classification models preserve the kernel-lock domain and all cleanup uncertainty. */
import { expect, it } from 'vitest'
import { isManagementLeaseBusy } from '../src/management-lease-error.ts'
import { PrivateStorageError } from '../src/error.ts'
const posix = () => ({ code: 'EAGAIN', errno: 11, syscall: 'flock', cleanupFailed: false, leaseHeld: false,
  creation: { kind: 'lease', bindingVerified: true, release: { attempted: true, completed: true, errno: null },
    facts: { kind: 'regular', nlink: '1', size: '0', mode: 0o100600 } } })
it('recognizes exact Windows and both POSIX nonblocking lock refusals after confirmed probe cleanup', () => {
  expect(isManagementLeaseBusy(new PrivateStorageError('busy', 'lock refused', { win32Code: 33 }))).toBe(true)
  expect(isManagementLeaseBusy(posix())).toBe(true); expect(isManagementLeaseBusy({ ...posix(), errno: 35 })).toBe(true)
})
it('rejects unrelated errors, wrong lock domains and every unconfirmed or contradictory release observation', () => {
  const sample = posix()
  for (const value of [null, 'busy', {}, new AggregateError([sample]), new PrivateStorageError('sharing', 'sharing', { win32Code: 32 }),
    new PrivateStorageError('busy', 'unknown'), new PrivateStorageError('busy', 'close failed', { win32Code: 33, cleanupFailed: true }),
    ...[{ code: 'EACCES' }, { syscall: 'openat' }, { errno: 5 }, { cleanupFailed: true }, { leaseHeld: true }, { creation: null },
      { creation: { ...sample.creation, kind: 'staging' } }, { creation: { ...sample.creation, bindingVerified: false } },
      { creation: { ...sample.creation, release: null } },
      ...[{ attempted: false }, { completed: false }, { errno: 5 }].map(value => ({ creation: {
        ...sample.creation, release: { ...sample.creation.release, ...value } } })),
      { creation: { ...sample.creation, facts: null } },
      ...[{ kind: 'directory' }, { nlink: '2' }, { size: '1' }, { mode: '0600' }, { mode: 0o100644 }].map(value => ({
        creation: { ...sample.creation, facts: { ...sample.creation.facts, ...value } } })),
    ].map(value => ({ ...sample, ...value }))]) expect(isManagementLeaseBusy(value)).toBe(false)
})
