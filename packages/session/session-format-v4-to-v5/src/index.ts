/** Opaque checkpoint support for Session V5 and its adjacent V4 migration. */

export { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
export { assertV5RowAdmission, releasedV5SessionFormatCodec } from './codec.ts'
export { sessionFormatV4ToV5 } from './migration.ts'
export { assertReleasedV5Header, restoreReleasedV5Artifact } from './validation.ts'
