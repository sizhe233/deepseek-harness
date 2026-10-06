/** Streaming V4-to-V5 promotion with unchanged event coordinates and inherited cuts. */

import { defineSessionFormatMigration, isSessionFormatJsonObject, SessionFormatError, SessionFormatUnsupportedMigrationError, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun, SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, validateDeliveryAccepted } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { mapCompactionContent } from './content.ts'
import { assertReleasedV5Header } from './validation.ts'

/** Adjacent promotion preserving body structure and recognizing historical opaque checkpoints. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  validateTargetHeader: assertReleasedV5Header,
  createStage: input => new CheckpointStage(input),
})

class CheckpointStage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private cut: number | undefined
  private nextSeq = 0
  private foreignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV4Header(input.sourceHeader)
    this.cut = input.sourceHeader.isSeeded ? undefined : 0
    if (input.sourceInheritedEventCount !== undefined) this.headerInheritedEventCount = input.sourceInheritedEventCount
    else if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.nextSeq++) throw new SessionFormatError('format v4 source events must be dense')
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) throw new SessionFormatError('unseeded format v4 Session contains an inherited end-seed marker')
      this.cut = event.seq
    }
    const deliveryId = validateDeliveryAccepted(event, 4)
    if (event.type === 'session-log-deepseek/delivery-accepted' && isSessionFormatJsonObject(event.data)
      && event.data['sessionFormatVersion'] === 5) {
      throw new SessionFormatUnsupportedMigrationError('format v4 delivery marker claims target format v5')
    }
    if (deliveryId !== undefined && deliveryId !== this.input.sourceHeader.id) this.foreignDeliverySeq = event.seq
    context.emitEvent(mapCompactionContent(event, true))
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.cut, 'format v4 inherited event count')
    if (this.input.sourceInheritedEventCount !== undefined && cut !== this.input.sourceInheritedEventCount) {
      throw new SessionFormatError('format v4 inherited cut disagrees with its source marker')
    }
    if (this.foreignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.foreignDeliverySeq >= cut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return cut
  }
}
