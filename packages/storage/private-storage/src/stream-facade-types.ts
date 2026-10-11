/** Public generated-control authority without native provider internals. */
import type { ControlRecordWriter, ControlRecordWriterOptions } from './control-record.ts'
import type { PrivateRecordReadResult } from './private-record-reader.ts'

/** Fixed generated-record namespace under a separately caller-owned management lease. */
export interface ControlRecordOwner {
  readonly names: readonly string[]
  /**
 * @param name Admitted fixed name.
 * @param options Explicit ceiling at most 64 MiB.
 * @returns Complete observed record.
 */
  read(name: string, options: { maxBytes: number }): PrivateRecordReadResult
  /**
 * @param name Admitted fixed name.
 * @param options Current observations/revision and replacement manifest.
 * @returns One replacement transaction.
 */
  replace(name: string, options: ControlRecordWriterOptions): ControlRecordWriter
}

/** Detached artifact observations without importing a provider's file-buffer or handle API. */
export interface StreamNativeArtifact {
  readonly platform: string
  readonly architecture: string
  readonly nodeApi: 8
  readonly entry: Readonly<{ name: string; version: string; file: string; sha256: string }>
  readonly platformPackage: Readonly<{ name: string; version: string; binary: string; sha256: string; bytes: number }>
}

/** Actual selected runtime availability; it never asserts filesystem admission or test acceptance. */
export type StreamCapabilities =
  | (import('./types.ts').PrivateStorageCapabilities & {
    readonly acceptance: 'unverified'
    readonly maxStreamBytes: number
    readonly maxChunkBytes: number
  })
  | { readonly available: true
    readonly backend: 'posix'
    readonly nativeIdentity: StreamNativeArtifact
    readonly platform: string
    readonly architecture: string
    readonly maxStreamBytes: number
    readonly maxChunkBytes: number
    readonly acceptance: 'unverified' }
  | { readonly available: false
    readonly backend: 'posix'
    readonly error: unknown
    readonly reason: string
    readonly platform: string
    readonly architecture: string
    readonly maxStreamBytes: number
    readonly maxChunkBytes: number
    readonly acceptance: 'unverified' }
