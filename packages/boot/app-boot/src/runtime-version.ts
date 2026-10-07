/** Application-free runtime version reads for installed carriers and plugin compatibility. */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/**
 * Validate a runtime version without changing its spelling.
 * @param value - Version read from a manifest or compatibility request.
 * @returns the exact semantic version.
 */
export function runtimeVersionOf(value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`)
  }
  return value
}

/**
 * Read this app-boot package's version in source and bundled installations.
 * @returns the validated runtime semantic version, preserving its exact spelling.
 * @throws if package.json cannot be read or its version is missing or invalid.
 */
export function getDshRuntimeVersion(): string {
  // The executable's virtual filesystem intercepts string paths, not URL arguments.
  const filename = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('app-boot package.json must be an object')
  }
  return runtimeVersionOf(Object.hasOwn(manifest, 'version') && 'version' in manifest ? manifest.version : undefined)
}
