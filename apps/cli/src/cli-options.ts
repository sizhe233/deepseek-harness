/** Installation-owned CLI options shared by the carrier and its business entry. */

import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}
