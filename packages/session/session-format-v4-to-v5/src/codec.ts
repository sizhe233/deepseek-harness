/** V5 physical framing retains V4 rows and adds fail-closed opaque checkpoint admission. */

import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { mapCompactionContent } from './content.ts'
import { assertReleasedV5Header, v4PhysicalHeader } from './validation.ts'

/** Current V5 codec; malformed native checkpoints cannot be hidden by tail recovery. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    return { ...releasedV4SessionFormatCodec.decodeHeader(v4PhysicalHeader(value)), version: 5 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(v4PhysicalHeader(value), recovery)
    return {
      ...decoder,
      admitRow: assertV5RowAdmission,
      header: { ...decoder.header, version: 5 },
      decodeRow(row, context) {
        assertV5RowAdmission(row)
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV5Header(header)
    return { ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount), version: 5 }
  },
  encodeEvent(event) {
    mapCompactionContent(event, false)
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Refuse V5 checkpoint and retained V4 structural violations before tail suppression.
 * @param row - untrusted physical row or logical event.
 * @param knownEventTypes - installed event vocabulary when available for ignorable developer payloads.
 */
export function assertV5RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  assertV4RowAdmission(row, knownEventTypes)
  if (isSessionFormatJsonObject(row) && !(row['type'] === 'developer/message'
    && row['ignorable'] === true && knownEventTypes?.has('developer/message') !== true)) {
    mapCompactionContent(row as SessionFormatEvent, false)
  }
}
