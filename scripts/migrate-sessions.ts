/** Contributor command to publish current-writer successors beside unchanged historical Sessions. */

import { realpathSync } from 'node:fs'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { runSessionMigrationCommand } from './session-migration-command.ts'

export { runMigrationJobs } from './session-migration-command.ts'

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = await runSessionMigrationCommand(SESSION_FORMAT_VERSION, 'migrate:sessions')
}
