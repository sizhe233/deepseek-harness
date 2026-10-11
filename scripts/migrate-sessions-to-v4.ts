/** Historical contributor command: refuse unless this checkout still writes Session V4. */

import { realpathSync } from 'node:fs'
import { runSessionMigrationCommand } from './session-migration-command.ts'

export { runMigrationJobs } from './session-migration-command.ts'

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = await runSessionMigrationCommand(4, 'migrate:sessions-to-v4', true)
}
