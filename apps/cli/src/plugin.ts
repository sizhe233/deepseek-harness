/** Profile package management and explicit, exact-version compatibility approvals. */
import { createProfilePackageOperationId, runPluginCommand, runProfilePnpm, setProfileVersionExemption, type PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { INSTALL_ANCHOR } from './profile-boot.ts'
import { DEFAULT_PROFILE_BUNDLES, initProfile, PROFILE_TEMPLATES, readProfileCompatibility, resolveProfileDir, type ProfileContext, type ProfileDocuments } from '@deepseek-ai/dsh-app-boot'
import { currentRuntimeAdmission, requireManagedRuntimeAdmission, type ManagedRuntimeAdmission } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

function requireDesktopProfile(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error('Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.')
  }
}

/** Parse only DSH-owned commands; all other arguments remain pnpm's responsibility. */
async function versionCommand(profile: string, args: readonly string[], documents?: ProfileDocuments): Promise<number | undefined> {
  const [command, ...rest] = args
  if (command !== 'allow-version' && command !== 'revoke-version' && command !== 'version-exemptions') return undefined
  try {
    let packageVersion: string | undefined
    let runtimeVersion: string | undefined
    let acceptRisk = false
    const argumentsIterator = rest.values()
    for (const argument of argumentsIterator) {
      if (argument === '--accept-risk' && command === 'allow-version' && !acceptRisk) acceptRisk = true
      else if (argument === '--dsh-version' && runtimeVersion === undefined) runtimeVersion = argumentsIterator.next().value
      else if (argument.startsWith('--dsh-version=') && runtimeVersion === undefined) runtimeVersion = argument.slice('--dsh-version='.length)
      else if (!argument.startsWith('-') && packageVersion === undefined) packageVersion = argument
      else throw new Error(`unexpected argument ${JSON.stringify(argument)}`)
    }
    if (command === 'version-exemptions' && rest.length > 0) throw new Error('usage: dsh plugin version-exemptions')
    let request: { packageVersion: string; runtimeVersion: string } | undefined
    if (command !== 'version-exemptions') {
      if (packageVersion === undefined || runtimeVersion === undefined) {
        throw new Error(`usage: dsh plugin ${command} <package@version> --dsh-version <exact>${command === 'allow-version' ? ' --accept-risk' : ''}`)
      }
      request = { packageVersion, runtimeVersion }
    }
    if (command === 'allow-version') {
      process.stderr.write('dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.\n')
    }
    const dir = documents?.selection.profileDir ?? resolveProfileDir(profile)
    const apply = async () => {
      if (request === undefined) {
        const { exemptions, warnings } = readProfileCompatibility(dir, documents === undefined ? undefined : await documents.refresh())
        for (const warning of warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
        process.stdout.write(JSON.stringify(exemptions, undefined, 2) + '\n')
      } else {
        await setProfileVersionExemption(dir, request.packageVersion, request.runtimeVersion, command === 'allow-version', acceptRisk, documents)
        process.stdout.write(`dsh: ${command === 'allow-version' ? 'allowed' : 'revoked'} ${request.packageVersion} for DSH ${request.runtimeVersion}\n`)
      }
    }
    if (documents !== undefined) await apply()
    else {
      if (profile !== 'desktop') await mkdir(dir, { recursive: true })
      await withFileLock(join(dir, 'package.json'), async () => {
        if (profile === 'desktop') requireDesktopProfile(dir)
        else if (!existsSync(join(dir, 'package.json'))) initProfile(dir, PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES)
        await apply()
      }, { waitMs: 120000 })
    }
    return 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  }
}

/** Reuse the fixed carrier's services without mounting business plugins or reopening the logical Profile. */
async function runManagedPlugin(
  admission: ManagedRuntimeAdmission, profile: string, args: readonly string[], packageManager?: ProfileContext['packageManager'],
): Promise<number> {
  const ctx = new Context()
  try {
    requireManagedRuntimeAdmission(admission)
    if (admission.request.profile !== profile || admission.request.mode !== 'package') throw new Error('Package invocation differs from carrier admission')
    const versionResult = await versionCommand(profile, args, admission.documents)
    if (versionResult !== undefined) return versionResult
    await admission.provideServices(ctx)
    const provider = ctx.get('profilePackageOperations')
    if (provider === undefined) throw new Error('Managed CLI package commands require the installed native package provider')
    for (const key of ['profileDir', 'home', 'codeBinding', 'packageDocuments'] as const) {
      if (provider.selection[key] !== admission.documents.selection[key]) throw new Error('CLI package provider belongs to another Profile selection')
    }
    const view = await admission.documents.refresh()
    const operationId = createProfilePackageOperationId()
    const result = await provider.run({ kind: 'command', args: [...args], operationId, expected: view.reference }, {
      ...packageManager, execution: 'cli', outputBytes: 16384, lockWaitMs: 120000,
      lookupTimeoutMs: 120000, githubConnectionTimeoutMs: 5000,
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      onOutput: (text, stream) => { process[stream].write(text) },
    })
    if (result.operationId !== operationId) throw new Error(`Package receipt does not match operation ${operationId}`)
    if (result.error !== undefined) process.stderr.write(`dsh: ${result.error.diagnostic ?? result.error.code}; operation ${operationId}\n`)
    for (const warning of result.warnings ?? []) process.stderr.write(`dsh: warning: ${warning}\n`)
    if (result.application === 'failed' || result.application === 'cancelled') return result.packageResult?.exitCode || 1
    return result.packageResult?.exitCode ?? 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  } finally { await ctx.fiber.dispose() }
}

/** Run package management for a profile.
 * @param profile Profile name; Desktop's reserved profile must already be initialized by the application.
 * @param args DSH exemption command or pnpm arguments relative to the invoking directory.
 * @param packageManager Installation-owned executable and environment for pnpm operations.
 * @returns Zero on success; nonzero on invalid approval or package-manager failure.
 */
export async function runPlugin(profile: string, args: readonly string[], packageManager?: ProfileContext['packageManager']): Promise<number> {
  const admission = currentRuntimeAdmission()
  if (admission?.status === 'managed') return runManagedPlugin(admission, profile, args, packageManager)
  if (profile === 'desktop') {
    try { requireDesktopProfile(resolveProfileDir(profile)) } catch (error) {
      process.stderr.write(`dsh: ${String(error)}\n`)
      return 1
    }
  }
  const versionResult = await versionCommand(profile, args)
  if (versionResult !== undefined) return versionResult
  const dir = resolveProfileDir(profile)
  if (existsSync(join(dir, 'package.json'))) {
    for (const warning of readProfileCompatibility(dir).warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
  }
  const context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }
  const options: PackageOperationOptions = {
    ...packageManager,
    execution: 'cli',
    outputBytes: 16384,
    lockWaitMs: 120000,
    lookupTimeoutMs: 120000,
    onOutput: (text, stream) => { process[stream].write(text) },
  }
  const result = profile === 'desktop'
    ? await withFileLock(join(dir, 'package.json'), async () => {
      requireDesktopProfile(dir)
      return runProfilePnpm(context, args, options)
    }, { waitMs: 120000 })
    : await runPluginCommand(context, args, options)
  if (result.exitCode === 127) process.stderr.write('dsh: pnpm was not found; install pnpm and make it available on PATH.\n')
  for (const { name, version, runtimeVersion } of result.incompatible ?? []) {
    process.stderr.write(`dsh: to accept the risk, run: dsh plugin --profile ${profile} allow-version ${name}@${version} --dsh-version ${runtimeVersion} --accept-risk\n`)
  }
  if (result.exitCode !== 0) process.stderr.write(`dsh: plugin command failed; diagnostics: ${result.logPath}\n`)
  if (result.exitCode !== 0 && args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(resolveProfileDir(profile), 'pnpm-workspace.yaml')}, then re-run\n`)
  }
  return result.exitCode
}
