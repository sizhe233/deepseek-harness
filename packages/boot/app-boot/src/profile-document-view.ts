/** Application-free snapshots of provider-admitted Profile documents; no discovery or filesystem I/O. */
import { isAbsolute, normalize } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Provider-issued identity of one complete configuration and package-document view. */
export type ProfileDocumentViewReference = Branded<'ProfileDocumentViewReference'>

/** Provider-issued identity of an immutable document version or recorded absence. */
export type ProfileDocumentReference = Branded<'ProfileDocumentReference'>

/** Admitted process code identity; configuration publication cannot change it. */
export type ProfileCodeBindingReference = Branded<'ProfileCodeBindingReference'>

/** Package-document set admitted with one process code binding, excluding pending package edits. */
export type ProfilePackageDocumentsReference = Branded<'ProfilePackageDocumentsReference'>

/** Logical locations and immutable package selection owned by the requesting launcher. */
export interface ProfileDocumentSelection {
  readonly profileDir: string
  readonly home: string
  readonly codeBinding: ProfileCodeBindingReference
  readonly packageDocuments: ProfilePackageDocumentsReference
}

/** Detached text or an explicit absence; unlisted paths are never treated as absent. */
export type ProfileDocumentSnapshot = Readonly<{
  logicalPath: string
  reference: ProfileDocumentReference
}> & (Readonly<{ state: 'present'; text: string }> | Readonly<{ state: 'absent' }>)

/** One complete provider read, acquired before synchronous configuration parsing. */
export interface ProfileDocumentViewInput {
  readonly reference: ProfileDocumentViewReference
  readonly selection: ProfileDocumentSelection
  readonly documents: readonly ProfileDocumentSnapshot[]
}

/** Immutable desired configuration; this does not assert a running Loader has applied it. */
export interface ProfileDocumentView {
  readonly reference: ProfileDocumentViewReference
  readonly selection: ProfileDocumentSelection
  /**
   * Read an admitted logical filename without reopening its source.
   * @param logicalPath Canonical absolute filename in this view's admitted read set.
   * @returns The immutable snapshot, including an explicit absence when admitted.
   * @throws When the filename is not in the read set.
   */
  read(logicalPath: string): ProfileDocumentSnapshot
}

/**
 * Native owner capability supplied by an admitted launcher. The provider retains its own authority,
 * serialization, source observations and finalized publication checks; these types confer none.
 */
export interface ProfileDocumentReadCapability {
  /**
   * Acquire a coherent configuration vector for the exact code/package selection.
   * @param selection Already admitted process selection; pending package documents are excluded.
   * @returns Detached document text and recorded absences from one finalized view.
   * @throws For unsupported, corrupt, unavailable or unfinalized managed state; never use legacy fallback.
   */
  readCurrent(selection: ProfileDocumentSelection): Promise<ProfileDocumentViewInput>
}

/**
 * Copy an admitted read into a synchronous immutable view. This does not admit sources or prove durability.
 * @param input Provider-owned finalized read; all paths are canonical absolute logical filenames.
 * @returns Detached snapshots; changes to the provider's arrays or records cannot alter this view.
 * @throws For duplicate or noncanonical paths.
 */
export function createProfileDocumentView(input: ProfileDocumentViewInput): ProfileDocumentView {
  const documents = new Map<string, ProfileDocumentSnapshot>()
  for (const document of input.documents) {
    const path = document.logicalPath
    if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`Profile document path is not canonical: ${path}`)
    if (documents.has(path)) throw new Error(`Duplicate Profile document: ${path}`)
    documents.set(path, Object.freeze({ ...document }))
  }
  return Object.freeze({
    reference: input.reference,
    selection: Object.freeze({ ...input.selection }),
    read(logicalPath: string): ProfileDocumentSnapshot {
      const document = documents.get(logicalPath)
      if (document === undefined) throw new Error(`Profile document is outside the admitted view: ${logicalPath}`)
      return document
    },
  })
}

/**
 * Check that configuration and bundle readers use the same logical Profile and admitted code/package set.
 * @param view Immutable view to consume.
 * @param selection Launcher's independently admitted selection.
 * @throws When any selection field differs; no path or package lookup is attempted.
 */
export function assertProfileDocumentSelection(view: ProfileDocumentView, selection: ProfileDocumentSelection): void {
  const actual = view.selection
  if (actual.profileDir !== selection.profileDir || actual.home !== selection.home
    || actual.codeBinding !== selection.codeBinding || actual.packageDocuments !== selection.packageDocuments) {
    throw new Error('Profile document view does not match the admitted process selection')
  }
}

/**
 * Require a native reader and detach its result for synchronous consumers. No provider is installed here.
 * @param capability Launcher-supplied native authority, unavailable until the launcher supports managed documents.
 * @param selection Exact selection already admitted by the launcher.
 * @returns An immutable desired view matching that selection, not a Loader application receipt.
 * @throws When the capability is missing, its read fails, or it returns another selection.
 */
export async function acquireProfileDocumentView(
  capability: ProfileDocumentReadCapability | undefined, selection: ProfileDocumentSelection,
): Promise<ProfileDocumentView> {
  if (capability === undefined) throw new Error('Managed Profile documents require an admitted native read capability')
  const requested = Object.freeze({ ...selection })
  const view = createProfileDocumentView(await capability.readCurrent(requested))
  assertProfileDocumentSelection(view, requested)
  return view
}
