/** Launcher-bound package changes coordinated with immutable code and Profile documents. */
import { createHash, randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ProfileDocumentSelection, ProfileDocumentViewReference } from '@deepseek-ai/dsh-app-boot'
import type { PackageOperationOptions } from './operations.ts'
import type { ChangeResult, InstallBundleOptions, PluginInstallProgress, PluginRegistries } from './types.ts'

/** Durable identity retained across package preparation, publication and response loss. */
export type ProfilePackageOperationId = Branded<'ProfilePackageOperationId'>

/** Create an operation id; a retained caller identity deterministically names the same operation.
 * @param identity Explicit domain-qualified request identity for recovery, or omitted for a fresh operation.
 * @returns A SHA256 operation id. Identity equality never grants authorization or permits changed request payloads.
 */
export function createProfilePackageOperationId(identity: string = randomUUID()): ProfilePackageOperationId {
  return brandString<ProfilePackageOperationId>(createHash('sha256').update(identity).digest('hex'))
}

/** A normal package request against one finalized native Profile read vector. */
export type ManagedPackageRequest = Readonly<{
  operationId: ProfilePackageOperationId
  expected: ProfileDocumentViewReference
}> & (Readonly<{ kind: 'install'; spec: string; options?: InstallBundleOptions }>
  | Readonly<{ kind: 'remove'; name: string }>
  | Readonly<{ kind: 'command'; args: readonly string[] }>)

/** Existing execution, consent, registry and cancellation policy; no caller pathname grants storage authority. */
export interface ManagedPackagePolicy extends PackageOperationOptions {
  readonly registries: PluginRegistries
  readonly githubConnectionTimeoutMs: number
  /** Progress changes cancellation availability only after the provider durably enters publication. */
  readonly onProgress?: (phase: PluginInstallProgress['phase'], attempt?: PluginInstallProgress['attempt']) => void
}

/** A separately installed provider owns staging, exact archive admission, publication and recovery. */
export interface ProfilePackageOperations {
  readonly selection: ProfileDocumentSelection
  /**
   * Preserve ordinary install/remove semantics in updater-owned staging, then coordinate package documents and code.
   * Script execution retains its explicit existing consent and side effects; updater rollback does not sandbox scripts.
   * @param request Fixed operation identity and expected native document selection.
   * @param policy Existing package workflow limits, registry policy, cancellation and diagnostic observers.
   * @returns Durable staging outcome; uncertain publication is failed with its operation id retained, never automatically retried.
   * Repeated operation ids inspect the persisted request and outcome; changed payloads refuse instead of rerunning scripts.
   */
  run(request: ManagedPackageRequest, policy: ManagedPackagePolicy): Promise<ChangeResult>
  /**
   * Read an existing durable operation without repeating package commands or publication.
   * @param operationId Previously submitted package operation.
   * @returns The retained result, or undefined when no operation was recorded.
   */
  inspectOperation(operationId: ProfilePackageOperationId): Promise<ChangeResult | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-admitted package provider; a missing managed provider never falls back to original-file writes. */
    profilePackageOperations: ProfilePackageOperations
  }
}
