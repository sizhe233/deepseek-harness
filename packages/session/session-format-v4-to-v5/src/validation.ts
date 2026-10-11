/** V5 headers and opaque checkpoint validation over the unchanged V4 body rules. */

import { isSessionFormatJsonObject, SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, validateV4ArtifactBody } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { mapCompactionContent } from './content.ts'

/**
 * Validate the V5 header while retaining every V4 metadata constraint.
 * @param header - untrusted logical header candidate.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

/**
 * Validate a complete V5 artifact without changing its opaque values or coordinates.
 * @param artifact - detached V5 artifact.
 * @param knownEventTypes - event types understood by the installed reader.
 * @returns the same validated artifact.
 */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  validateV4ArtifactBody(artifact, knownEventTypes)
  for (const event of artifact.events) {
    if (knownEventTypes.has(event.type)) mapCompactionContent(event, false)
  }
  return artifact
}

/**
 * Adapt a V5 physical header to the unchanged V4 framing implementation.
 * @param value - untrusted physical V5 header.
 * @returns a detached header understood by the V4 codec.
 */
export function v4PhysicalHeader(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) throw new SessionFormatError('expected format v5 physical header')
  return { ...value, version: 4 } as SessionFormatHeader
}
