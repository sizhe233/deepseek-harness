/** Strict YAML syntax and sequence validation for managed patch edits. */
import { isSeq, parseDocument, type YAMLSeq } from 'yaml'

/**
 * Parse one raw profile patch while retaining comments, anchors and expression tags.
 * @param source Untrusted YAML document text from a retained native version.
 * @returns A sequence document; malformed YAML or a different root kind rejects.
 */
export function parseManagedPatch(source: string): ReturnType<typeof parseDocument> & { contents: YAMLSeq } {
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  document.contents.flow = false
  return document as typeof document & { contents: typeof document.contents }
}
