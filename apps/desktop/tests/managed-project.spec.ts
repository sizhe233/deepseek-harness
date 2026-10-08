/** Desktop consumers delegate to the native document owner before touching original Profile paths. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as admission from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-managed-profile-'))
  const paths = resolveDesktopPaths(join(root, 'home'))
  const manager = new DesktopProjectManager(paths, { dsh: join(root, 'original-runtime') })
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  return { root, paths, manager }
}

it('managed startup delegates exact Home/Profile/runtime facts without initializing or locking the original Profile', async () => {
  const { paths, manager } = fixture()
  const prepare = vi.fn().mockResolvedValue(undefined), disableThirdParty = vi.fn()
  const qualify = vi.spyOn(admission, 'qualifyRuntimeProfile').mockResolvedValue({ status: 'managed', prepare, disableThirdParty })
  await manager.applyRelease()
  expect(qualify).toHaveBeenCalledExactlyOnceWith({ home: paths.home, profileDir: paths.profile, runtimeDir: manager.runtime.dsh })
  expect(prepare).toHaveBeenCalledExactlyOnceWith()
  expect(disableThirdParty).not.toHaveBeenCalled()
  expect(existsSync(paths.profile)).toBe(false)
})

it('managed crash recovery retains original files and returns the native versioned backup', async () => {
  const { root, paths, manager } = fixture()
  mkdirSync(paths.profile, { recursive: true })
  const original = join(paths.profile, 'cordis.patch.yml')
  writeFileSync(original, 'original content retained\n')
  const backup = join(root, 'native-owned-backup.yml')
  const disableThirdParty = vi.fn().mockResolvedValue(backup), prepare = vi.fn()
  vi.spyOn(admission, 'qualifyRuntimeProfile').mockResolvedValue({ status: 'managed', prepare, disableThirdParty })
  expect(await manager.disableAllPlugins()).toBe(backup)
  expect(disableThirdParty).toHaveBeenCalledExactlyOnceWith(PROFILE_TEMPLATES.web?.bundles)
  expect(prepare).not.toHaveBeenCalled()
  expect(readFileSync(original, 'utf8')).toBe('original content retained\n')
  expect(existsSync(paths.lock)).toBe(false)
})

it.each(['blocked', 'throw'] as const)('Desktop refuses %s native qualification before original mutation', async (mode) => {
  const { paths, manager } = fixture()
  const qualify = vi.spyOn(admission, 'qualifyRuntimeProfile')
  if (mode === 'blocked') qualify.mockResolvedValue({ status: 'blocked', reason: 'native binding unavailable' })
  else qualify.mockRejectedValue(new Error('native binding unavailable'))
  await expect(manager.applyRelease()).rejects.toThrow('native binding unavailable')
  await expect(manager.disableAllPlugins()).rejects.toThrow('native binding unavailable')
  expect(existsSync(paths.profile)).toBe(false)
})
