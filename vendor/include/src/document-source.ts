/** Host-owned document reads and compare-and-publish closures for an Include tree. */
import type { Context } from '@deepseek-ai/cordis'

/** Detached document contents, with absence explicitly admitted by the source. */
export type EntryDocumentContent = Readonly<{ state: 'present'; text: string }> | Readonly<{ state: 'absent' }>

/** A read retains its provider's expected revision in the publication closure. */
export type EntryDocumentHandle = EntryDocumentContent & (
  Readonly<{ writeback: 'discard' | 'readonly' }>
  | Readonly<{
    writeback: 'persist'
    /**
     * Publish against this read's exact expected revision; never overwrite the original source.
     * @param text Complete serialized entry document.
     * @returns The admitted successor after publication; stale reads and uncertain outcomes reject.
     */
    publish(text: string): Promise<EntryDocumentHandle>
  }>
)

/** The launcher binds the same document authority used by its other configuration consumers. */
export interface EntryDocumentSource {
  /**
   * Read an admitted logical filename; failure must never fall back to filesystem reads.
   * @param logicalPath Absolute logical filename, also retained as the Loader's resolution base.
   * @returns Detached contents and the provider-owned write disposition.
   */
  read(logicalPath: string): Promise<EntryDocumentHandle>
}

const sources = new WeakMap<Context, EntryDocumentSource>()

/**
 * Bind a document authority before mounting any Include in this root.
 * @param ctx Launcher context owning the binding's lifetime.
 * @param source Native document adapter; this function grants no storage authority.
 * @returns A disposer retiring this binding; a retired root cannot fall back to original files.
 */
export function bindIncludeDocumentSource(ctx: Context, source: EntryDocumentSource): () => void {
  if (sources.has(ctx.root)) throw new Error('An Include document source is already bound')
  return ctx.effect(() => {
    sources.set(ctx.root, source)
    return () => { sources.set(ctx.root, { async read() { throw new Error('The Include document source is disposed') } }) }
  })
}

/**
 * Read the launcher's binding without discovering or opening any filesystem path.
 * @param ctx Context of an Include being constructed.
 * @returns The bound authority, or undefined for ordinary file-backed Includes.
 */
export function getIncludeDocumentSource(ctx: Context): EntryDocumentSource | undefined {
  return sources.get(ctx.root)
}
