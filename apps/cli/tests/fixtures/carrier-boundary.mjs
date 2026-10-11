/** Observe the real emitted import graph, substituting only the fixed business entry. */

import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const entry = process.env.DSH_TEST_CARRIER_ENTRY
const business = process.env.DSH_TEST_CARRIER_BUSINESS
const negative = process.env.DSH_TEST_CARRIER_NEGATIVE
const loaded = []
let reachedBusiness = false
const allowedPackages = new Set(['commander', 'semver', '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-app-boot/runtime-version', '@deepseek-ai/dsh/lib/carrier.js'])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!reachedBusiness && !specifier.startsWith('node:') && !specifier.startsWith('.')
      && !specifier.startsWith('file:') && !specifier.startsWith('/') && !allowedPackages.has(specifier)) {
      throw new Error(`APPLICATION_BEFORE_BUSINESS: ${specifier}`)
    }
    if (!reachedBusiness && specifier === '@deepseek-ai/dsh-app-boot') {
      throw new Error(`APPLICATION_BEFORE_BUSINESS: ${specifier}`)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === business) {
      reachedBusiness = true
      const output = JSON.stringify({ loaded, boundary: url, pid: process.pid })
      return { format: 'module', shortCircuit: true, source: `
        const observed = ${output};
        const report = (...args) => process.stdout.write(JSON.stringify({ ...observed, args, argv: process.argv, cwd: process.cwd() }) + '\\n');
        export const runCli = report;
        export const runDesktopCli = report;
        export const runDesktopHost = report;
      ` }
    }
    if (!reachedBusiness) loaded.push(url)
    const result = nextLoad(url, context)
    const negativeTarget = negative === 'entry' ? url === entry
      : negative === 'transitive' && url.endsWith('/runtime-version.js')
    if (!reachedBusiness && negativeTarget && result.format === 'module') {
      return { ...result, source: `import '@deepseek-ai/cordis';\n${String(result.source).replace(/^#![^\n]*\n/u, '')}` }
    }
    if (!reachedBusiness && url.startsWith('file:')) {
      const filename = fileURLToPath(url).replaceAll('\\', '/')
      if (/\/(?:app-boot\/lib\/index|profile-boot|office|office-engine|startup-diagnostics)\.js$/u.test(filename)) {
        throw new Error(`APPLICATION_BEFORE_BUSINESS: ${url}`)
      }
    }
    return result
  },
})
