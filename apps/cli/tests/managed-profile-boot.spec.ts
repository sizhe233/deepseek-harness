/** Managed carrier composition consumes admitted views and leaves logical originals untouched. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createProfileDocumentView, type ProfileDocumentSelection, type ProfileDocumentViewReference } from '@deepseek-ai/dsh-app-boot/profile-documents'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { type ProfileDocuments } from '@deepseek-ai/dsh-app-boot'
import { admitRuntimeCarrier, installRuntimeAdmissionProvider, type ManagedRuntimeAdmission } from '@deepseek-ai/dsh-app-boot/runtime-admission'
import { expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

it('boots from the fixed admitted graph and view without rewriting or parsing poisoned originals', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-managed-profile-')), dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml'), rootPath = join(dir, 'cordis.yml')
  const files = [patchPath, rootPath, join(dir, 'package.json'), join(home, 'cordis.patch.yml')]
  for (const file of files) writeFileSync(file, 'original poison: [invalid\n')
  const original = files.map(file => readFileSync(file))
  const selection: ProfileDocumentSelection = { profileDir: dir, home,
    codeBinding: brandString<ProfileDocumentSelection['codeBinding']>('fixed-code'),
    packageDocuments: brandString<ProfileDocumentSelection['packageDocuments']>('fixed-packages') }
  const view = createProfileDocumentView({ selection,
    reference: brandString<ProfileDocumentViewReference>('view-one'),
    documents: [patchPath, join(home, 'cordis.patch.yml'), join(dir, 'compatibility.json')].map(logicalPath => ({ logicalPath,
      reference: brandString<ReturnType<ReturnType<typeof createProfileDocumentView>['read']>['reference']>(logicalPath),
      state: 'present' as const, text: logicalPath.endsWith('compatibility.json') ? '{}' : '[]\n' })) })
  const documents: ProfileDocuments = {
    selection, domainId: brandString<ProfileDocuments['domainId']>('documents'), current: () => view,
    refresh: async () => view, readView: async () => view,
    bundleLayers: () => ({ codeBinding: selection.codeBinding, packageDocuments: selection.packageDocuments, layers: [] }),
    async withWriteSnapshot() { throw new Error('No document publication is needed for boot') },
    inspectOperation: async () => undefined, subscribe: () => () => {},
  }
  const events: string[] = []
  const request = { carrier: 'cli' as const, entryUrl: 'file:///capsule/bin.js', home, profile: 'web', mode: 'application' as const }
  const managed: ManagedRuntimeAdmission = {
    status: 'managed', bindingId: selection.codeBinding, request, documents,
    profile: { name: 'web', dir, patchPath, patches: [], layers: [], skippedBundles: [] }, installAnchor: join(dir, 'package.json'),
    packages: { resolution: { profilesDir: join(home, 'profiles'), profileDir: dir, localPackageNames: [], entries: [], linkedRoots: [] }, packageOf: () => undefined },
    installResolution() { events.push('code-gate') },
    provideServices(ctx) { expect(ctx.get('profileDocuments')).toBe(documents); events.push('services') },
    async ready() { events.push('ready') }, async failed() { events.push('failed') },
  }
  installRuntimeAdmissionProvider({ admit: async () => managed })
  const admission = await admitRuntimeCarrier(request)
  const listeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
  vi.stubEnv('DSH_HOME', home)
  try {
    const { ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: 'web', patchFiles: [], args: [],
      applicationEntry: 'file:///generation/cli-main.js', admission })
    try {
      expect(events).toEqual(['code-gate', 'services', 'ready'])
      expect(ctx.get('runtimeAdmission')).toBe(admission)
      await ctx.pluginPackages.refresh()
      expect(() => { ctx.pluginPackages.replace(managed.packages.resolution) }).toThrow('new process activation')
      for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(original[index])
    } finally { await ctx.fiber.dispose() }
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener)
    }
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
  }
})
